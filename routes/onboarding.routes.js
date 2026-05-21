'use strict';

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect, clearUserCache } = require('../middleware/auth');

const ONBOARDING_ROLES = ['fleet_manager', 'dispatcher', 'operations', 'owner', 'driver'];

router.use(protect);

// GET /api/onboarding/status
router.get('/status', async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      'firstName lastName email company role fleetSize vehicleTypes fleetId logo onboardingStep onboardingComplete'
    ).lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/onboarding/step1 — personal info
// Body: { firstName, lastName, email, company, role }
router.put('/step1', async (req, res) => {
  const { firstName, lastName, email, company, role } = req.body;

  if (!firstName || !lastName || !email || !company || !role) {
    return res.status(400).json({
      success: false,
      message: 'firstName, lastName, email, company, and role are all required',
    });
  }

  if (!ONBOARDING_ROLES.includes(role)) {
    return res.status(400).json({
      success: false,
      message: `role must be one of: ${ONBOARDING_ROLES.join(', ')}`,
    });
  }

  try {
    const emailTaken = await User.findOne({ email: email.toLowerCase(), _id: { $ne: req.user._id } }).lean();
    if (emailTaken) {
      return res.status(400).json({ success: false, message: 'Email is already in use by another account' });
    }

    const update = {
      firstName: firstName.trim(),
      lastName:  lastName.trim(),
      name:      `${firstName.trim()} ${lastName.trim()}`,
      email:     email.toLowerCase().trim(),
      company:   company.trim(),
      role,
      onboardingStep: Math.max(req.user.onboardingStep || 0, 1),
    };

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true })
      .select('firstName lastName email company role onboardingStep onboardingComplete').lean();

    clearUserCache(req.user._id);
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/onboarding/step2 — fleet info
// Body: { fleetSize, vehicleTypes: string | string[] }
router.put('/step2', async (req, res) => {
  const { fleetSize, vehicleTypes } = req.body;

  if (!fleetSize || !vehicleTypes || (Array.isArray(vehicleTypes) && vehicleTypes.length === 0)) {
    return res.status(400).json({ success: false, message: 'fleetSize and vehicleTypes are required' });
  }

  try {
    const update = {
      fleetSize: String(fleetSize).trim(),
      vehicleTypes: (Array.isArray(vehicleTypes) ? vehicleTypes : [vehicleTypes]).map(v => String(v).trim()),
      onboardingStep: Math.max(req.user.onboardingStep || 0, 2),
    };

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true })
      .select('fleetSize vehicleTypes onboardingStep onboardingComplete').lean();

    clearUserCache(req.user._id);
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/onboarding/step3 — fleet identity (fleetId + logo)
// Body: { fleetId?, logo? }  — both optional but at least one expected
router.put('/step3', async (req, res) => {
  const { fleetId, logo } = req.body;

  try {
    if (fleetId) {
      const taken = await User.findOne({ fleetId: fleetId.trim(), _id: { $ne: req.user._id } }).lean();
      if (taken) {
        return res.status(400).json({ success: false, message: 'Fleet ID is already taken' });
      }
    }

    const update = {
      ...(fleetId && { fleetId: fleetId.trim() }),
      ...(logo    && { logo: logo.trim() }),
      onboardingStep:     3,
      onboardingComplete: true,
    };

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true })
      .select('fleetId logo onboardingStep onboardingComplete').lean();

    clearUserCache(req.user._id);
    res.json({ success: true, message: 'Onboarding complete', data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
