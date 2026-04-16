// routes/analytics.routes.js
'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/analyticsController');
const { protect } = require('../middleware/auth');

router.get('/fleet/summary',   protect, ctrl.getFleetSummary);
router.get('/vehicles/:id',    protect, ctrl.getVehicleAnalytics);

module.exports = router;