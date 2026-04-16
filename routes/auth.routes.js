// routes/auth.routes.js
'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const { protect } = require('../middleware/auth');

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'name, email and password are required' });
    }

    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ success: false, message: 'Email already registered' });

    const user  = await User.create({ name, email, password, phone, role: 'fleet_manager', plan: 'Free Plan' });
    const token = user.getSignedJwtToken();

    res.status(201).json({
      success: true, token,
      data: _userPayload(user),
    });
  } catch (e) {
    if (e.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: Object.values(e.errors).map(x => x.message).join(', ') });
    }
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/auth/login (email + password) ───────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'email and password required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Update lastLogin without triggering password re-hash
    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });

    res.json({ success: true, token: user.getSignedJwtToken(), data: _userPayload(user) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/auth/phone-login ────────────────────────────────────────────────
// Called by Flutter FirebaseService after Phone OTP verified
// Auto-creates user on first login — no manual registration needed
router.post('/phone-login', async (req, res) => {
  try {
    const { phone, name, firebaseUid } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'phone is required' });

    const digits = phone.replace(/\D/g, '');

    // Find by phone OR auto-generated email
    let user = await User.findOne({
      $or: [{ phone }, { phone: digits }, { email: `${digits}@nviq.app` }],
    });

    if (!user) {
      // First login — create account automatically
      user = await User.create({
        name:     name || `User-${digits.slice(-4)}`,
        email:    `${digits}@nviq.app`,
        password: firebaseUid || `nviq_${digits}`,
        phone,
        role:     'fleet_manager',
        plan:     'Free Plan',
      });
      console.log(`✅ New user auto-created for phone: ${phone}`);
    }

    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });

    res.json({ success: true, token: user.getSignedJwtToken(), data: _userPayload(user) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id || req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, data: _userPayload(user) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/auth/me ──────────────────────────────────────────────────────────
router.put('/me', protect, async (req, res) => {
  try {
    const allowed = ['name', 'email', 'phone', 'location', 'plan', 'avatar', 'fcmToken'];
    const updates = {};
    for (const f of allowed) { if (req.body[f] !== undefined) updates[f] = req.body[f]; }

    const user = await User.findByIdAndUpdate(
      req.user._id || req.user.id,
      { $set: updates },
      { new: true, runValidators: true, select: '-password' }
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.json({ success: true, message: 'Profile updated', data: _userPayload(user) });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Email already in use' });
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', protect, (_req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
});

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.json({ success: true, message: 'If an account exists, reset instructions have been sent' });

    const token = jwt.sign({ id: user._id, type: 'pwd_reset' }, process.env.JWT_SECRET, { expiresIn: '60m' });
    user.resetPasswordToken  = token;
    user.resetPasswordExpire = Date.now() + 60 * 60 * 1000;
    await user.save({ validateBeforeSave: false });

    // Dev only — in production send via SMS/email
    if (process.env.NODE_ENV !== 'production') {
      console.log(`🔑 Reset token for ${email}: ${token}`);
    }

    res.json({ success: true, message: 'If an account exists, reset instructions have been sent' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/auth/reset-password/:token ──────────────────────────────────────
router.post('/reset-password/:token', async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    let decoded;
    try { decoded = jwt.verify(req.params.token, process.env.JWT_SECRET); }
    catch (_) { return res.status(400).json({ success: false, message: 'Invalid or expired token' }); }

    if (decoded.type !== 'pwd_reset') {
      return res.status(400).json({ success: false, message: 'Invalid token type' });
    }

    const user = await User.findOne({
      _id:                 decoded.id,
      resetPasswordToken:  req.params.token,
      resetPasswordExpire: { $gt: Date.now() },
    });
    if (!user) return res.status(400).json({ success: false, message: 'Invalid or expired token' });

    user.password            = newPassword;
    user.resetPasswordToken  = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    res.json({ success: true, message: 'Password reset successfully', token: user.getSignedJwtToken() });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Shared user payload formatter ─────────────────────────────────────────────
function _userPayload(user) {
  return {
    id:        user.id || user._id?.toString(),
    name:      user.name,
    email:     user.email,
    phone:     user.phone,
    role:      user.role,
    plan:      user.plan,
    location:  user.location,
    avatar:    user.avatar,
    lastLogin: user.lastLogin,
    createdAt: user.createdAt,
  };
}

module.exports = router;