// services/gps.engine.js
'use strict';

const geolib       = require('geolib');
const LocationPing = require('../models/LocationPing');
const Trip         = require('../models/Trip');
const Alert        = require('../models/Alert');
const Geofence     = require('../models/Geofence');
const devices      = require('../config/devices');

// ── Alert dedup (prevents spam every 10s) ────────────────────────────────────
const alertDedup = new Map();
const DEDUP_MS   = parseInt(process.env.ALERT_DEDUP_WINDOW_MINUTES || '5') * 60 * 1000;

// ── Previous geofence state per vehicle ──────────────────────────────────────
const geofenceState = new Map(); // vehicleId → Set of geofenceIds vehicle is inside

class GPSEngine {
  static async processUpdate(vehicle) {
    try {
      const prevPing = await LocationPing.findOne(
        { vehicleId: vehicle._id },
        'latitude longitude status speed'
      ).sort({ timestamp: -1 }).lean();

      await Promise.all([
        this._detectTrip(vehicle, prevPing),
        this._checkAlerts(vehicle),
        this._checkGeofences(vehicle),
      ]);
    } catch (e) {
      console.error(`GPS engine error (${vehicle.vehicleReg}):`, e.message);
    }
  }

  // ── Trip detection ──────────────────────────────────────────────────────────
  static async _detectTrip(vehicle, prevPing) {
    if (!prevPing) return;

    const IDLE_MIN   = parseInt(process.env.IDLE_TIMEOUT_MINUTES || '10');
    const MIN_DIST_M = 100;

    const timeDiffMin = (new Date(vehicle.lastUpdate) - new Date(prevPing.timestamp ?? Date.now())) / 60000;
    const distM = geolib.getDistance(
      { latitude: prevPing.latitude,  longitude: prevPing.longitude },
      { latitude: vehicle.latitude,   longitude: vehicle.longitude  }
    );

    // Trip START
    if (prevPing.status === 'idle' && vehicle.status === 'moving' && distM > MIN_DIST_M) {
      await Trip.create({
        vehicleId:     vehicle._id,
        startTime:     vehicle.lastUpdate,
        startLocation: { latitude: vehicle.latitude, longitude: vehicle.longitude },
        fuelStart:     vehicle.fuel,
      });
      console.log(`🚗 Trip started: ${vehicle.vehicleReg}`);
    }

    // Trip END
    if (prevPing.status === 'moving' && ['idle','parked'].includes(vehicle.status) && timeDiffMin > IDLE_MIN) {
      const trip = await Trip.findOne({ vehicleId: vehicle._id, isCompleted: false }).sort({ startTime: -1 });
      if (trip) {
        const durMin  = (new Date(vehicle.lastUpdate) - trip.startTime) / 60000;
        const distKm  = geolib.getDistance(
          { latitude: trip.startLocation.latitude, longitude: trip.startLocation.longitude },
          { latitude: vehicle.latitude, longitude: vehicle.longitude }
        ) / 1000;

        Object.assign(trip, {
          endTime:       vehicle.lastUpdate,
          duration:      durMin,
          endLocation:   { latitude: vehicle.latitude, longitude: vehicle.longitude },
          totalDistance: distKm,
          avgSpeed:      durMin > 0 ? distKm / (durMin / 60) : 0,
          fuelEnd:       vehicle.fuel,
          fuelConsumed:  Math.max(0, (trip.fuelStart || 0) - vehicle.fuel),
          isCompleted:   true,
        });
        trip.efficiency = trip.fuelConsumed > 0 ? distKm / trip.fuelConsumed : 0;
        await trip.save();
        console.log(`✅ Trip ended: ${vehicle.vehicleReg} — ${distKm.toFixed(2)}km`);
      }
    }
  }

