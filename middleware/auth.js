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

// ── protect middleware ────────────────────────────────────────────────────────
// Accepts:
//   1. NVIQ JWT           (from phone-login / email-password login)  ← checked FIRST
//   2. Firebase ID Token  (legacy / direct Firebase auth)            ← fallback
//   3. Dev mock token     (development only)
exports.protect = async (req, res, next) => {
  const header = req.headers.authorization || '';

  // ── 1. Dev mock token ──────────────────────────────────────────────────────
  // FIX: use a real ObjectId so MongoDB queries (e.g. referral lookup) don't fail
  if (process.env.NODE_ENV === 'development' && header.startsWith('Bearer mock_')) {
    const mongoose = require('mongoose');
    const mockId = new mongoose.Types.ObjectId('000000000000000000000001');
    req.user = {
      _id:    mockId,
      id:     mockId.toString(),
      name:   'Dev User',
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
  // Our own tokens are always verified first. Firebase tokens are the fallback.
  // This avoids Firebase rejecting our JWT with auth/argument-error and
  // blocking the request before we ever get to verify it ourselves.
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'nviq_secret_change_me');

    // decoded.id is set by getSignedJwtToken() in User model
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

    // Auto-provision user on first Firebase login
    if (!user) {
      const crypto = require('crypto');
      user = await User.create({
        name:     decoded.name || decoded.phone_number || 'Fleet User',
        email:    decoded.email || `firebase_${decoded.uid}@nviq.app`,
        phone:    decoded.phone_number || '',
        password: crypto.randomBytes(16).toString('hex') + 'Aa1!',
        role:     'fleet_manager',
        status:   'active',
      });
      user = user.toObject();
      logger.info('Auto-provisioned user for Firebase UID=%s', decoded.uid);
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

// ── optional auth (attaches user if token present, never blocks) ──────────────
exports.optionalAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  exports.protect(req, res, (err) => next());
};