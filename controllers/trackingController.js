'use strict';

const Vehicle = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const geolib = require('geolib');
const GPSEngine = require('./geofenceController');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tracking — Fetch live fleet status for Flutter Map
// ─────────────────────────────────────────────────────────────────────────────
exports.getLiveVehicles = async (req, res) => {
  try {
    // ✅ FIX 1: Removed the 12-hour activeThreshold filter.
    // Offline vehicles must still appear on the map using lastKnownLocation.
    // The old filter was silently dropping any device offline > 12h.
    const vehicles = await Vehicle.find({})
      .select([
        'name', 'vehicleReg', 'type', 'imei',
        'latitude', 'longitude', 'speed', 'heading', 'status',
        'isOnline', 'isLive', 'gpsSignal', 'location',
        'lastUpdate', 'lastOnlineAt',   // ✅ FIX 2: was missing
        'lastKnownLocation',             // ✅ FIX 3: was missing — this is what the map needs for offline vehicles
        'pocName', 'pocContact',
        'fuel', 'batteryLevel',
        'analytics',
      ].join(' '))
      .limit(2000)
      .lean();

    const data = vehicles.map(v => {
      // ✅ FIX 4: For offline vehicles, use lastKnownLocation coords if live coords are default/missing.
      // This is why Rajasthan coords weren't showing — the map was getting
      // the schema defaults (Delhi: 28.6139, 77.2090) not the IOP GPS coords.
      const lkl = v.lastKnownLocation;
      const hasLiveCoords = v.latitude && v.longitude &&
                            !(v.latitude === 28.6139 && v.longitude === 77.2090);

      const lat = hasLiveCoords ? v.latitude  : lkl?.latitude;
      const lng = hasLiveCoords ? v.longitude : lkl?.longitude;

      // ✅ FIX 5: Compute offlineDuration here so Flutter gets a ready-to-display string
      let offlineDuration = null;
      if (!v.isOnline && v.lastOnlineAt) {
        const ms           = Date.now() - new Date(v.lastOnlineAt).getTime();
        const totalMinutes = Math.floor(ms / 60000);
        const days         = Math.floor(totalMinutes / 1440);
        const hours        = Math.floor((totalMinutes % 1440) / 60);
        const minutes      = totalMinutes % 60;
        offlineDuration    = days > 0
          ? `${days}d ${hours}h`
          : hours > 0
            ? `${hours}h ${minutes}m`
            : `${minutes}m`;
      }

      return {
        id:               v._id.toString(),
        name:             v.name,
        vehicleReg:       v.vehicleReg,
        type:             v.type,
        imei:             v.imei,

        // Live coords (may be defaults if device never moved while online)
        latitude:         v.latitude,
        longitude:        v.longitude,

        // ✅ Best coords for map marker — Rajasthan will show correctly now
        lat,
        lng,

        speed:            v.speed,
        heading:          v.heading,
        status:           v.status,
        isOnline:         v.isOnline,
        isLive:           v.isLive,
        gpsSignal:        v.gpsSignal,
        location:         v.location,
        lastUpdate:       v.lastUpdate,
        lastOnlineAt:     v.lastOnlineAt,
        offlineDuration,              // pre-formatted: "3d 19h", "45m", null
        lastKnownLocation: lkl,       // full subdocument for vehicle detail screen
        pocName:          v.pocName,
        pocContact:       v.pocContact,
        fuel:             v.fuel,
        batteryLevel:     v.batteryLevel,
        analytics:        v.analytics,
        timestamp:        v.lastUpdate,
      };
    });

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    logger.error(`getLiveVehicles error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tracking/batch-update (WanWay API Inbound)
// ─────────────────────────────────────────────────────────────────────────────
exports.batchUpdate = async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ success: false, message: 'updates[] array is required' });
    }

    const bulkOps = [];
    const now = new Date();

    for (const u of updates) {
      if (!u.imei) continue;

      const isOnline     = u.isOnline !== undefined ? u.isOnline : true;
      const hasValidGPS  = u.latitude && u.longitude &&
                           !(u.latitude === 0 && u.longitude === 0);

      const baseSet = {
        latitude:      u.latitude,
        longitude:     u.longitude,
        speed:         u.speed    || 0,
        heading:       u.heading  || u.course || 0,
        status:        u.speed > 2 ? 'moving' : 'static',
        isOnline,
        lastUpdate:    u.timestamp ? new Date(u.timestamp) : now,
        lastWanWaySync: now,
      };

      // Only snapshot lastKnownLocation when online + valid GPS
      if (isOnline && hasValidGPS) {
        baseSet.lastKnownLocation = {
          latitude:  u.latitude,
          longitude: u.longitude,
          speed:     u.speed    || 0,
          heading:   u.heading  || u.course || 0,
          voltage:   u.voltage  ?? null,
          odometer:  u.odometer ?? null,
          timestamp: u.timestamp ? new Date(u.timestamp) : now,
        };
        baseSet.lastOnlineAt = u.timestamp ? new Date(u.timestamp) : now;
      }

      bulkOps.push({
        updateOne: {
          filter: { imei: u.imei },
          update: { $set: baseSet },
        }
      });
    }

    if (bulkOps.length > 0) {
      await Vehicle.bulkWrite(bulkOps, { ordered: false });

      const updatedVehicles = await Vehicle.find({
        imei: { $in: updates.map(u => u.imei) }
      }).lean();

      for (const vehicle of updatedVehicles) {
        GPSEngine.checkGeofences(vehicle).catch(e =>
          logger.error(`Geofence Error [${vehicle.imei}]: ${e.message}`)
        );

        if (global.io) {
          global.io.emit('vehicleMovement', {
            id:           vehicle._id.toString(),
            imei:         vehicle.imei,
            lat:          vehicle.latitude,
            lng:          vehicle.longitude,
            speed:        vehicle.speed,
            status:       vehicle.status,
            heading:      vehicle.heading,
            isOnline:     vehicle.isOnline,
            lastUpdate:   vehicle.lastUpdate,
            lastOnlineAt: vehicle.lastOnlineAt,
          });
        }
      }
    }

    res.json({ success: true, message: `Processed ${bulkOps.length} updates` });
  } catch (error) {
    logger.error(`Batch Update Failed: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tracking/:id/history
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleHistory = async (req, res) => {
  try {
    const { start, end } = req.query;
    const query = { vehicleId: req.params.id };

    if (start && end) {
      query.timestamp = { $gte: new Date(start), $lte: new Date(end) };
    }

    const history = await LocationPing.find(query)
      .sort({ timestamp: 1 })
      .limit(2000)
      .lean();

    res.json({ success: true, count: history.length, data: history });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tracking/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleById = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id).lean();
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });
    res.json({ success: true, data: vehicle });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};