const express = require('express');
const router = express.Router();
const { 
    getAlerts, 
    markAsRead, 
    deleteAlert 
} = require('../controllers/alertController');
const { protect } = require('../middleware/authMiddleware');

/**
 * All routes here are prepended with /api/alerts
 */

// @route   GET /api/alerts
// @desc    Fetch all fleet alerts
router.get('/', protect, getAlerts);

// @route   PUT /api/alerts/:id
// @desc    Mark a specific alert as read
router.put('/:id', protect, markAsRead);

// @route   DELETE /api/alerts/:id
// @desc    Remove an alert from history
router.delete('/:id', protect, deleteAlert);

module.exports = router;