'use strict';

const Vehicle = require('../models/Vehicle');
const logger = require('../utils/logger');

// Shared field selector
const VEHICLE_FIELDS = [
  'name', 'vehicleReg', 'imei', 'type', 'status', 'isOnline',
  'lat', 'lng', 'latitude', 'longitude',
  'speed', 'heading', 'fuel', 'batteryLevel',
  'location', 'address', 'formattedLocation', 'lastKnownLocation',
  'lastUpdate', 'lastGpsTime', 'lastOnlineAt',
  'offlineDuration', 'gpsSignal', 'isLive',
  'pocName', 'pocContact', 'driverName', 'driverPhone',
].join(' ');

// Normalize vehicle response
function normalise(v) {
  const lat = v.lat ?? v.latitude ?? null;
  const lng = v.lng ?? v.longitude ?? null;

  const address =
    v.formattedLocation ||
    v.address ||
    v.location ||
    v.lastKnownLocation?.address ||
    (lat && lng && !(lat === 0 && lng === 0)
      ? `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`
      : null);

  return {
    id: (v._id ?? v.id)?.toString(),
    name: v.name,
    vehicleReg: v.vehicleReg,
    imei: v.imei,
    type: v.type,
    status: v.status,
    isOnline: v.isOnline ?? false,
    isLive: v.isLive ?? false,
    gpsSignal: v.gpsSignal ?? (v.isOnline ?? false),
    lat,
    lng,
    latitude: lat,
    longitude: lng,
    speed: v.speed ?? 0,
    heading: v.heading ?? 0,
    fuel: v.fuel ?? 100,
    batteryLevel: v.batteryLevel ?? null,
    formattedLocation: address,
    address,
    location: address,
    lastKnownLocation: v.lastKnownLocation
      ? {
          latitude: v.lastKnownLocation.latitude ?? lat,
          longitude: v.lastKnownLocation.longitude ?? lng,
          speed: v.lastKnownLocation.speed,
          heading: v.lastKnownLocation.heading,
          altitude: v.lastKnownLocation.altitude,
          voltage: v.lastKnownLocation.voltage,
          odometer: v.lastKnownLocation.odometer ?? v.lastKnownLocation.mileage,
          address,
          timestamp: v.lastKnownLocation.timestamp ?? v.lastGpsTime ?? v.lastUpdate,
        }
      : (lat
          ? {
              latitude: lat,
              longitude: lng,
              address,
              timestamp: v.lastGpsTime ?? v.lastUpdate,
            }
          : null),
    lastUpdate: v.lastUpdate,
    lastGpsTime: v.lastGpsTime ?? v.lastUpdate,
    lastOnlineAt: v.lastOnlineAt ?? (v.isOnline ? new Date() : null),
    offlineDuration: v.offlineDuration ?? null,
    pocName: v.pocName ?? v.driverName ?? null,
    pocContact: v.pocContact ?? v.driverPhone ?? null,
  };
}

// Get all vehicles
exports.getAllVehicles = async (req, res) => {
  try {
    const vehicles = await Vehicle.find({})
      .select(VEHICLE_FIELDS)
      .limit(1000)
      .lean();

    res.status(200).json({
      success: true,
      count: vehicles.length,
      data: vehicles.map(normalise),
    });
  } catch (err) {
    logger.error('Get All Vehicles Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get vehicle by ID
exports.getVehicleById = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id)
      .select(VEHICLE_FIELDS)
      .lean();

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    res.status(200).json({ success: true, data: normalise(vehicle) });
  } catch (err) {
    logger.error('Get Vehicle By ID Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Create vehicle
exports.createVehicle = async (req, res) => {
  try {
    const vehicle = await Vehicle.create(req.body);
    res.status(201).json({
      success: true,
      message: 'Vehicle created successfully',
      data: normalise(vehicle.toObject()),
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

// Update vehicle
exports.updateVehicle = async (req, res) => {
  try {
    const updatedVehicle = await Vehicle.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).lean();

    if (!updatedVehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Vehicle updated successfully',
      data: normalise(updatedVehicle),
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Delete vehicle
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

// Update location
exports.updateLocation = async (req, res) => {
  try {
    const { imei, latitude, longitude, speed, heading, address, location } = req.body;

    const lat = req.body.lat ?? latitude;
    const lng = req.body.lng ?? longitude;

    const vehicle = await Vehicle.findOneAndUpdate(
      { imei },
      {
        lat, lng,
        latitude: lat, 
        longitude: lng,
        speed,
        heading,
        lastUpdate: new Date(),
        isOnline: true,
        ...(address && { address, formattedLocation: address, location: address }),
        ...(location && { location, formattedLocation: location, address: location }),
      },
      { new: true, lean: true }
    );

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'IMEI not found' });
    }

    if (global.io) {
      global.io.emit('vehicle_movement', normalise(vehicle));
    }

    res.status(200).json({ success: true, data: normalise(vehicle) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Get live vehicles
exports.getLiveVehicles = async (req, res) => {
  try {
    const vehicles = await Vehicle.find({})
      .select(VEHICLE_FIELDS)
      .limit(1000)
      .lean();

    res.status(200).json({
      success: true,
      count: vehicles.length,
      data: vehicles.map(normalise),
    });
  } catch (err) {
    logger.error('getLiveVehicles Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};