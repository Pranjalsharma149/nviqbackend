const express = require('express');
const router = express.Router();
const { 
    addVehicle, 
    getVehicles, 
    getVehicleById, 
    deleteVehicle 
} = require('../controllers/vehicleController');
const { protect } = require('../middleware/authMiddleware');

/**
 * All routes here are prepended with /api/vehicles
 */

// @route   POST /api/vehicles
// @desc    Add a new vehicle to the fleet
router.post('/', protect, addVehicle);

// @route   GET /api/vehicles
// @desc    Get all vehicles (The Garage List)
router.get('/', protect, getVehicles);

// @route   GET /api/vehicles/:id
// @desc    Get details of a single vehicle
router.get('/:id', protect, getVehicleById);

// @route   DELETE /api/vehicles/:id
// @desc    Remove a vehicle from the fleet
router.delete('/:id', protect, deleteVehicle);

// Debugging route
router.get('/test', (req, res) => {
    res.json({ message: "Vehicle management routes are active" });
});

module.exports = router;