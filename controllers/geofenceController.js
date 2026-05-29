'use strict';

const Geofence = require('../models/Geofence');
const Vehicle = require('../models/Vehicle');
const Alert = require('../models/Alert');
const logger = require('../utils/logger');

// ── Haversine distance (metres) ───────────────────────────────────────────────
function distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Cache ─────────────────────────────────────────────────────────────────────
let _cache = [];
let _cacheValid = false;

async function getActiveGeofences() {
  if (_cacheValid) return _cache;
  try {
    _cache = await Geofence.find({ isActive: true, status: { $ne: 'inactive' } }).lean();
    _cacheValid = true;
    return _cache;
  } catch (err) {
    logger.error('Geofence cache error: %s', err.message);
    return [];
  }
}

function invalidateCache() { _cacheValid = false; }

// ── isInside — works with simple lat/lng/radius model ────────────────────────
function isInside(vLat, vLng, fence) {
  if (!vLat || !vLng) return false;
  try {
    const dist = distanceMetres(vLat, vLng, fence.latitude, fence.longitude);
    return dist <= (fence.radius ?? 500);
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/geofences
// ─────────────────────────────────────────────────────────────────────────────
exports.getGeofences = async (req, res) => {
  try {
    const { vehicleId } = req.query;
    const filter = vehicleId
      ? { $or: [{ vehicleId }, { vehicleId: 'all' }] }
      : {};

    const fences = await Geofence.find(filter).sort({ createdAt: -1 }).lean();

    // Normalise for Flutter GeofenceModel
    const data = fences.map(f => ({
      id: f._id.toString(),
      name: f.name,
      description: f.description ?? '',
      vehicleId: f.vehicleId ?? 'all',
      latitude: f.latitude,
      longitude: f.longitude,
      radius: f.radius ?? 500,
      status: f.status ?? 'active',
      alertType: f.alertType ?? 'both',
      color: f.color ?? '#4f8ef7',
      isActive: f.isActive ?? true,
      notifyPush: f.notifyPush ?? true,
      triggeredAt: f.triggeredAt ?? null,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    }));

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/geofences/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getGeofenceById = async (req, res) => {
  try {
    const fence = await Geofence.findById(req.params.id).lean();
    if (!fence) return res.status(404).json({ success: false, message: 'Geofence not found' });
    res.json({ success: true, data: { ...fence, id: fence._id.toString() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/geofences
// Flutter sends: { name, vehicleId, latitude, longitude, radius, alertType, color }
// ─────────────────────────────────────────────────────────────────────────────
exports.createGeofence = async (req, res) => {
  try {
    const {
      name, description, vehicleId, userId,
      latitude, longitude, radius,
      alertType, color, notifyPush, notifyEmail, notifySms,
    } = req.body;

    if (!name || latitude == null || longitude == null) {
      return res.status(400).json({ success: false, message: 'name, latitude, longitude are required' });
    }

    const fence = await Geofence.create({
      name,
      description: description ?? '',
      vehicleId: vehicleId ?? 'all',
      userId: userId ?? req.user?._id,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      radius: parseFloat(radius ?? 500),
      alertType: alertType ?? 'both',
      color: color ?? '#4f8ef7',
      notifyPush: notifyPush ?? true,
      notifyEmail: notifyEmail ?? false,
      notifySms: notifySms ?? false,
      status: 'active',
      isActive: true,
    });

    invalidateCache();

    if (global.io) global.io.emit('geofence_created', { ...fence.toObject(), id: fence._id.toString() });

    res.status(201).json({ success: true, data: { ...fence.toObject(), id: fence._id.toString() } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/geofences/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.updateGeofence = async (req, res) => {
  try {
    const fence = await Geofence.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: new Date() },
      { new: true, runValidators: true }
    ).lean();

    if (!fence) return res.status(404).json({ success: false, message: 'Geofence not found' });

    invalidateCache();
    if (global.io) global.io.emit('geofence_updated', { ...fence, id: fence._id.toString() });

    res.json({ success: true, data: { ...fence, id: fence._id.toString() } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/geofences/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteGeofence = async (req, res) => {
  try {
    const fence = await Geofence.findByIdAndDelete(req.params.id);
    if (!fence) return res.status(404).json({ success: false, message: 'Geofence not found' });

    invalidateCache();
    if (global.io) global.io.emit('geofence_deleted', { id: req.params.id });

    res.json({ success: true, message: 'Geofence deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/geofences/:id/toggle
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleGeofenceActive = async (req, res) => {
  try {
    const fence = await Geofence.findById(req.params.id);
    if (!fence) return res.status(404).json({ success: false, message: 'Geofence not found' });

    fence.isActive = !fence.isActive;
    fence.status = fence.isActive ? 'active' : 'inactive';
    await fence.save();
    invalidateCache();

    res.json({ success: true, isActive: fence.isActive, status: fence.status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/geofences/:id/status  — Flutter calls updateGeofenceStatus()
// Body: { status: 'active' | 'inactive' | 'triggered' }
// ─────────────────────────────────────────────────────────────────────────────
exports.updateGeofenceStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const update = { status };
    if (status === 'triggered') update.triggeredAt = new Date();
    if (status === 'inactive') update.isActive = false;
    if (status === 'active') update.isActive = true;

    const fence = await Geofence.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!fence) return res.status(404).json({ success: false, message: 'Geofence not found' });

    invalidateCache();
    res.json({ success: true, data: { ...fence, id: fence._id.toString() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/geofences/:id/assign
// ─────────────────────────────────────────────────────────────────────────────
exports.assignVehiclesToGeofence = async (req, res) => {
  try {
    const { vehicleId } = req.body;
    const fence = await Geofence.findByIdAndUpdate(
      req.params.id,
      { $set: { vehicleId: vehicleId ?? 'all' } },
      { new: true }
    );
    invalidateCache();
    res.json({ success: true, data: fence });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GEOFENCE ENGINE — called by GPS pipeline on every position update
// ─────────────────────────────────────────────────────────────────────────────
exports.checkGeofences = async (vehicle) => {
  try {
    if (!vehicle?.latitude || !vehicle?.longitude) return;

    const geofences = await getActiveGeofences();
    if (!geofences.length) return;

    const prevFences = (vehicle.insideGeofences || []).map(id => id.toString());
    const currentFences = [];

    for (const fence of geofences) {
      // Skip if fence is assigned to a specific vehicle that isn't this one
      if (fence.vehicleId && fence.vehicleId !== 'all') {
        const fenceVid = fence.vehicleId.toString();
        const vid = vehicle._id.toString();
        if (fenceVid !== vid) continue;
      }

      const inside = isInside(vehicle.latitude, vehicle.longitude, fence);
      const fenceIdStr = fence._id.toString();
      const wasInside = prevFences.includes(fenceIdStr);

      if (inside) currentFences.push(fenceIdStr);

      // Entry alert
      if (!wasInside && inside) {
        const shouldAlert =
          fence.alertType === 'both' || fence.alertType === 'entry';
        if (shouldAlert) await _createGeofenceAlert(vehicle, fence, 'geofenceEnter');
      }

      // Exit alert
      if (wasInside && !inside) {
        const shouldAlert =
          fence.alertType === 'both' || fence.alertType === 'exit';
        if (shouldAlert) await _createGeofenceAlert(vehicle, fence, 'geofenceExit');

        // Reset triggered status back to active on exit
        if (fence.status === 'triggered') {
          await Geofence.findByIdAndUpdate(fence._id, { status: 'active', triggeredAt: null });
          invalidateCache();
        }
      }
    }

    // Only write to DB if geofence membership changed
    const changed =
      prevFences.length !== currentFences.length ||
      [...prevFences].sort().join(',') !== [...currentFences].sort().join(',');

    if (changed) {
      await Vehicle.findByIdAndUpdate(vehicle._id, { $set: { insideGeofences: currentFences } });
    }
  } catch (error) {
    logger.error('Geofence engine error: %s', error.message);
  }
};

// ── Internal alert creator ────────────────────────────────────────────────────
async function _createGeofenceAlert(vehicle, fence, alertType) {
  try {
    const isEnter = alertType === 'geofenceEnter';

    const alert = await Alert.create({
      vehicleId: vehicle._id,
      imei: vehicle.imei,
      vehicleReg: vehicle.vehicleReg,
      type: alertType,
      title: isEnter ? `📍 Entered: ${fence.name}` : `🚧 Exited: ${fence.name}`,
      message: `${vehicle.name || vehicle.imei} has ${isEnter ? 'entered' : 'exited'} "${fence.name}"`,
      priority: 'high',
      latitude: vehicle.latitude,
      longitude: vehicle.longitude,
      speed: vehicle.speed,
      meta: { geofenceId: fence._id.toString(), geofenceName: fence.name },
      timestamp: new Date(),
    });

    // Mark geofence as triggered on entry
    if (isEnter) {
      await Geofence.findByIdAndUpdate(fence._id, {
        status: 'triggered',
        triggeredAt: new Date(),
      });
      invalidateCache();
    }

    if (global.io) {
      global.io.emit('newAlert', { ...alert.toObject(), id: alert._id.toString() });
      global.io.to(vehicle._id.toString()).emit('vehicleAlert', { ...alert.toObject(), id: alert._id.toString() });
    }
  } catch (err) {
    logger.error('Geofence alert creation error: %s', err.message);
  }
}