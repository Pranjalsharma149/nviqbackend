const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');

// Test route to confirm the file is working
router.get('/test', (req, res) => res.json({ msg: "Ticket route works!" }));

// Placeholder for your actual logic
router.post('/', protect, (req, res) => {
    res.status(201).json({ message: "Ticket received", data: req.body });
});

module.exports = router;