'use strict';

const Vehicle = require('../models/Vehicle');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────
// 📌 GET ALL VEHICLES
// ─────────────────────────────────────────────
exports.getAllVehicles = async (req, res) => {
  try {
    // For 20k scale, never return all vehicles in one go without a limit or pagination.
    // Added a safety limit of 1000 and used .lean() for speed.
    const vehicles = await Vehicle.find({})
      .select('name vehicleReg imei type status isOnline')
      .limit(1000) 
      .lean();

    res.status(200).json({
      success: true,
      count: vehicles.length,
      data: vehicles,
    });
  } catch (err) {
    logger.error('Get All Vehicles Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// 📌 GET VEHICLE BY ID
// ─────────────────────────────────────────────
exports.getVehicleById = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id).lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    res.status(200).json({ success: true, data: vehicle });
  } catch (err) {
    logger.error('Get Vehicle By ID Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// 📌 CREATE VEHICLE
// ─────────────────────────────────────────────
exports.createVehicle = async (req, res) => {
  try {
    const vehicle = await Vehicle.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Vehicle created successfully',
      data: vehicle,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Vehicle with same registration or IMEI already exists',
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// 📌 UPDATE VEHICLE
// ─────────────────────────────────────────────
exports.updateVehicle = async (req, res) => {
  try {
    const updatedVehicle = await Vehicle.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!updatedVehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Vehicle updated successfully',
      data: updatedVehicle,
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// 📌 DELETE VEHICLE
// ─────────────────────────────────────────────
exports.deleteVehicle = async (req, res) => {
  try {
    const deletedVehicle = await Vehicle.findByIdAndDelete(req.params.id);

    if (!deletedVehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    res.status(200).json({ success: true, message: 'Vehicle deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// 📌 UPDATE LIVE LOCATION (Single Point Update)
// ─────────────────────────────────────────────
exports.updateLocation = async (req, res) => {
  try {
    const { imei, latitude, longitude, speed, heading } = req.body;

    // Use findOneAndUpdate with lean() to minimize overhead
    const vehicle = await Vehicle.findOneAndUpdate(
      { imei },
      {
        latitude,
        longitude,
        speed,
        heading,
        lastUpdate: new Date(),
        isOnline: true,
      },
      { new: true, lean: true }
    );

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'IMEI not found' });
    }

    res.status(200).json({ success: true, data: vehicle });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// 📌 GET LIVE VEHICLES (Map View)
// ─────────────────────────────────────────────
exports.getLiveVehicles = async (req, res) => {
  try {
    // Only return vehicles that updated in the last 15 minutes
    const threshold = new Date(Date.now() - 15 * 60 * 1000);
    
    const vehicles = await Vehicle.find({ 
      lastUpdate: { $gte: threshold },
      isOnline: true 
    })
    .select('name vehicleReg latitude longitude speed heading type status')
    .lean();

    res.status(200).json({
      success: true,
      count: vehicles.length,
      data: vehicles,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};