'use strict';

/**
 * routes/vehicles.js
 *
 * Vehicle management routes.
 * All vehicles are phone-scoped - user can only access their own vehicles.
 */

const express = require('express');
const router = express.Router();
const Vehicle = require('../models/Vehicle');
const { protect } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vehicles/register
// Register a new vehicle for the authenticated user
// ─────────────────────────────────────────────────────────────────────────────
router.post('/register', protect, async (req, res) => {
  try {
    const { name, registrationNumber, chassisNumber, deviceId } = req.body;

    // Validate required fields
    if (!name || !registrationNumber) {
      return res.status(400).json({
        success: false,
        message: 'Name and registration number required',
      });
    }

    // Get user's phone from JWT token
    const userPhone = req.user.phone;

    // Check if vehicle already registered with this phone
    const existing = await Vehicle.findOne({
      phone: userPhone,
      registrationNumber: registrationNumber.toUpperCase(),
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Vehicle already registered under this account',
      });
    }

    // Check 16 vehicle limit
    const vehicleCount = await Vehicle.countDocuments({ phone: userPhone });
    if (vehicleCount >= 16) {
      return res.status(400).json({
        success: false,
        message: 'Cannot register more than 16 vehicles',
      });
    }

    // Create vehicle with phone reference
    const vehicle = await Vehicle.create({
      phone: userPhone,           // Link to user by phone
      userId: req.user._id,
      name: name.trim(),
      registrationNumber: registrationNumber.toUpperCase(),
      chassisNumber: chassisNumber || null,
      deviceId: deviceId || null,
      status: 'active',
      deviceStatus: 'not_working',
      isOnline: false,
      isLive: false,
    });

    res.status(201).json({
      success: true,
      message: 'Vehicle registered successfully',
      vehicle: vehicle.toObject(),
    });
  } catch (e) {
    if (e.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Vehicle registration number already exists',
      });
    }
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles
// Get all vehicles for the authenticated user
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    // Get user's phone from JWT
    const userPhone = req.user.phone;

    // Find all vehicles for this phone
    const vehicles = await Vehicle.find({ phone: userPhone }).sort({
      createdAt: -1,
    });

    // Count working and not working devices
    const working = vehicles.filter((v) => v.deviceStatus === 'working').length;
    const notWorking = vehicles.length - working;

    res.json({
      success: true,
      total: vehicles.length,
      working,
      notWorking,
      vehicles: vehicles.map((v) => v.toObject()),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/:vehicleId
// Get single vehicle details
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:vehicleId', protect, async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.vehicleId);

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: 'Vehicle not found',
      });
    }

    // Verify ownership - vehicle must belong to authenticated user's phone
    if (vehicle.phone !== req.user.phone) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this vehicle',
      });
    }

    res.json({
      success: true,
      vehicle: vehicle.toObject(),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/vehicles/:vehicleId
// Update vehicle information
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:vehicleId', protect, async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.vehicleId);

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: 'Vehicle not found',
      });
    }

    // Verify ownership
    if (vehicle.phone !== req.user.phone) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this vehicle',
      });
    }

    // Only allow updating these fields
    const { name, pocName, pocContact, speedLimit, status } = req.body;

    if (name) vehicle.name = name.trim();
    if (pocName !== undefined) vehicle.pocName = pocName;
    if (pocContact !== undefined) vehicle.pocContact = pocContact;
    if (speedLimit !== undefined) vehicle.speedLimit = speedLimit;
    if (status !== undefined) vehicle.status = status;

    await vehicle.save();

    res.json({
      success: true,
      message: 'Vehicle updated successfully',
      vehicle: vehicle.toObject(),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/vehicles/:vehicleId
// Remove vehicle from fleet
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:vehicleId', protect, async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.vehicleId);

    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: 'Vehicle not found',
      });
    }

    // Verify ownership
    if (vehicle.phone !== req.user.phone) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this vehicle',
      });
    }

    // Delete the vehicle
    await Vehicle.findByIdAndDelete(req.params.vehicleId);

    res.json({
      success: true,
      message: 'Vehicle removed successfully',
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/status/summary
// Get fleet summary (working/not working count)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status/summary', protect, async (req, res) => {
  try {
    // Get user's phone
    const userPhone = req.user.phone;

    // Find all vehicles for this phone
    const vehicles = await Vehicle.find({ phone: userPhone });

    // Count by status
    const working = vehicles.filter((v) => v.deviceStatus === 'working').length;
    const notWorking = vehicles.length - working;
    const online = vehicles.filter((v) => v.isOnline).length;
    const offline = vehicles.length - online;

    res.json({
      success: true,
      summary: {
        total: vehicles.length,
        working,
        notWorking,
        online,
        offline,
        workingPercentage:
          vehicles.length > 0 ? Math.round((working / vehicles.length) * 100) : 0,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;