'use strict';

const express = require('express');
const router  = express.Router();
const vehicleController = require('../controllers/vehicleController.js');
const { protect, requireRole } = require('../middleware/auth');

// ─────────────────────────────────────────────
// 📌 SPECIAL ROUTES (MUST COME FIRST)
// ─────────────────────────────────────────────

// Internal/WanWay use: Single device location update
router.post('/update-location', vehicleController.updateLocation);

// Public/Flutter use: Get all currently moving vehicles
router.get('/live/all', protect, vehicleController.getLiveVehicles);


// ─────────────────────────────────────────────
// 📌 CRUD ROUTES
// ─────────────────────────────────────────────

// Get fleet list (Optimized with 1000 limit)
router.get('/', protect, vehicleController.getAllVehicles);

// Add new vehicle to fleet
router.post('/', protect, requireRole('admin', 'fleet_manager'), vehicleController.createVehicle);

// Single vehicle operations
router.get('/:id', protect, vehicleController.getVehicleById);
router.put('/:id', protect, requireRole('admin', 'fleet_manager'), vehicleController.updateVehicle);
router.delete('/:id', protect, requireRole('admin'), vehicleController.deleteVehicle);


module.exports = router;