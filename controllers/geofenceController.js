'use strict';

const Geofence = require('../models/Geofence');
const Vehicle  = require('../models/Vehicle');
const Alert    = require('../models/Alert');
const geolib   = require('geolib');
const logger   = require('../utils/logger');

// ── CACHE LAYER ─────────────────────────────────────────────────────────────
// For 20k scale, we avoid hitting the DB for geofence rules on every GPS ping.
let _geofenceCache = [];
let _cacheValid    = false;

async function getActiveGeofences() {
  if (_cacheValid) return _geofenceCache;
  try {
    _geofenceCache = await Geofence.find({ isActive: true }).lean();
    _cacheValid = true;
    return _geofenceCache;
  } catch (err) {
    logger.error('❌ Geofence Cache Load Error: %s', err.message);
    return [];
  }
}

function invalidateCache() { 
  _cacheValid = false; 
}

// ── STANDARD CRUD ───────────────────────────────────────────────────────────

exports.getGeofences = async (req, res) => {
  try {
    const fences = await Geofence.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, count: fences.length, data: fences });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createGeofence = async (req, res) => {
  try {
    const fence = await Geofence.create(req.body);
    invalidateCache();
    res.status(201).json({ success: true, data: fence });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.getGeofenceById = async (req, res) => {
  try {
    const fence = await Geofence.findById(req.params.id);
    if (!fence) return res.status(404).json({ success: false, message: 'Geofence not found' });
    res.json({ success: true, data: fence });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateGeofence = async (req, res) => {
  try {
    const fence = await Geofence.findByIdAndUpdate(req.params.id, req.body, { new: true });
    invalidateCache();
    res.json({ success: true, data: fence });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.deleteGeofence = async (req, res) => {
  try {
    await Geofence.findByIdAndDelete(req.params.id);
    invalidateCache();
    res.json({ success: true, message: 'Geofence deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── BATCH & TOGGLE OPS ──────────────────────────────────────────────────────

exports.assignVehiclesToGeofence = async (req, res) => {
  try {
    const { vehicleIds } = req.body; 
    const fence = await Geofence.findByIdAndUpdate(
      req.params.id, 
      { $set: { vehicleIds } }, 
      { new: true }
    );
    invalidateCache();
    res.json({ success: true, data: fence });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.toggleGeofenceActive = async (req, res) => {
  try {
    const fence = await Geofence.findById(req.params.id);
    if (!fence) return res.status(404).json({ success: false, message: 'Geofence not found' });
    
    fence.isActive = !fence.isActive;
    await fence.save();
    invalidateCache();
    
    res.json({ success: true, isActive: fence.isActive });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ── OPTIMIZED GEOFENCE ENGINE ───────────────────────────────────────────────

/**
 * Triggered by the GPS Engine/Processor. 
 * Checks if the vehicle has entered or exited any cached geofences.
 */
exports.checkGeofences = async (vehicle) => {
  try {
    const geofences = await getActiveGeofences();
    if (!geofences || geofences.length === 0) return;

    const prevFences = (vehicle.insideGeofences || []).map(id => id.toString());
    const currentFences = [];

    for (const fence of geofences) {
      // 1. Assignment Filter: Check if fence is global or specific to this vehicle
      const isAssigned = !fence.vehicleIds || 
                         fence.vehicleIds.length === 0 || 
                         fence.vehicleIds.some(id => id.toString() === vehicle._id.toString());
      
      if (!isAssigned) continue;

      // 2. Geometry Check
      const currentlyInside = isInsideGeofence(vehicle.latitude, vehicle.longitude, fence);
      const fenceIdStr = fence._id.toString();
      const wasInside = prevFences.includes(fenceIdStr);

      if (currentlyInside) {
        currentFences.push(fenceIdStr);
      }

      // 3. Logic: Trigger Entry/Exit Alerts
      if (!wasInside && currentlyInside) {
        await createGeofenceAlert(vehicle, fence, 'geofenceEnter');
      } else if (wasInside && !currentlyInside) {
        await createGeofenceAlert(vehicle, fence, 'geofenceExit');
      }
    }

    // 4. State Update: Only hit the DB if the vehicle's geofence list actually changed
    const hasChanged = prevFences.length !== currentFences.length || 
                       prevFences.sort().join(',') !== currentFences.sort().join(',');

    if (hasChanged) {
      await Vehicle.findByIdAndUpdate(vehicle._id, { 
        $set: { insideGeofences: currentFences } 
      });
    }

  } catch (error) {
    logger.error('🛡️ Geofence Engine Failure: %s', error.message);
  }
};

// ── HELPERS ─────────────────────────────────────────────────────────────────

async function createGeofenceAlert(vehicle, fence, alertType) {
  try {
    const isEnter = alertType === 'geofenceEnter';
    
    const alert = await Alert.create({
      vehicleId:   vehicle._id,
      imei:        vehicle.imei,
      vehicleReg:  vehicle.vehicleReg,
      type:        alertType,
      title:       isEnter ? `📍 Entered: ${fence.name}` : `🚧 Exited: ${fence.name}`,
      message:     `${vehicle.name || vehicle.imei} has ${isEnter ? 'entered' : 'exited'} the geofence zone.`,
      priority:    'high',
      latitude:    vehicle.latitude,
      longitude:   vehicle.longitude,
      speed:       vehicle.speed,
      timestamp:   new Date(),
    });

    if (global.io) {
      global.io.emit('newAlert', alert);
      // Optional: push to a specific room for that vehicle
      global.io.to(vehicle._id.toString()).emit('vehicleAlert', alert);
    }
  } catch (err) {
    logger.error('❌ Alert Creation Error: %s', err.message);
  }
}

function isInsideGeofence(lat, lng, fence) {
  try {
    if (fence.geometry.type === 'Circle') {
      const dist = geolib.getDistance(
        { latitude: lat, longitude: lng },
        { latitude: fence.geometry.center.latitude, longitude: fence.geometry.center.longitude }
      );
      return dist <= fence.geometry.radius;
    }
    
    if (fence.geometry.type === 'Polygon') {
      // GeoJSON standard is [lng, lat]. Geolib needs {latitude, longitude}.
      // Polygons in GeoJSON are nested: [ [ [lng, lat], [lng, lat] ] ]
      const polygonCoords = fence.geometry.coordinates[0].map(coord => ({
        latitude: coord[1],
        longitude: coord[0]
      }));

      return geolib.isPointInPolygon(
        { latitude: lat, longitude: lng },
        polygonCoords
      );
    }
  } catch (err) {
    return false;
  }
  return false;
}