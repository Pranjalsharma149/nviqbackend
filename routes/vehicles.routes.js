'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/vehicleController');
const { protect } = require('../middleware/auth');

// Public endpoints (optional - adjust based on security needs)
router.get('/live', ctrl.getLiveVehicles);

// Protected endpoints
router.get('/', protect, ctrl.getAllVehicles);
router.post('/', protect, ctrl.createVehicle);
router.get('/:id', protect, ctrl.getVehicleById);
router.put('/:id', protect, ctrl.updateVehicle);
router.delete('/:id', protect, ctrl.deleteVehicle);

// Real-time location update
router.post('/update-location', protect, ctrl.updateLocation);

module.exports = router;