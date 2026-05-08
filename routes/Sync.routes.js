'use strict';

/**
 * routes/sync.routes.js
 *
 * Routes for Flutter's PersistentSyncService calls.
 *
 * Mount in server.js as:
 *   app.use('/api/sync', require('./routes/sync.routes'));
 */

const express = require('express');
const router  = express.Router();
const ctrl    = require('../services/persistentSync.service');

// POST /api/sync/gps-fix
// Flutter _tryRecordGPSFix() → PersistentSyncService.recordGPSFixWithOdometer()
router.post('/gps-fix', ctrl.recordGPSFix);

// GET /api/sync/vehicle-summaries
// Flutter PersistentSyncService.getAllVehicleSummaries()
router.get('/vehicle-summaries', ctrl.getVehicleSummaries);

module.exports = router;