// controllers/vehicleController.js
'use strict';

const Vehicle      = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const Alert        = require('../models/Alert');

// ── Shared formatter — keeps all routes consistent ────────────────────────────
function formatVehicle(v) {
  const obj = typeof v.toObject === 'function' ? v.toObject() : v;
  return {
    ...obj,
    id:           obj._id?.toString() ?? obj.id,
    lat:          obj.latitude,
    lng:          obj.longitude,
    speed:        Number(obj.speed)        || 0,
    fuel:         Number(obj.fuel)         || 0,
    batteryLevel: Number(obj.batteryLevel) || 0,
    heading:      Number(obj.heading)      || 0,
    driverName:   obj.pocName,      // Flutter reads driverName
    driverPhone:  obj.pocContact,   // Flutter reads driverPhone
    timestamp:    obj.lastUpdate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicles = async (req, res) => {
  try {
    const { status, type, isLive, search } = req.query;
    const query = {};

    if (status && status !== 'all') query.status = status;
    if (type)                        query.type   = type;
    if (isLive !== undefined)        query.isLive = isLive === 'true';

    if (search) {
      query.$or = [
        { name:       { $regex: search, $options: 'i' } },
        { vehicleReg: { $regex: search, $options: 'i' } },
        { pocName:    { $regex: search, $options: 'i' } },
      ];
    }

    const [vehicles, total] = await Promise.all([
      Vehicle.find(query).sort({ lastUpdate: -1 }).limit(200).lean(),
      Vehicle.countDocuments(query),
    ]);

    res.json({
      success: true,
      count:   vehicles.length,
      total,
      data:    vehicles.map(formatVehicle),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/stats/summary  ← must be registered BEFORE /:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getStatsSummary = async (req, res) => {
  try {
    const [total, live, moving, idle, offline] = await Promise.all([
      Vehicle.countDocuments(),
      Vehicle.countDocuments({ isLive: true }),
      Vehicle.countDocuments({ status: 'moving' }),
      Vehicle.countDocuments({ status: 'idle' }),
      Vehicle.countDocuments({ isOnline: false }),
    ]);

    res.json({ success: true, data: { total, live, moving, idle, offline } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleById = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id).lean();
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });
    res.json({ success: true, data: formatVehicle(vehicle) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vehicles
// ─────────────────────────────────────────────────────────────────────────────
exports.addVehicle = async (req, res) => {
  try {
    const {
      name, vehicleReg, type, pocName, pocContact,
      latitude, longitude, fuel, batteryLevel,
      imei, protocol, status, isLive, location,
    } = req.body;

    if (!name || !vehicleReg) {
      return res.status(400).json({ success: false, message: 'name and vehicleReg are required' });
    }

    const existing = await Vehicle.findOne({ vehicleReg });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Vehicle with this registration / IMEI already exists' });
    }

    const vehicle = await Vehicle.create({
      name, vehicleReg, type: type || 'car',
      pocName, pocContact,
      latitude:     latitude     ?? 28.6139,
      longitude:    longitude    ?? 77.2090,
      fuel:         fuel         ?? 100,
      batteryLevel: batteryLevel ?? 100,
      speed:  0, heading: 0,
      status: status || 'idle',
      isLive: isLive ?? false,
      isOnline: isLive ?? false,
      imei:    imei     ? String(imei).trim()     : undefined,
      protocol:protocol ? String(protocol).trim() : 'GT06',
      location,
      lastUpdate: new Date(),
    });

    // Notify connected Flutter clients
    if (req.io) {
      req.io.emit('vehicleAdded', formatVehicle(vehicle));
    }

    res.status(201).json({ success: true, message: 'Vehicle registered', data: formatVehicle(vehicle) });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'Duplicate IMEI or registration' });
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/vehicles/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.updateVehicle = async (req, res) => {
  try {
    // Strip fields that must never be updated via this endpoint
    const updates = { ...req.body };
    for (const f of ['_id', 'id', 'createdAt', 'updatedAt', 'vehicleReg']) {
      delete updates[f];
    }

    const vehicle = await Vehicle.findByIdAndUpdate(
      req.params.id,
      { ...updates, updatedAt: new Date() },
      { new: true, runValidators: true }
    );

    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });

    if (req.io) req.io.emit('vehicleUpdated', formatVehicle(vehicle));

    res.json({ success: true, message: 'Vehicle updated', data: formatVehicle(vehicle) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/vehicles/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteVehicle = async (req, res) => {
  try {
    const vehicle = await Vehicle.findByIdAndDelete(req.params.id);
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });

    // Cascade delete related data
    await Promise.all([
      LocationPing.deleteMany({ vehicleId: vehicle._id }),
      Alert.deleteMany({ vehicleId: vehicle._id }),
    ]);

    if (req.io) req.io.emit('vehicleRemoved', { vehicleId: vehicle._id.toString() });

    res.json({ success: true, message: 'Vehicle and all related data deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles/location/:imei  — used by GPS server / live tracking
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleLocation = async (req, res) => {
  try {
    const { imei } = req.params;

    // Check in-memory cache first (zero DB latency for 1000 vehicles)
    const liveData = global.vehicleStates?.[imei];
    if (liveData) {
      return res.json({ success: true, source: 'cache', data: liveData });
    }

    const vehicle = await Vehicle.findOne(
      { $or: [{ imei }, { vehicleReg: imei }] },
      'latitude longitude speed status lastUpdate gpsSignal'
    ).lean();

    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });

    res.json({ success: true, source: 'db', data: formatVehicle(vehicle) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};