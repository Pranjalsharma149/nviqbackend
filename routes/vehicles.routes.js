'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/vehicle.controller');
const { protect } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC
// ─────────────────────────────────────────────────────────────────────────────

// Flutter app polls this on startup before auth token is confirmed
router.get('/live', ctrl.getLiveVehicles);

// ─────────────────────────────────────────────────────────────────────────────
// VEHICLE CRUD
// ─────────────────────────────────────────────────────────────────────────────

router.get  ('/',    protect, ctrl.getAllVehicles);
router.post ('/',    protect, ctrl.createVehicle);

// IMPORTANT: static named routes (/live, /update-location) MUST be defined
// before /:id so Express doesn't treat 'live' or 'update-location' as an id.
router.post ('/update-location', protect, ctrl.updateLocation);

router.get  ('/:id', protect, ctrl.getVehicleById);
router.put  ('/:id', protect, ctrl.updateVehicle);
router.delete('/:id', protect, ctrl.deleteVehicle);

// ─────────────────────────────────────────────────────────────────────────────
// DEVICE INFO  — Flutter: fetchDeviceInfo(vehicleId)
// Returns install date, registration time, IMEI, protocol etc.
// FIX-6: all activationTime / createdAt / addTime aliases returned
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/device-info', protect, ctrl.getDeviceInfo);

// ─────────────────────────────────────────────────────────────────────────────
// MILEAGE REPORT  — Flutter: fetchMileageReport(vehicleId, date)
// ?date=YYYY-MM-DD  (defaults to today)
// Returns todayDistanceKm, totalDistanceKm, engineHours as SEPARATE fields
// FIX-1 / FIX-2 / FIX-4
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/mileage', protect, ctrl.getMileageReport);

// ─────────────────────────────────────────────────────────────────────────────
// COMMANDS  — Flutter: sendCommand(vehicleId, commandName)
// Body: { command: 'Cut Engine' | 'Restore Engine' | 'Sound Horn' |
//                  'Reboot Device' | 'Request Location' | 'Device Settings' }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/command', protect, ctrl.sendCommand);

// ─────────────────────────────────────────────────────────────────────────────
// ALERTS  — Flutter: AlertsScreen / fleet.unreadAlertCount
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/alerts', protect, ctrl.getVehicleAlerts);

module.exports = router;