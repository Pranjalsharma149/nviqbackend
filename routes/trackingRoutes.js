const express = require('express');
const router = express.Router();
const { getVehicleLocation } = require('../controllers/trackingController');
const { protect } = require('../middleware/authMiddleware');

/**
 * @route   GET /api/tracking/:traccarId
 * @desc    Fetch live GPS position, speed, and address from Traccar
 * @access  Private (Requires JWT Token)
 */
router.get('/:traccarId', protect, getVehicleLocation);

/**
 * @route   GET /api/tracking/test
 * @desc    Health check for the tracking route
 * @access  Public
 */
router.get('/test', (req, res) => {
    res.json({ 
        success: true, 
        message: "Tracking route is active and ready for Traccar requests." 
    });
});

module.exports = router;