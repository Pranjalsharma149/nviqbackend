const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const User = require('../models/User');

/**
 * @route   GET /api/users/profile
 * @desc    Get the profile of the currently logged-in user
 * @access  Private
 */
router.get('/profile', protect, async (req, res) => {
    try {
        // req.user is populated by the 'protect' middleware
        const user = await User.findById(req.user._id).select('-password');
        
        if (user) {
            res.json({
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                createdAt: user.createdAt
            });
        } else {
            res.status(404).json({ message: "User not found" });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;