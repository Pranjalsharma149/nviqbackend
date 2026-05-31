'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/historyController');
const { protect } = require('../middleware/auth');

// ── GET /api/history/vehicle/all ──────────────────────────────────────────────
// Scopes history to all vehicles matching the user's role.
// Admin: Fetches history of all vehicles in Nviq.
// Users/Roles: Fetches history of all their own registered vehicles.
// Note: Must be defined before /vehicle/:id route to avoid route parameter collision.
router.get('/vehicle/all', protect, ctrl.getAllVehiclesHistory);

// ── GET /api/history/vehicle/:id ──────────────────────────────────────────────
// Scopes history to a specific vehicle (ownership/admin check inside controller).
router.get('/vehicle/:id', protect, ctrl.getVehicleHistory);

module.exports = router;
