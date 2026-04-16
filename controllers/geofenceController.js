// controllers/geofenceController.js
'use strict';

const Geofence = require('../models/Geofence');
const Vehicle  = require('../models/Vehicle');
const Alert    = require('../models/Alert');
const geolib   = require('geolib');

// ── In-memory geofence cache — rebuilt on every create/update/delete ──────────
let _geofenceCache = [];
let _cacheValid    = false;

async function getActiveGeofences() {
  if (_cacheValid) return _geofenceCache;
  _geofenceCache = await Geofence.find({ isActive: true }).lean();
  _cacheValid    = true;
  return _geofenceCache;
}

function invalidateCache() { _cacheValid = false; }

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/geofences
// ─────────────────────────────────────────────────────────────────────────────
exports.getGeofences = async (req, res) => {
  try {
    const geofences = await Geofence.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, count: geofences.length, data: geofences.map(g => ({ ...g, id: g._id.toString() })) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/geofences/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getGeofenceById = async (req, res) => {
  try {
    const g = await Geofence.findById(req.params.id).lean();
    if (!g) return res.status(404).json({ success: false, message: 'Geofence not found' });
    res.json({ success: true, data: { ...g, id: g._id.toString() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/geofences
// Body: { name, description, geometry: { type:'Circle'|'Polygon', center:{lat,lng}, radius } | { type:'Polygon', coordinates:[[lat,lng]...] }, vehicleIds, alertOnEntry, alertOnExit }
// ─────────────────────────────────────────────────────────────────────────────
exports.createGeofence = async (req, res) => {
  try {
    const { name, description, geometry, vehicleIds, alertOnEntry, alertOnExit } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'name is required' });
    if (!geometry?.type) return res.status(400).json({ success: false, message: 'geometry.type is required' });

    if (geometry.type === 'Circle') {
      if (!geometry.center?.latitude || !geometry.center?.longitude || !geometry.radius) {
        return res.status(400).json({ success: false, message: 'Circle geofence requires center.latitude, center.longitude, radius' });
      }
    } else if (geometry.type === 'Polygon') {
      if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 3) {
        return res.status(400).json({ success: false, message: 'Polygon geofence requires at least 3 coordinate points' });
      }
    } else {
      return res.status(400).json({ success: false, message: 'geometry.type must be Circle or Polygon' });
    }

    const geofence = await Geofence.create({
      name, description,
      geometry,
      vehicleIds:   vehicleIds  || [],
      alertOnEntry: alertOnEntry ?? true,
      alertOnExit:  alertOnExit  ?? true,
      isActive:     true,
      createdBy:    req.user._id,
    });

    invalidateCache();

    res.status(201).json({ success: true, message: 'Geofence created', data: { ...geofence.toObject(), id: geofence._id.toString() } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/geofences/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.updateGeofence = async (req, res) => {
  try {
    const updates = { ...req.body };
    delete updates._id; delete updates.id; delete updates.createdBy;

    const geofence = await Geofence.findByIdAndUpdate(
      req.params.id, { ...updates, updatedAt: new Date() }, { new: true, runValidators: true }
    );
    if (!geofence) return res.status(404).json({ success: false, message: 'Geofence not found' });

    invalidateCache();
    res.json({ success: true, message: 'Geofence updated', data: { ...geofence.toObject(), id: geofence._id.toString() } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/geofences/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteGeofence = async (req, res) => {
  try {
    const geofence = await Geofence.findByIdAndDelete(req.params.id);
    if (!geofence) return res.status(404).json({ success: false, message: 'Geofence not found' });
    invalidateCache();
    res.json({ success: true, message: 'Geofence deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Core check — called by GPS engine on every position update
// Returns array of triggered alerts (entry/exit)
// ─────────────────────────────────────────────────────────────────────────────
exports.checkGeofences = async (vehicle, previousPosition) => {
  try {
    const geofences = await getActiveGeofences();
    if (geofences.length === 0) return;

    for (const fence of geofences) {
      // Skip if this fence is for specific vehicles and this one isn't in the list
      if (fence.vehicleIds.length > 0 && !fence.vehicleIds.some(id => id.toString() === vehicle._id.toString())) {
        continue;
      }

      const currentlyInside = isInsideGeofence(vehicle.latitude, vehicle.longitude, fence);
      const wasInside       = previousPosition
        ? isInsideGeofence(previousPosition.latitude, previousPosition.longitude, fence)
        : null;

      if (wasInside === null) continue;  // no previous position to compare

      let alertType = null;
      if (!wasInside && currentlyInside && fence.alertOnEntry) alertType = 'geofenceEnter';
      if (wasInside && !currentlyInside && fence.alertOnExit)  alertType = 'geofenceExit';

      if (!alertType) continue;

      const alert = await Alert.create({
        vehicleId:   vehicle._id,
        vehicleReg:  vehicle.vehicleReg,
        title:       alertType === 'geofenceEnter'
          ? `📍 Entered: ${fence.name}`
          : `🚧 Exited: ${fence.name}`,
        message:     alertType === 'geofenceEnter'
          ? `${vehicle.name} entered geofence "${fence.name}"`
          : `${vehicle.name} left geofence "${fence.name}"`,
        type:        alertType,
        priority:    'high',
        latitude:    vehicle.latitude,
        longitude:   vehicle.longitude,
        speed:       vehicle.speed,
        pocName:     vehicle.pocName,
        pocContact:  vehicle.pocContact,
        vehicleType: vehicle.type,
        timestamp:   new Date(),
      });

      if (global.io) {
        global.io.emit('newAlert', { ...alert.toObject(), id: alert._id.toString() });
      }
    }
  } catch (error) {
    console.error('Geofence check error:', error.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────
function isInsideGeofence(lat, lng, fence) {
  if (fence.geometry.type === 'Circle') {
    const dist = geolib.getDistance(
      { latitude: lat, longitude: lng },
      { latitude: fence.geometry.center.latitude, longitude: fence.geometry.center.longitude }
    );
    return dist <= fence.geometry.radius;
  }

  if (fence.geometry.type === 'Polygon') {
    return geolib.isPointInPolygon(
      { latitude: lat, longitude: lng },
      fence.geometry.coordinates.map(c => ({ latitude: c[0], longitude: c[1] }))
    );
  }

  return false;
}