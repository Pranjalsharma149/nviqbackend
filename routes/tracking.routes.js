'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/trackingController');
const { protect } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// 📌 LIVE TRACKING ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/tracking/live
 * @desc    Fetch live fleet status for the Flutter Map
 * @access  Protected (Requires User JWT)
 */
router.get('/live', protect, ctrl.getLiveVehicles);

/**
 * @route   POST /api/tracking/batch-update
 * @desc    Inbound data from the WanWay Poller Service
 * @access  Internal / API Key (Optimized for 20k scale)
 */
// TIP: If your WanWay poller is a separate internal service, 
// you might use a specific API_KEY check instead of 'protect' (JWT)
router.post('/batch-update', ctrl.batchUpdate);


// ─────────────────────────────────────────────────────────────────────────────
// 📌 HISTORY & DETAIL ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/tracking/history/:id
 * @desc    Get breadcrumb history for a specific vehicle
 */
router.get('/history/:id', protect, ctrl.getVehicleHistory);

/**
 * @route   GET /api/tracking/:id
 * @desc    Get real-time snapshot of a single vehicle
 */
router.get('/:id', protect, ctrl.getVehicleById);


module.exports = router;