  // ── Alert checks ─────────────────────────────────────────────────────────────
  static async _checkAlerts(vehicle) {
    const cfg        = devices.getByIMEI(vehicle.imei) || {};
    const speedLimit = cfg.speedLimit ?? parseInt(process.env.OVERSPEED_THRESHOLD_KMH || '80');
    const fuelAlert  = cfg.fuelAlert  ?? parseInt(process.env.LOW_FUEL_THRESHOLD_PCT   || '15');
    const battAlert  = cfg.battAlert  ?? parseInt(process.env.LOW_BATTERY_THRESHOLD_PCT || '20');

    const toCreate = [];

    const add = (type, priority, title, message, extra = {}) => {
      if (!this._canAlert(vehicle._id, type)) return;
      toCreate.push({
        vehicleId:   vehicle._id,
        vehicleReg:  vehicle.vehicleReg,
        title, message, type, priority,
        latitude:    vehicle.latitude,
        longitude:   vehicle.longitude,
        speed:       vehicle.speed,
        pocName:     vehicle.pocName,
        pocContact:  vehicle.pocContact,
        vehicleType: vehicle.type,
        timestamp:   new Date(),
        ...extra,
      });
    };

    // Overspeed
    if (vehicle.speed > speedLimit && vehicle.status === 'moving') {
      add('overspeed', 'critical',
        '🚨 Overspeed Alert',
        `${vehicle.name} at ${vehicle.speed.toFixed(0)} km/h (limit: ${speedLimit} km/h)`);
    }

    // Low fuel
    if (vehicle.fuel > 0 && vehicle.fuel < fuelAlert) {
      add('lowFuel', 'medium',
        '⛽ Low Fuel Warning',
        `${vehicle.name} fuel at ${vehicle.fuel.toFixed(0)}%`);
    }

    // Low battery
    if (vehicle.batteryLevel > 0 && vehicle.batteryLevel < battAlert) {
      add('lowBattery', 'medium',
        '🔋 Low Battery',
        `${vehicle.name} battery at ${vehicle.batteryLevel.toFixed(0)}%`);
    }

    // GPS lost
    if (!vehicle.gpsSignal) {
      add('gpsLost', 'high',
        '📡 GPS Signal Lost',
        `${vehicle.name} has lost GPS signal`);
    }

    if (toCreate.length === 0) return;

    const created = await Alert.insertMany(toCreate, { ordered: false });
    for (const a of created) {
      if (global.io) global.io.emit('newAlert', { ...a.toObject(), id: a._id.toString() });
    }
  }

  // ── Geofence check ────────────────────────────────────────────────────────
  static async _checkGeofences(vehicle) {
    try {
      const fences = await Geofence.find({ isActive: true }).lean();
      if (!fences.length) return;

      const vid      = vehicle._id.toString();
      const prevInside = geofenceState.get(vid) || new Set();
      const nowInside  = new Set();

      for (const fence of fences) {
        // Skip if this fence targets specific vehicles and this isn't one
        if (fence.vehicleIds?.length > 0) {
          const applies = fence.vehicleIds.some(id => id.toString() === vid);
          if (!applies) continue;
        }

        const inside = isInsideFence(vehicle.latitude, vehicle.longitude, fence);
        if (inside) nowInside.add(fence._id.toString());

        const wasInside = prevInside.has(fence._id.toString());

        if (!wasInside && inside && fence.alertOnEntry) {
          await this._geofenceAlert(vehicle, fence, 'geofenceEnter');
        }
        if (wasInside && !inside && fence.alertOnExit) {
          await this._geofenceAlert(vehicle, fence, 'geofenceExit');
        }
      }

      geofenceState.set(vid, nowInside);
    } catch (e) {
      console.error('Geofence check error:', e.message);
    }
  }

  static async _geofenceAlert(vehicle, fence, type) {
    if (!this._canAlert(vehicle._id, `${type}_${fence._id}`)) return;

    const isEntry = type === 'geofenceEnter';
    const alert = await Alert.create({
      vehicleId:   vehicle._id,
      vehicleReg:  vehicle.vehicleReg,
      title:       isEntry ? `📍 Entered: ${fence.name}` : `🚧 Exited: ${fence.name}`,
      message:     isEntry
        ? `${vehicle.name} entered geofence "${fence.name}"`
        : `${vehicle.name} left geofence "${fence.name}"`,
      type, priority: 'high',
      latitude:    vehicle.latitude,
      longitude:   vehicle.longitude,
      speed:       vehicle.speed,
      pocName:     vehicle.pocName,
      pocContact:  vehicle.pocContact,
      vehicleType: vehicle.type,
      timestamp:   new Date(),
    });

    if (global.io) global.io.emit('newAlert', { ...alert.toObject(), id: alert._id.toString() });
  }

  // ── Dedup ─────────────────────────────────────────────────────────────────
  static _canAlert(vehicleId, type) {
    const key  = `${vehicleId}_${type}`;
    const last = alertDedup.get(key);
    if (last && Date.now() - last < DEDUP_MS) return false;
    alertDedup.set(key, Date.now());
    return true;
  }
}

// Clean dedup store every 30 min
setInterval(() => {
  const cut = Date.now() - DEDUP_MS;
  for (const [k, v] of alertDedup) if (v < cut) alertDedup.delete(k);
}, 30 * 60 * 1000);

// Geometry helpers
function isInsideFence(lat, lng, fence) {
  if (fence.geometry.type === 'Circle') {
    const d = geolib.getDistance(
      { latitude: lat, longitude: lng },
      { latitude: fence.geometry.center.latitude, longitude: fence.geometry.center.longitude }
    );
    return d <= fence.geometry.radius;
  }
  if (fence.geometry.type === 'Polygon') {
    return geolib.isPointInPolygon(
      { latitude: lat, longitude: lng },
      fence.geometry.coordinates.map(c => ({ latitude: c[0], longitude: c[1] }))
    );
  }
  return false;
}

module.exports = GPSEngine;