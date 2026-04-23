'use strict';

const express = require('express');
const router  = express.Router();
const User    = require('../models/User');
const { protect } = require('../middleware/auth');

// ── Shared user payload formatter ─────────────────────────────────────────────
function _userPayload(user) {
  return {
    id:        user.id || user._id?.toString(),
    name:      user.name,
    email:     user.email,
    phone:     user.phone,
    role:      user.role,
    status:    user.status,
    plan:      user.plan,
    avatar:    user.avatar,
    lastLogin: user.lastLogin,
  };
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    
    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: `Account is ${user.status}` });
    }

    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });

    res.json({ 
      success: true, 
      token: user.getSignedJwtToken(), 
      data: _userPayload(user) 
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/auth/phone-login ────────────────────────────────────────────────
router.post('/phone-login', async (req, res) => {
  try {
    const { phone, name, firebaseUid } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone is required' });

    const digits = phone.replace(/\D/g, '');

    let user = await User.findOne({
      $or: [{ phone }, { phone: digits }, { email: `${digits}@nviq.app` }],
    });

    if (!user) {
      user = await User.create({
        name:     name || `Fleet-Manager-${digits.slice(-4)}`,
        email:    `${digits}@nviq.app`,
        password: firebaseUid || `nviq_${digits}`, // Fallback password
        phone:    digits,
        role:     'fleet_manager',
        status:   'active'
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is deactivated' });
    }

    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });

    res.json({ 
      success: true, 
      token: user.getSignedJwtToken(), 
      data: _userPayload(user) 
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', protect, async (req, res) => {
  // User is already attached to req by the 'protect' middleware cache
  res.json({ success: true, data: _userPayload(req.user) });
});

module.exports = router;