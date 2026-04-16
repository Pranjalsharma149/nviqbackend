// routes/vehicles.routes.js
'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/vehicleController');
const { protect, requireRole } = require('../middleware/auth');

// ✅ CRITICAL: static routes MUST come before /:id
router.get('/stats/summary',    protect, ctrl.getStatsSummary);
router.get('/location/:imei',   protect, ctrl.getVehicleLocation);

router.get('/',    protect, ctrl.getVehicles);
router.post('/',   protect, ctrl.addVehicle);
router.get('/:id',    protect, ctrl.getVehicleById);
router.put('/:id',    protect, ctrl.updateVehicle);
router.delete('/:id', protect, requireRole('admin','fleet_manager'), ctrl.deleteVehicle);

module.exports = router;