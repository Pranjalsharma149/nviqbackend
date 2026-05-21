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

// ── Shared referral code generator ────────────────────────────────────────────
async function _ensureReferralCode(user) {
  if (!user.referralCode) {
    const { customAlphabet } = require('nanoid');
    const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 6);
    user.referralCode = 'NVIQ-' + nanoid();
    await user.save();
  }
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// Email/Password login (alternative method)
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
      token:   user.getSignedJwtToken(),
      data:    _userPayload(user),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/auth/phone-login ────────────────────────────────────────────────
// Primary method: Firebase Phone OTP verification
// Called by login_screen.dart after Firebase verifies the OTP
router.post('/phone-login', async (req, res) => {
  try {
    const { phone, name, firebaseUid } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone is required' });

    const digits = phone.replace(/\D/g, '');

    let user = await User.findOne({
      $or: [{ phone }, { phone: digits }, { email: `${digits}@nviq.app` }],
    });

    // Auto-create user on first phone login
    if (!user) {
      user = await User.create({
        name:     name || `Fleet-Manager-${digits.slice(-4)}`,
        email:    `${digits}@nviq.app`,
        password: firebaseUid || `nviq_${digits}`,
        phone:    digits,
        role:     'fleet_manager',
        status:   'active',
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is deactivated' });
    }

    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });
    await _ensureReferralCode(user);

    res.json({
      success: true,
      token:   user.getSignedJwtToken(),
      data:    _userPayload(user),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────
// Alternative method (legacy support)
// Called by mobile app after Firebase Phone Auth verifies the OTP
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, firebaseUid, name } = req.body;

    if (!phone || !firebaseUid) {
      return res.status(400).json({
        success: false,
        message: 'Phone and firebaseUid are required',
      });
    }

    const digits = phone.replace(/\D/g, '');

    let user = await User.findOne({
      $or: [{ phone }, { phone: digits }, { email: `${digits}@nviq.app` }],
    });

    if (!user) {
      const { customAlphabet } = require('nanoid');
      const nanoid = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 6);

      user = await User.create({
        name:         name || `Fleet-Manager-${digits.slice(-4)}`,
        email:        `${digits}@nviq.app`,
        password:     firebaseUid,
        phone:        digits,
        role:         'fleet_manager',
        status:       'active',
        referralCode: 'NVIQ-' + nanoid(),
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is deactivated' });
    }

    await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });
    await _ensureReferralCode(user);

    res.json({
      success: true,
      token:   user.getSignedJwtToken(),
      data:    _userPayload(user),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Get authenticated user's profile
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('name firstName lastName email phone role status plan avatar location company onboardingStep onboardingComplete lastLogin')
      .lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, data: { ..._userPayload(user), firstName: user.firstName, lastName: user.lastName, company: user.company, location: user.location, onboardingStep: user.onboardingStep, onboardingComplete: user.onboardingComplete } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/auth/me ──────────────────────────────────────────────────────────
// Update authenticated user's profile
router.put('/me', protect, async (req, res) => {
  try {
    const { clearUserCache } = require('../middleware/auth');
    const update = {};
    const textFields = ['name', 'phone', 'location', 'avatar', 'fcmToken'];
    for (const field of textFields) {
      if (req.body[field] !== undefined) {
        update[field] = String(req.body[field]).trim();
      }
    }
    if (req.body.email !== undefined) {
      const email = String(req.body.email).toLowerCase().trim();
      const taken = await User.findOne({ email, _id: { $ne: req.user._id } }).lean();
      if (taken) return res.status(400).json({ success: false, message: 'Email already in use by another account' });
      update.email = email;
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }
    clearUserCache(req.user._id.toString());
    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true })
      .select('name firstName lastName email phone role status plan avatar location company onboardingStep onboardingComplete lastLogin')
      .lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, data: { ..._userPayload(user), firstName: user.firstName, lastName: user.lastName, company: user.company, location: user.location, onboardingStep: user.onboardingStep, onboardingComplete: user.onboardingComplete } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/auth/validate ────────────────────────────────────────────────────
// ✅ NEW ROUTE - Called by login_screen.dart on app startup
// Validates if stored JWT token is still valid
// Returns 200 if valid, 401 if invalid/expired
router.get('/validate', protect, async (req, res) => {
  try {
    res.json({
      success: true,
      valid: true,
      data: _userPayload(req.user),
    });
  } catch (e) {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
});

module.exports = router;