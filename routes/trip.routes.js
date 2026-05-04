'use strict';

const express = require('express');
const router  = express.Router();

// ✅ Your existing controller
const ctrl = require('../controllers/TripController');

// ✅ NEW: Add playback controller for trip visualization
const PlaybackCtrl = require('../controllers/TripPlaybackController');

// ═════════════════════════════════════════════════════════════════════════════
// ✅ PLAYBACK ROUTES (NEW) - Must be BEFORE /:id routes to avoid conflicts
// ═════════════════════════════════════════════════════════════════════════════

// Playback data (sampled points for smooth animation)
router.get('/playback',      PlaybackCtrl.playbackData);     // ?vehicleId=&date=2026-05-04&interval=5

// All trip points (complete data)
router.get('/points',        PlaybackCtrl.tripPoints);       // ?vehicleId=&date=2026-05-04

// Trip summary/metrics
router.get('/summary',       PlaybackCtrl.tripSummary);      // ?vehicleId=&date=2026-05-04

// Trip dates for calendar (which dates have data)
router.get('/dates',         PlaybackCtrl.tripDates);        // ?vehicleId=&year=2026&month=5

// Trip events (overspeeds, harsh braking, etc)
router.get('/events',        PlaybackCtrl.tripEvents);       // ?vehicleId=&date=2026-05-04&type=overspeed

// Raw GPS records
router.get('/gps/records',   PlaybackCtrl.gpsRecords);       // ?vehicleId=&startTime=2026-05-04T00:00:00Z&endTime=2026-05-04T23:59:59Z

// ═════════════════════════════════════════════════════════════════════════════
// YOUR EXISTING ROUTES (UNCHANGED)
// ═════════════════════════════════════════════════════════════════════════════

// Analytics (must be BEFORE /:id to avoid route conflict)
router.get('/analytics/summary',  ctrl.analyticsSummary);   // ?period=today|yesterday|week|month|3months&vehicleId=
router.get('/analytics/vehicles', ctrl.vehicleBreakdown);   // ?period=

// Trip CRUD
router.post('/',       ctrl.createTrip);   // create
router.get('/',        ctrl.listTrips);    // list  ?period=&vehicleId=&page=&limit=&completed=
router.get('/:id',     ctrl.getTrip);      // single
router.put('/:id/end', ctrl.endTrip);      // end/complete

module.exports = router;