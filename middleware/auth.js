'use strict';

const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const logger = require('../utils/logger');

// ── In-memory user cache ──────────────────────────────────────────────────────
// Prevents DB bottleneck at high concurrency
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
//   1. Firebase ID Token  (from Flutter OTP login)
//   2. NVIQ JWT           (from email/password login)
//   3. Dev mock token     (development only)
exports.protect = async (req, res, next) => {
  const header = req.headers.authorization || '';

  // ── 1. Dev mock token ──────────────────────────────────────────────────────
  if (process.env.NODE_ENV === 'development' && header.startsWith('Bearer mock_')) {
    req.user = {
      _id:  'dev_user_001',
      id:   'dev_user_001',
      name: 'Dev User',
      role: 'admin',
      status: 'active',
    };
    return next();
  }

  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Not authorized — no token' });
  }

  const token = header.slice(7);

  // ── 2. Try Firebase ID Token first ────────────────────────────────────────
  try {
    const admin = require('firebase-admin');
    if (admin.apps.length) {
      const decoded = await admin.auth().verifyIdToken(token);

      // Look up user by phone or email from Firebase
      const phoneOrEmail = decoded.phone_number || decoded.email;
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
    }
  } catch (firebaseErr) {
    // Not a Firebase token — fall through to JWT check
    if (firebaseErr.code && firebaseErr.code.startsWith('auth/')) {
      // It IS a Firebase token but it's invalid/expired
      return res.status(401).json({ success: false, message: 'Firebase token invalid or expired' });
    }
    // Otherwise it's just not a Firebase token — try JWT next
  }

  // ── 3. Try NVIQ JWT ────────────────────────────────────────────────────────
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'nviq_secret_change_me');

    // Try cache first
    let user = getCachedUser(decoded.id);

    // Fallback to DB
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

  } catch (jwtErr) {
    const msg = jwtErr.name === 'TokenExpiredError'
      ? 'Token expired — please log in again'
      : 'Invalid token';
    return res.status(401).json({ success: false, message: msg });
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
  // Reuse protect logic but swallow errors
  exports.protect(req, res, (err) => next());
};