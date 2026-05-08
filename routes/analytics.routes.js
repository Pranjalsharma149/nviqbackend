'use strict';

/**
 * routes/analytics.routes.js
 *
 * All analytics endpoints consumed by Flutter live_tracking_screen.dart
 *
 * Mount in server.js as:
 *   app.use('/api/analytics', require('./routes/analytics.routes'));
 */

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/analyticsController');

// ── Fleet-wide ────────────────────────────────────────────────────────────────
router.get('/fleet/summary',  ctrl.getFleetSummary);   // Flutter: getFleetSummary()
router.get('/fleet/trends',   ctrl.getFleetTrends);    // ?days=7&vehicleId=

// ── All vehicle summaries (cold-start hydration) ──────────────────────────────
// Flutter PersistentSyncService.getAllVehicleSummaries() calls this.
// MUST be before /vehicles/:id to avoid route conflict.
router.get('/vehicles/summaries', ctrl.getAllVehicleSummaries);

// ── Per-vehicle ───────────────────────────────────────────────────────────────

// Flutter FIX-1, FIX-2, FIX-4: mileage report
// fleet.fetchMileageReport(id, date) → ?date=YYYY-MM-DD
router.get('/vehicles/:id/mileage',     ctrl.getMileageReport);

// Flutter FIX-6: device install date
// fleet.fetchDeviceInfo(id)
router.get('/vehicles/:id/device-info', ctrl.getDeviceInfo);

// Flutter: fetchTripHistory(id, date) → ?date=YYYY-MM-DD&maxPoints=500
router.get('/vehicles/:id/playback',    ctrl.getPlayback);

// Flutter: live stats panel
router.get('/vehicles/:id/live',        ctrl.getLiveStats);

// Flutter: full vehicle analytics (rolling window or single day)
router.get('/vehicles/:id',             ctrl.getVehicleAnalytics);

module.exports = router;