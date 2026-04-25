'use strict';

const express = require('express');
const router  = express.Router();

// ✅ Matches your actual filename: controllers/TripController.js
const ctrl = require('../controllers/TripController');

// ── Analytics (must be BEFORE /:id to avoid route conflict) ──────────────────
router.get('/analytics/summary',  ctrl.analyticsSummary);   // ?period=today|yesterday|week|month|3months&vehicleId=
router.get('/analytics/vehicles', ctrl.vehicleBreakdown);   // ?period=

// ── Trip CRUD ─────────────────────────────────────────────────────────────────
router.post('/',       ctrl.createTrip);   // create
router.get('/',        ctrl.listTrips);    // list  ?period=&vehicleId=&page=&limit=&completed=
router.get('/:id',     ctrl.getTrip);      // single
router.put('/:id/end', ctrl.endTrip);      // end/complete

module.exports = router;