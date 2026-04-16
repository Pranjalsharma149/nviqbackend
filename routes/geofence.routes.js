// routes/geofence.routes.js
'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/geofenceController');
const { protect, requireRole } = require('../middleware/auth');

router.get('/',    protect, ctrl.getGeofences);
router.post('/',   protect, ctrl.createGeofence);
router.get('/:id',    protect, ctrl.getGeofenceById);
router.put('/:id',    protect, ctrl.updateGeofence);
router.delete('/:id', protect, requireRole('admin','fleet_manager'), ctrl.deleteGeofence);

module.exports = router;