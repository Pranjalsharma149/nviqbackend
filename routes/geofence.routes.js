'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/geofenceController');
const { protect, requireRole } = require('../middleware/auth');

// ── Standard CRUD ────────────────────────────────────────────────────────────
router.get('/',      protect, ctrl.getGeofences);
router.post('/',     protect, ctrl.createGeofence);

// ── Batch Operations (Vital for 20k Scale) ───────────────────────────────────
// Assign multiple vehicles to a fence (updates the vehicleIds array)
router.put('/:id/assign-vehicles', protect, ctrl.assignVehiclesToGeofence);

// Fast toggle for "Active/Inactive" status (invalidates the engine cache)
router.patch('/:id/toggle',        protect, ctrl.toggleGeofenceActive);

// ── Resource Specific ────────────────────────────────────────────────────────
router.get('/:id',    protect, ctrl.getGeofenceById);
router.put('/:id',    protect, ctrl.updateGeofence);

// Require higher privileges for deletion to protect operational data
router.delete('/:id', protect, requireRole('admin', 'fleet_manager'), ctrl.deleteGeofence);

module.exports = router;