'use strict';

const jwt  = require('jsonwebtoken');
const User = require('../models/User');

// ── In-memory user cache ──────────────────────────────────────────────────────
// Prevents DB bottleneck at 20k device scale
const userCache  = new Map();
const CACHE_TTL  = 5 * 60 * 1000; 

function getCachedUser(id) {
  const entry = userCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { 
    userCache.delete(id); 
    return null; 
  }
  return entry.user;
}

function setCachedUser(id, user) {
  userCache.set(id, { user, ts: Date.now() });
}

// ── protect middleware ────────────────────────────────────────────────────────
// Validates the JWT and attaches the user object to the request
exports.protect = async (req, res, next) => {
  const header = req.headers.authorization || '';

  // 1. Dev mock token (helpful for testing without logging in repeatedly)
  if (process.env.NODE_ENV === 'development' && header.startsWith('Bearer mock_')) {
      req.user = { 
        _id: 'dev_user_001', 
        id: 'dev_user_001', 
        name: 'Dev User', 
        role: 'admin' 
      };
      return next();
  }

  // 2. Extract and Verify JWT
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Not authorized — no token' });
  }

  const token = header.slice(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 3. Try Cache first
    let user = getCachedUser(decoded.id);
    
    // 4. Fallback to DB if cache miss
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

    // 5. Security Check: Ensure user hasn't been deactivated
    if (user.status === 'inactive') {
        return res.status(403).json({ success: false, message: 'Account is deactivated' });
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

// ── requireRole middleware ───────────────────────────────────────────────────
// Restricts access based on user role (e.g., 'admin', 'operator')
exports.requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ 
      success: false, 
      message: `Access denied — requires role: ${roles.join(' or ')}` 
    });
  }
  next();
};