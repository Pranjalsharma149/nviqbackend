const Vehicle = require('../models/Vehicle');

// @desc    Add a vehicle to nVIQ
// @route   POST /api/vehicles
exports.addVehicle = async (req, res) => {
  try {
    const { name, plateNumber, traccarDeviceId, category } = req.body;

    // 1. Validation: Prevent duplicate Traccar IDs
    const vehicleExists = await Vehicle.findOne({ traccarDeviceId });
    if (vehicleExists) {
      return res.status(400).json({ message: "This Traccar Device ID is already registered." });
    }

    // 2. Create Vehicle
    const vehicle = await Vehicle.create({
      name,
      plateNumber,
      traccarDeviceId,
      category,
      status: 'unknown',
      speed: 0
    });

    res.status(201).json(vehicle);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get all vehicles (The Garage List)
// @route   GET /api/vehicles
exports.getVehicles = async (req, res) => {
  try {
    const vehicles = await Vehicle.find({}).sort({ createdAt: -1 });
    res.status(200).json(vehicles);
  } catch (error) {
    res.status(500).json({ message: "Could not fetch vehicles", error: error.message });
  }
};

// @desc    Get single vehicle details
// @route   GET /api/vehicles/:id
exports.getVehicleById = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle) return res.status(404).json({ message: "Vehicle not found" });
    res.json(vehicle);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete a vehicle
// @route   DELETE /api/vehicles/:id
exports.deleteVehicle = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id);
    if (vehicle) {
      await vehicle.deleteOne();
      res.json({ message: 'Vehicle removed successfully' });
    } else {
      res.status(404).json({ message: 'Vehicle not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};