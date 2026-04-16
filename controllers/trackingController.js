// controllers/trackingController.js
'use strict';

const Vehicle      = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const geolib       = require('geolib');
const GPSEngine    = require('../services/gps.engine');

// ── In-memory vehicle state cache — O(1) reads for 1000+ vehicles ─────────────
// Populated by GPS server; used by getLiveVehicles for zero-DB-latency response
if (!global.vehicleStates) global.vehicleStates = {};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tracking  — all live / recently active vehicles
// Flutter: ApiService.fetchLiveVehicles()
// ─────────────────────────────────────────────────────────────────────────────
exports.getLiveVehicles = async (req, res) => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const vehicles = await Vehicle.find({
      $or: [{ isOnline: true }, { lastUpdate: { $gte: fiveMinutesAgo } }],
    }).sort({ lastUpdate: -1 }).limit(200).lean();

    const data = vehicles.map(v => ({
      ...v,
      id:           v._id.toString(),
      lat:          v.latitude,
      lng:          v.longitude,
      speed:        Number(v.speed)        || 0,
      fuel:         Number(v.fuel)         || 0,
      batteryLevel: Number(v.batteryLevel) || 0,
      heading:      Number(v.heading)      || 0,
      driverName:   v.pocName,
      driverPhone:  v.pocContact,
      timestamp:    v.lastUpdate,
      gps:          v.gpsSignal,
    }));

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tracking/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleTracking = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id).lean();
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });

    const formatted = {
      ...vehicle,
      id:  vehicle._id.toString(),
      lat: vehicle.latitude,
      lng: vehicle.longitude,
      speed:        Number(vehicle.speed)        || 0,
      fuel:         Number(vehicle.fuel)         || 0,
      batteryLevel: Number(vehicle.batteryLevel) || 0,
      heading:      Number(vehicle.heading)      || 0,
      driverName:   vehicle.pocName,
      driverPhone:  vehicle.pocContact,
      timestamp:    vehicle.lastUpdate,
      gps:          vehicle.gpsSignal,
    };

    res.json({ success: true, data: formatted });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tracking/update
