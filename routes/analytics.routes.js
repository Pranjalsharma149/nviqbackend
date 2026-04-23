'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/analyticsController');
const { protect } = require('../middleware/auth');

// ── Fleet Level ──────────────────────────────────────────────────────────────
router.get('/fleet/summary', protect, ctrl.getFleetSummary);
router.get('/fleet/trends',  protect, ctrl.getFleetTrends); // Recommended: For line charts (Distance/Fuel)

// ── Vehicle Level ────────────────────────────────────────────────────────────
router.get('/vehicles/:id',  protect, ctrl.getVehicleAnalytics);

module.exports = router;