// middleware/auth.js
'use strict';

const jwt  = require('jsonwebtoken');
const User = require('../models/User');

// ── In-memory user cache (avoids DB lookup on every request) ──────────────────
// Keyed by user ID, evicted after 5 minutes
const userCache  = new Map();
const CACHE_TTL  = 5 * 60 * 1000; // 5 minutes

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
const protect = async (req, res, next) => {
  // ── Dev mock token (must be checked FIRST, before !token guard) ────────────
  if (process.env.NODE_ENV === 'development') {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer mock_')) {
      req.user = { _id: 'dev_user_001', id: 'dev_user_001', name: 'Dev User', email: 'dev@nviq.com', role: 'admin' };
      return next();
    }
  }

  // ── Extract token ──────────────────────────────────────────────────────────
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Not authorized — no token' });
  }

  const token = header.slice(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Try cache first — avoids DB hit on every API call
    let user = getCachedUser(decoded.id);
    if (!user) {
      user = await User.findById(decoded.id).select('-password -resetPasswordToken -resetPasswordExpire').lean();
      if (!user) {
        return res.status(401).json({ success: false, message: 'User not found' });
      }
      user.id = user._id.toString();
      setCachedUser(decoded.id, user);
    }

    req.user = user;
    next();
  } catch (error) {
    const msg = error.name === 'TokenExpiredError'
      ? 'Token expired — please log in again'
      : 'Invalid token';
    return res.status(401).json({ success: false, message: msg });
  }
};

// ── role-based guard ──────────────────────────────────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: `Access denied — requires role: ${roles.join(' or ')}` });
  }
  next();
};

module.exports = { protect, requireRole };