// HTTP GPS update endpoint (fallback when TCP is unavailable)
// ─────────────────────────────────────────────────────────────────────────────
exports.updatePosition = async (req, res) => {
  try {
    const {
      vehicleReg, latitude, longitude, speed, heading,
      fuel, batteryLevel, status, gpsSignal, timestamp,
      altitude, location,
    } = req.body;

    if (!vehicleReg) {
      return res.status(400).json({ success: false, message: 'vehicleReg is required' });
    }

    // Upsert vehicle
    let vehicle = await Vehicle.findOneAndUpdate(
      { vehicleReg },
      {
        $set: {
          latitude:     latitude     ?? 0,
          longitude:    longitude    ?? 0,
          altitude:     altitude     ?? 0,
          speed:        speed        ?? 0,
          heading:      heading      ?? 0,
          fuel:         fuel         ?? undefined,
          batteryLevel: batteryLevel ?? undefined,
          gpsSignal:    gpsSignal    ?? true,
          status:       status       || (speed > 5 ? 'moving' : 'idle'),
          isLive:   true,
          isOnline: true,
          location: location || undefined,
          lastUpdate: timestamp ? new Date(timestamp) : new Date(),
        },
      },
      { new: true, upsert: false }  // don't create via HTTP — use registerVehicle instead
    );

    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found — register it first via POST /api/vehicles' });
    }

    // Update in-memory cache
    global.vehicleStates[vehicleReg] = {
      lat: vehicle.latitude, lng: vehicle.longitude,
      speed: vehicle.speed, heading: vehicle.heading,
      status: vehicle.status, lastUpdate: vehicle.lastUpdate,
    };

    // Persist ping (async — don't await, keeps response fast)
    LocationPing.create({
      vehicleId:    vehicle._id,
      latitude:     vehicle.latitude,
      longitude:    vehicle.longitude,
      altitude:     altitude ?? 0,
      speed:        vehicle.speed,
      heading:      vehicle.heading,
      fuel:         vehicle.fuel,
      batteryLevel: vehicle.batteryLevel,
      status:       vehicle.status,
      gpsSignal:    vehicle.gpsSignal,
      timestamp:    vehicle.lastUpdate,
    }).catch(err => console.error('LocationPing save error:', err.message));

    // Run alert engine (async)
    GPSEngine.processUpdate(vehicle).catch(err => console.error('GPS engine error:', err.message));

    // Emit via socket
    if (req.io) {
      req.io.emit('vehicleMovement', {
        vehicleId:  vehicle._id.toString(),
        id:         vehicle._id.toString(),
        vehicleReg: vehicle.vehicleReg,
        lat:        vehicle.latitude,
        lng:        vehicle.longitude,
        speed:      vehicle.speed,
        heading:    vehicle.heading,
        status:     vehicle.status,
        isLive:     true,
        gpsSignal:  vehicle.gpsSignal,
        lastUpdate: vehicle.lastUpdate.toISOString(),
        location:   vehicle.location,
      });
    }

    res.json({ success: true, message: 'Position updated', vehicleId: vehicle._id });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tracking/:id/history
// ─────────────────────────────────────────────────────────────────────────────
exports.getHistory = async (req, res) => {
  try {
    const { days = 7, limit = 500 } = req.query;
    const startDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);

    const pings = await LocationPing.find({
      vehicleId: req.params.id,
      timestamp: { $gte: startDate },
    }).sort({ timestamp: 1 }).limit(parseInt(limit)).lean();

    if (pings.length === 0) {
      return res.json({ success: true, data: {
        totalDistance: 0, totalTrips: 0, avgSpeed: 0, maxSpeed: 0,
        movingTime: 0, idleTime: 0, stops: [], pings: [],
        period: { start: startDate.toISOString(), end: new Date().toISOString() },
      }});
    }

    let totalDistance = 0, totalSpeed = 0, speedCount = 0, maxSpeed = 0;
    let movingTime = 0, idleTime = 0;
    const stops = [];

    for (let i = 1; i < pings.length; i++) {
      const prev = pings[i - 1], curr = pings[i];
      totalDistance += geolib.getDistance(
        { latitude: prev.latitude, longitude: prev.longitude },
        { latitude: curr.latitude, longitude: curr.longitude }
      );
      if (curr.speed > 0) { totalSpeed += curr.speed; speedCount++; }
      if (curr.speed > maxSpeed) maxSpeed = curr.speed;

      const timeDiffMin = (curr.timestamp - prev.timestamp) / (1000 * 60);
      if (curr.speed > 5) {
        movingTime += timeDiffMin;
      } else {
        idleTime += timeDiffMin;
        // Record stop if idle > 5 min and not already nearby
        if (timeDiffMin > 5) {
          const alreadyRecorded = stops.some(s =>
            geolib.getDistance(
              { latitude: s.latitude, longitude: s.longitude },
              { latitude: curr.latitude, longitude: curr.longitude }
            ) < 50
          );
          if (!alreadyRecorded) {
            stops.push({
              latitude:  curr.latitude,
              longitude: curr.longitude,
              startTime: prev.timestamp,
              duration:  timeDiffMin,
            });
          }
        }
      }
    }

    res.json({ success: true, data: {
      totalDistance: (totalDistance / 1000).toFixed(2),
      totalTrips:    0,
      avgSpeed:      speedCount > 0 ? (totalSpeed / speedCount).toFixed(1) : 0,
      maxSpeed:      maxSpeed.toFixed(1),
      movingTime:    movingTime.toFixed(0),
      idleTime:      idleTime.toFixed(0),
      stops:         stops.slice(0, 20),
      pings:         pings.map(p => ({
        timestamp: p.timestamp, lat: p.latitude, lng: p.longitude,
        speed: p.speed, heading: p.heading, status: p.status,
      })),
      period: {
        start: pings[0].timestamp.toISOString(),
        end:   pings[pings.length - 1].timestamp.toISOString(),
      },
    }});
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tracking/batch-update
// ─────────────────────────────────────────────────────────────────────────────
exports.batchUpdate = async (req, res) => {
  try {
    const updates = req.body.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ success: false, message: 'updates[] is required' });
    }

    // Build bulk ops — single DB round trip for all vehicles
    const bulkOps = [];
    const pingDocs = [];

    for (const u of updates) {
      if (!u.vehicleReg) continue;
      const ts     = u.timestamp ? new Date(u.timestamp) : new Date();
      const status = u.status || (u.speed > 5 ? 'moving' : 'idle');

      bulkOps.push({
        updateOne: {
          filter: { vehicleReg: u.vehicleReg },
          update: {
            $set: {
              latitude:  u.latitude,  longitude: u.longitude,
              speed:     u.speed,     heading:   u.heading,
              status, isLive: true, isOnline: true, lastUpdate: ts,
            },
          },
        },
      });

      pingDocs.push({
        vehicleId: null,   // will be filled below after bulk write
        vehicleReg: u.vehicleReg,
        latitude: u.latitude, longitude: u.longitude,
        speed: u.speed, heading: u.heading,
        status, timestamp: ts,
      });
    }

    if (bulkOps.length === 0) {
      return res.json({ success: true, message: 'No valid updates', data: [] });
    }

    await Vehicle.bulkWrite(bulkOps, { ordered: false });

    // Fetch updated vehicles to get their _ids for pings and socket emit
    const regs     = updates.map(u => u.vehicleReg).filter(Boolean);
    const vehicles = await Vehicle.find({ vehicleReg: { $in: regs } }, '_id vehicleReg latitude longitude speed heading status').lean();
    const idMap    = new Map(vehicles.map(v => [v.vehicleReg, v]));

    const pingsToInsert = pingDocs
      .map(p => {
        const v = idMap.get(p.vehicleReg);
        if (!v) return null;
        return { vehicleId: v._id, latitude: p.latitude, longitude: p.longitude, speed: p.speed, heading: p.heading, status: p.status, timestamp: p.timestamp };
      })
      .filter(Boolean);

    if (pingsToInsert.length > 0) {
      LocationPing.insertMany(pingsToInsert, { ordered: false })
        .catch(err => console.error('Batch ping insert error:', err.message));
    }

    // Emit socket events
    if (req.io) {
      for (const v of vehicles) {
        req.io.emit('vehicleMovement', {
          vehicleId: v._id.toString(), vehicleReg: v.vehicleReg,
          lat: v.latitude, lng: v.longitude,
          speed: v.speed, heading: v.heading,
          status: v.status, isLive: true,
          lastUpdate: new Date().toISOString(),
        });
      }
    }

    res.json({ success: true, message: `Processed ${bulkOps.length} updates`, data: vehicles.map(v => ({ vehicleReg: v.vehicleReg, success: true })) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};