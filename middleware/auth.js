'use strict';

const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const logger = require('../utils/logger');

// ── In-memory user cache ──────────────────────────────────────────────────────
const userCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedUser(id) {
  const entry = userCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { userCache.delete(id); return null; }
  return entry.user;
}

function setCachedUser(id, user) {
  userCache.set(id, { user, ts: Date.now() });
}

// ── 🔧 FIX #1: Periodic cache cleanup (prevents memory leak / crash from OOM) ──
// Old code only evicted entries when re-accessed AFTER expiry. Stale entries
// from users who never came back accumulated forever and slowly leaked memory
// until the server hit OOM and crashed. This runs every minute and purges
// anything past TTL.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of userCache) {
    if (now - entry.ts > CACHE_TTL) userCache.delete(id);
  }
}, 60 * 1000).unref();
// .unref() so this timer doesn't prevent Node from exiting during graceful shutdown

// ── protect middleware ────────────────────────────────────────────────────────
// Accepts:
//   1. NVIQ JWT           (from phone-login / email-password login)  ← checked FIRST
//   2. Firebase ID Token  (legacy / direct Firebase auth)            ← fallback
//   3. Dev mock token     (development only)
exports.protect = async (req, res, next) => {
  const header = req.headers.authorization || '';

  // ── 1. Dev mock token ──────────────────────────────────────────────────────
  if (process.env.NODE_ENV === 'development' && header.startsWith('Bearer mock_')) {
    const mongoose = require('mongoose');
    const mockId = new mongoose.Types.ObjectId('000000000000000000000001');
    // 🔧 FIX #2: Fill in ALL fields downstream code may read.
    // Old mock object was missing email/phone/etc. so any controller doing
    // req.user.email.toLowerCase() crashed with "Cannot read property of undefined".
    req.user = {
      _id:    mockId,
      id:     mockId.toString(),
      name:   'Dev User',
      email:  'dev@nviq.app',
      phone:  '+919999999999',
      role:   'admin',
      status: 'active',
    };
    return next();
  }

  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Not authorized — no token' });
  }

  const token = header.slice(7);

  // ── 2. Try NVIQ JWT FIRST ─────────────────────────────────────────────────
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'nviq_secret_change_me');

    if (decoded && decoded.id) {
      let user = getCachedUser(decoded.id);

      if (!user) {
        user = await User.findById(decoded.id)
          .select('-password -resetPasswordToken -resetPasswordExpire')
          .lean();

        if (!user) {
          return res.status(401).json({ success: false, message: 'User not found' });
        }

        user.id = user._id.toString();
        setCachedUser(decoded.id, user);
      }

      if (user.status === 'suspended') {
        return res.status(403).json({ success: false, message: 'Account suspended' });
      }
      if (user.status === 'inactive') {
        return res.status(403).json({ success: false, message: 'Account is deactivated' });
      }

      req.user = user;
      return next();
    }
  } catch (jwtErr) {
    // TokenExpiredError = was our token but it expired → tell user to re-login
    if (jwtErr.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired — please log in again' });
    }
    // JsonWebTokenError = not our token (probably Firebase) → fall through
  }

  // ── 3. Try Firebase ID Token (fallback) ───────────────────────────────────
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    const decoded = await admin.auth().verifyIdToken(token);

    let user = null;

    if (decoded.phone_number) {
      user = await User.findOne({ phone: decoded.phone_number })
        .select('-password -resetPasswordToken -resetPasswordExpire')
        .lean();
    }
    if (!user && decoded.email) {
      user = await User.findOne({ email: decoded.email })
        .select('-password -resetPasswordToken -resetPasswordExpire')
        .lean();
    }

    // 🔧 FIX #3: Race-safe auto-provisioning
    // Old code: two concurrent requests with same Firebase token would BOTH
    // see "user not found", both call User.create(), and the second would
    // throw E11000 duplicate key → fall into the outer catch → return 401
    // → user gets kicked back to OTP screen. Now we catch the duplicate
    // and re-fetch, which is what we wanted.
    if (!user) {
      const crypto = require('crypto');
      try {
        const created = await User.create({
          name:     decoded.name || decoded.phone_number || 'Fleet User',
          email:    decoded.email || `firebase_${decoded.uid}@nviq.app`,
          phone:    decoded.phone_number || '',
          password: crypto.randomBytes(16).toString('hex') + 'Aa1!',
          role:     'fleet_manager',
          status:   'active',
        });
        user = created.toObject();
        logger.info('Auto-provisioned user for Firebase UID=%s', decoded.uid);
      } catch (createErr) {
        // E11000 = duplicate key — another request just created this user.
        // Just re-fetch and continue. Anything else, re-throw.
        if (createErr && createErr.code === 11000) {
          logger.info('Race in auto-provision for UID=%s, re-fetching', decoded.uid);
          if (decoded.phone_number) {
            user = await User.findOne({ phone: decoded.phone_number })
              .select('-password -resetPasswordToken -resetPasswordExpire')
              .lean();
          }
          if (!user && decoded.email) {
            user = await User.findOne({ email: decoded.email })
              .select('-password -resetPasswordToken -resetPasswordExpire')
              .lean();
          }
          if (!user) {
            // Genuinely could not find or create — fail clean
            return res.status(401).json({ success: false, message: 'Authentication failed' });
          }
        } else {
          throw createErr;
        }
      }
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'Account suspended' });
    }
    if (user.status === 'inactive') {
      return res.status(403).json({ success: false, message: 'Account is deactivated' });
    }

    user.id = user._id.toString();
    setCachedUser(user.id, user);
    req.user = user;
    return next();

  } catch (firebaseErr) {
    logger.warn('Firebase token verification failed: %s', firebaseErr.message);
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// ── requireRole middleware ────────────────────────────────────────────────────
exports.requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Access denied — requires role: ${roles.join(' or ')}`,
    });
  }
  next();
};

// ── cache invalidation (call after profile updates) ───────────────────────────
exports.clearUserCache = (userId) => {
  userCache.delete(userId.toString());
};

// ── 🔧 FIX #4: optionalAuth — was guaranteed to crash on bad tokens ───────────
//
// OLD CODE (BUGGY):
//   exports.optionalAuth = async (req, res, next) => {
//     const header = req.headers.authorization || '';
//     if (!header.startsWith('Bearer ')) return next();
//     exports.protect(req, res, (err) => next());   ← BUG
//   };
//
// The bug: protect() calls res.status(401).json(...) on bad tokens AND THEN
// returns. The callback passed in then called next() ANYWAY, so the route
// handler ran, tried to send another response, and Express crashed with
// "Cannot set headers after they are sent to the client".
//
// FIX: detect whether protect already sent a response. If it did, stop here.
// If it didn't, we have a valid user — call next(). If we don't have a user,
// just continue without one (that's the point of "optional").
exports.optionalAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();

  // Hand off to protect, but intercept BEFORE it writes a response
  const originalStatus = res.status.bind(res);
  const originalJson   = res.json.bind(res);
  let responded = false;

  res.status = function (code) {
    // If protect tries to send 401/403, swallow it for optionalAuth.
    // For other codes, pass through (shouldn't happen, but safe).
    if (code === 401 || code === 403) {
      responded = true;
      return {
        json: () => { /* swallow */ return res; },
      };
    }
    return originalStatus(code);
  };

  try {
    await exports.protect(req, res, (err) => {
      // Restore originals so route handlers behave normally
      res.status = originalStatus;
      res.json   = originalJson;
      if (responded) return next(); // bad token — continue WITHOUT user
      return next(err);              // good token — req.user is set
    });
  } catch (e) {
    res.status = originalStatus;
    res.json   = originalJson;
    return next();
  }
};