'use strict';

const Vehicle      = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const geolib       = require('geolib');
const GPSEngine    = require('./geofenceController');
const logger       = require('../utils/logger');

// ── GCJ-02 (China Mars Coordinates) → WGS-84 converter ───────────────────────
// Shared converter — same logic as in data.processor.js.
// batchUpdate() receives inbound WanWay data that is also in GCJ-02 format.
function gcj02ToWgs84(gcjLng, gcjLat) {
  const a  = 6378245.0;
  const ee = 0.00669342162296594323;

  function transformLat(lng, lat) {
    let r = -100 + 2*lng + 3*lat + 0.2*lat*lat + 0.1*lng*lat + 0.2*Math.sqrt(Math.abs(lng));
    r += (20*Math.sin(6*lng*Math.PI) + 20*Math.sin(2*lng*Math.PI)) * 2/3;
    r += (20*Math.sin(lat*Math.PI)   + 40*Math.sin(lat/3*Math.PI)) * 2/3;
    r += (160*Math.sin(lat/12*Math.PI) + 320*Math.sin(lat*Math.PI/30)) * 2/3;
    return r;
  }

  function transformLng(lng, lat) {
    let r = 300 + lng + 2*lat + 0.1*lng*lng + 0.1*lng*lat + 0.1*Math.sqrt(Math.abs(lng));
    r += (20*Math.sin(6*lng*Math.PI) + 20*Math.sin(2*lng*Math.PI)) * 2/3;
    r += (20*Math.sin(lng*Math.PI)   + 40*Math.sin(lng/3*Math.PI)) * 2/3;
    r += (150*Math.sin(lng/12*Math.PI) + 300*Math.sin(lng/30*Math.PI)) * 2/3;
    return r;
  }

  const dLat      = transformLat(gcjLng - 105, gcjLat - 35);
  const dLng      = transformLng(gcjLng - 105, gcjLat - 35);
  const radLat    = gcjLat / 180 * Math.PI;
  let   magic     = Math.sin(radLat);
  magic           = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  return {
    lat: gcjLat - (dLat * 180) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI),
    lng: gcjLng - (dLng * 180) / (a / sqrtMagic * Math.cos(radLat) * Math.PI),
  };
}

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
        'lastUpdate', 'lastOnlineAt',    // ✅ FIX 2: was missing
        'lastKnownLocation',              // ✅ FIX 3: was missing — needed for offline vehicles
        'pocName', 'pocContact',
        'fuel', 'batteryLevel',
        'analytics',
      ].join(' '))
      .limit(2000)
      .lean();

    const data = vehicles.map(v => {
      // ✅ FIX 4: For offline vehicles, use lastKnownLocation coords if live
      // coords are default/missing. This is why Rajasthan coords weren't
      // showing — the map was getting the schema defaults (Delhi: 28.6139,
      // 77.2090) not the IOP GPS coords.
      const lkl          = v.lastKnownLocation;
      const hasLiveCoords = v.latitude && v.longitude &&
                            !(v.latitude === 28.6139 && v.longitude === 77.2090);

      const lat = hasLiveCoords ? v.latitude  : lkl?.latitude;
      const lng = hasLiveCoords ? v.longitude : lkl?.longitude;

      // ✅ FIX 5: Pre-compute offlineDuration so Flutter gets a ready-to-display string
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
        id:                v._id.toString(),
        name:              v.name,
        vehicleReg:        v.vehicleReg,
        type:              v.type,
        imei:              v.imei,

        // Raw live coords stored on vehicle document
        latitude:          v.latitude,
        longitude:         v.longitude,

        // ✅ Best coords for map marker — uses lastKnownLocation for offline vehicles
        lat,
        lng,

        speed:             v.speed,
        heading:           v.heading,
        status:            v.status,
        isOnline:          v.isOnline,
        isLive:            v.isLive,
        gpsSignal:         v.gpsSignal,
        location:          v.location,
        lastUpdate:        v.lastUpdate,
        lastOnlineAt:      v.lastOnlineAt,
        offlineDuration,               // pre-formatted: "3d 19h", "45m", null
        lastKnownLocation: lkl,        // full subdocument for vehicle detail screen
        pocName:           v.pocName,
        pocContact:        v.pocContact,
        fuel:              v.fuel,
        batteryLevel:      v.batteryLevel,
        analytics:         v.analytics,
        timestamp:         v.lastUpdate,
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
    const now     = new Date();

    for (const u of updates) {
      if (!u.imei) continue;

      const isOnline = u.isOnline !== undefined ? u.isOnline : true;

      // ✅ Parse raw coords from inbound payload first
      const rawLat = u.latitude  != null ? parseFloat(u.latitude)  : null;
      const rawLng = u.longitude != null ? parseFloat(u.longitude) : null;

      // ✅ Convert GCJ-02 → WGS-84 before storing
      const { lat, lng } = (rawLat != null && rawLng != null)
        ? gcj02ToWgs84(rawLng, rawLat)
        : { lat: rawLat, lng: rawLng };

      const hasValidGPS = lat != null && lng != null &&
                          !isNaN(lat) && !isNaN(lng) &&
                          !(lat === 0 && lng === 0);

      const baseSet = {
        latitude:       lat,               // ✅ WGS-84
        longitude:      lng,               // ✅ WGS-84
        speed:          u.speed    || 0,
        heading:        u.heading  || u.course || 0,
        status:         (u.speed || 0) > 2 ? 'moving' : 'static',
        isOnline,
        lastUpdate:     u.timestamp ? new Date(u.timestamp) : now,
        lastWanWaySync: now,
      };

      // Only snapshot lastKnownLocation when online + valid GPS
      if (isOnline && hasValidGPS) {
        baseSet.lastKnownLocation = {
          latitude:  lat,                  // ✅ WGS-84
          longitude: lng,                  // ✅ WGS-84
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
            lat:          vehicle.latitude,   // already WGS-84 from DB
            lng:          vehicle.longitude,  // already WGS-84 from DB
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
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }
    res.json({ success: true, data: vehicle });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};