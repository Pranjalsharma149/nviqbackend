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
// Body: { firstName, lastName, role, companyName / company, plan, email? }
router.put('/step1', async (req, res) => {
  try {
    const { firstName, lastName, role, plan, email } = req.body;
    const company = req.body.companyName || req.body.company || req.body['company name'] || req.body['compoany name'];

    if (!firstName || !lastName || !company || !role) {
      return res.status(400).json({
        success: false,
        message: 'firstName, lastName, role, and company (or companyName) are all required',
      });
    }

    const validRoles = ['admin', 'fleet_manager', 'dispatcher', 'operations', 'owner', 'driver', 'supervisor'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `role must be one of: ${validRoles.join(', ')}`,
      });
    }

    const update = {
      firstName: firstName.trim(),
      lastName:  lastName.trim(),
      name:      `${firstName.trim()} ${lastName.trim()}`,
      company:   company.trim(),
      role,
      plan:      plan ? plan.trim() : 'Free Plan',
      onboardingStep: Math.max(req.user.onboardingStep || 0, 1),
    };

    if (email) {
      const emailLower = email.toLowerCase().trim();
      const emailTaken = await User.findOne({ email: emailLower, _id: { $ne: req.user._id } }).lean();
      if (emailTaken) {
        return res.status(400).json({ success: false, message: 'Email is already in use by another account' });
      }
      update.email = emailLower;
    }

    const user = await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true })
      .select('firstName lastName email company role plan onboardingStep onboardingComplete').lean();

    clearUserCache(req.user._id);
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/onboarding/step2 — fleet info
// Body: { fleetSize, vehicleTypes: string | string[] } (also accepts typos fleetSzie, vechileTypes)
router.put('/step2', async (req, res) => {
  try {
    const fleetSize = req.body.fleetSize || req.body.fleetSzie;
    const vehicleTypes = req.body.vehicleTypes || req.body.vechileTypes;

    if (!fleetSize || !vehicleTypes || (Array.isArray(vehicleTypes) && vehicleTypes.length === 0)) {
      return res.status(400).json({ success: false, message: 'fleetSize and vehicleTypes are required' });
    }

    const update = {
      fleetSize: String(fleetSize).trim(),
      vehicleTypes: (Array.isArray(vehicleTypes) ? vehicleTypes : [vehicleTypes]).map(v => String(v).trim()),
      onboardingStep: Math.max(req.user.onboardingStep || 0, 2),
      onboardingComplete: true,
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
