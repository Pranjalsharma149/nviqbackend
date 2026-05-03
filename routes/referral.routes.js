'use strict';

/**
 * routes/referral.routes.js
 *
 * GET  /api/referral/my            – get (or create) the caller's referral code + stats
 * GET  /api/referral/validate/:code – check if a code is valid before signup
 * POST /api/referral/apply          – called after OTP login to credit a referrer
 */

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const User     = require('../models/User');
const Referral = require('../models/Referral');
const { protect } = require('../middleware/auth');

// ── helper: generate unique "NVIQ-XXXX" code ─────────────────────────────────
async function generateUniqueCode() {
  for (let i = 0; i < 20; i++) {
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
    const code = `NVIQ-${rand}`;
    const exists = await Referral.findOne({ code });
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique referral code');
}

// ── helper: get or create referral doc for a user ────────────────────────────
async function getOrCreate(userId) {
  let ref = await Referral.findOne({ referrer: userId });
  if (!ref) {
    const code = await generateUniqueCode();
    ref = await Referral.create({ referrer: userId, code });
  }
  return ref;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/referral/my
// Returns the authenticated user's referral code and stats.
// Creates one automatically if this is their first visit.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my', protect, async (req, res) => {
  try {
    // Support both mongoose doc (_id) and lean object (id)
    const userId = req.user._id ?? req.user.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'User ID missing from token' });
    }

    const ref = await getOrCreate(userId);

    return res.json({
      success:        true,
      code:           ref.code,
      totalReferrals: ref.totalReferrals,
      referredUsers:  ref.referredUsers,
    });
  } catch (err) {
    console.error('GET /referral/my error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/referral/validate/:code
// Public — no auth needed. Used by the login screen to verify a code before signup.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/validate/:code', async (req, res) => {
  try {
    const code = (req.params.code || '').toUpperCase().trim();
    if (!code) {
      return res.json({ success: false, valid: false, message: 'No code provided' });
    }

    const ref = await Referral.findOne({ code }).populate('referrer', 'name');
    if (!ref) {
      return res.json({ success: true, valid: false, message: 'Invalid referral code' });
    }

    return res.json({
      success:      true,
      valid:        true,
      referrerName: ref.referrer?.name ?? 'A friend',
    });
  } catch (err) {
    console.error('GET /referral/validate error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/referral/apply
// Body: { code: "NVIQ-XXXX", phone: "+91..." }
// Called right after a NEW user completes OTP login.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/apply', protect, async (req, res) => {
  try {
    const { code, phone } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Referral code is required' });
    }

    const normalised = code.toUpperCase().trim();
    const ref        = await Referral.findOne({ code: normalised });

    if (!ref) {
      return res.status(404).json({ success: false, message: 'Invalid referral code' });
    }

    const newUserId   = (req.user._id ?? req.user.id).toString();
    const referrerId  = ref.referrer.toString();

    // Prevent self-referral
    if (referrerId === newUserId) {
      return res.status(400).json({ success: false, message: 'You cannot use your own referral code' });
    }

    // Prevent duplicate credit for same user
    const alreadyCredited = ref.referredUsers.some(
      (r) => r.user?.toString() === newUserId
    );
    if (alreadyCredited) {
      return res.json({ success: true, message: 'Referral already credited' });
    }

    ref.referredUsers.push({ user: newUserId, phone: phone ?? '' });
    ref.totalReferrals += 1;
    await ref.save();

    return res.json({ success: true, message: 'Referral credited successfully' });
  } catch (err) {
    console.error('POST /referral/apply error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;