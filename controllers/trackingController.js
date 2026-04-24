'use strict';

const Vehicle      = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const geolib       = require('geolib');
const GPSEngine    = require('./geofenceController');
const logger       = require('../utils/logger');

// ── GCJ-02 (China Mars Coordinates) → WGS-84 converter ───────────────────────
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

// ── Coord validity check ──────────────────────────────────────────────────────
// Returns true only if the coord is a real GPS fix, not null/NaN/zero/default.
// Known bad defaults:
//   • 0.0, 0.0       — schema default / never-set
//   • 28.6139, 77.209 — old hardcoded Delhi default
function isValidCoord(lat, lng) {
  if (lat == null || lng == null)       return false;
  if (isNaN(lat)  || isNaN(lng))        return false;
  if (lat === 0   && lng === 0)         return false;
  if (lat < -90   || lat > 90)         return false;
  if (lng < -180  || lng > 180)        return false;
  // Reject ALL coords within ~1 km of the old Delhi schema default
  if (Math.abs(lat - 28.6139) < 0.01 &&
      Math.abs(lng - 77.209)  < 0.01) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tracking/live
// Returns live fleet data to the Flutter app.
// Coord resolution order:
//   1. vehicle.latitude / vehicle.longitude  (live, written by poller)
//   2. lastKnownLocation.latitude / .longitude (last valid GPS fix)
//   3. null — Flutter will show world view, not 0,0 or phone GPS
// ─────────────────────────────────────────────────────────────────────────────
exports.getLiveVehicles = async (req, res) => {
  try {
    const vehicles = await Vehicle.find({})
      .select([
        'name', 'vehicleReg', 'type', 'imei',
        'latitude', 'longitude', 'speed', 'heading', 'status',
        'isOnline', 'isLive', 'gpsSignal', 'location',
        'lastUpdate', 'lastOnlineAt',
        'lastKnownLocation',
        'pocName', 'pocContact',
        'fuel', 'batteryLevel',
        'analytics',
        'formattedLocation',   // if your schema has this
        'lastGpsTime',         // if your schema has this
      ].join(' '))
      .limit(2000)
      .lean();

    const data = vehicles.map(v => {
      const lkl = v.lastKnownLocation;

      // ── Step 1: try live coords ───────────────────────────────────────────
      let lat = null;
      let lng = null;

      if (isValidCoord(v.latitude, v.longitude)) {
        lat = v.latitude;
        lng = v.longitude;
        logger.debug(`[tracking/live] ${v.vehicleReg || v._id} → live coords (${lat}, ${lng})`);
      }

      // ── Step 2: fall back to lastKnownLocation ────────────────────────────
      if (lat == null && isValidCoord(lkl?.latitude, lkl?.longitude)) {
        lat = lkl.latitude;
        lng = lkl.longitude;
        logger.debug(`[tracking/live] ${v.vehicleReg || v._id} → lastKnownLocation coords (${lat}, ${lng})`);
      }

      // ── Step 3: null — Flutter handles gracefully ─────────────────────────
      if (lat == null) {
        logger.warn(`[tracking/live] ${v.vehicleReg || v._id} → NO valid coords`);
      }

      // ── Offline duration string ───────────────────────────────────────────
      let offlineDuration = null;
      if (!v.isOnline && v.lastOnlineAt) {
        const ms           = Date.now() - new Date(v.lastOnlineAt).getTime();
        const totalMinutes = Math.floor(ms / 60000);
        const days         = Math.floor(totalMinutes / 1440);
        const hours        = Math.floor((totalMinutes % 1440) / 60);
        const minutes      = totalMinutes % 60;
        offlineDuration    = days  > 0 ? `${days}d ${hours}h`
                           : hours > 0 ? `${hours}h ${minutes}m`
                           :             `${minutes}m`;
      }

      // ── formattedLocation: prefer live address, fall back to LKL address ──
      const formattedLocation =
        v.formattedLocation ||
        v.location          ||
        lkl?.address        ||
        null;

      return {
        id:          v._id.toString(),
        name:        v.name,
        vehicleReg:  v.vehicleReg,
        type:        v.type,
        imei:        v.imei,

        // ✅ Best coords — Flutter uses these for the map marker
        lat,
        lng,

        // Raw live coords — kept for transparency / debugging
        latitude:  v.latitude,
        longitude: v.longitude,

        speed:     v.speed   || 0,
        heading:   v.heading || 0,
        status:    v.status,
        isOnline:  v.isOnline  ?? false,
        isLive:    v.isLive    ?? false,
        gpsSignal: v.gpsSignal ?? true,

        formattedLocation,          // ✅ Flutter reads this directly
        location:  v.location,
        lastUpdate:    v.lastUpdate,
        lastOnlineAt:  v.lastOnlineAt,
        lastGpsTime:   v.lastGpsTime || lkl?.timestamp || null,
        offlineDuration,

        // ✅ Full subdocument — Flutter vehicle detail screen uses this
        lastKnownLocation: lkl
          ? {
              latitude:  lkl.latitude,
              longitude: lkl.longitude,
              speed:     lkl.speed,
              heading:   lkl.heading,
              altitude:  lkl.altitude,
              voltage:   lkl.voltage,
              odometer:  lkl.odometer,
              address:   lkl.address,
              timestamp: lkl.timestamp,
            }
          : null,

        pocName:     v.pocName,
        pocContact:  v.pocContact,
        driverName:  v.pocName,    // alias Flutter also checks
        driverPhone: v.pocContact, // alias Flutter also checks
        fuel:        v.fuel        ?? 100,
        batteryLevel: v.batteryLevel,
        analytics:   v.analytics,
        timestamp:   v.lastUpdate,
      };
    });

    logger.info(`[tracking/live] Returned ${data.length} vehicles`);
    res.json({ success: true, count: data.length, data });

  } catch (error) {
    logger.error(`getLiveVehicles error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tracking/batch-update  (WanWay / IOP GPS Poller → Backend)
// ─────────────────────────────────────────────────────────────────────────────
exports.batchUpdate = async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({
        success: false, message: 'updates[] array is required',
      });
    }

    const bulkOps = [];
    const now     = new Date();

    for (const u of updates) {
      if (!u.imei) continue;

      const isOnline = u.isOnline !== undefined ? Boolean(u.isOnline) : true;

      // ── Parse raw GCJ-02 coords from poller ──────────────────────────────
      const rawLat = u.latitude  != null ? parseFloat(u.latitude)  : null;
      const rawLng = u.longitude != null ? parseFloat(u.longitude) : null;

      // ── Convert GCJ-02 → WGS-84 ──────────────────────────────────────────
      let lat = null, lng = null;
      if (rawLat != null && rawLng != null && !isNaN(rawLat) && !isNaN(rawLng)) {
        const wgs = gcj02ToWgs84(rawLng, rawLat);
        lat = wgs.lat;
        lng = wgs.lng;
      }

      const hasValidGPS = isValidCoord(lat, lng);

      // ── Determine vehicle status ──────────────────────────────────────────
      const speed  = parseFloat(u.speed) || 0;
      const status = speed > 2 ? 'moving' : isOnline ? 'idle' : 'offline';

      const baseSet = {
        speed,
        heading:        parseFloat(u.heading || u.course) || 0,
        status,
        isOnline,
        isLive:         isOnline,
        lastUpdate:     u.timestamp ? new Date(u.timestamp) : now,
        lastWanWaySync: now,
      };

      // ── Only write lat/lng when we have a real GPS fix ───────────────────
      // This prevents overwriting good coords with 0,0 on a bad packet.
      if (hasValidGPS) {
        baseSet.latitude  = lat;   // ✅ WGS-84
        baseSet.longitude = lng;   // ✅ WGS-84
        baseSet.gpsSignal = true;

        // ── Snapshot lastKnownLocation ────────────────────────────────────
        baseSet.lastKnownLocation = {
          latitude:  lat,
          longitude: lng,
          speed,
          heading:   baseSet.heading,
          voltage:   u.voltage  ?? null,
          odometer:  u.odometer ?? null,
          address:   u.address  ?? null,
          timestamp: u.timestamp ? new Date(u.timestamp) : now,
        };
        baseSet.lastOnlineAt = u.timestamp ? new Date(u.timestamp) : now;
        baseSet.lastGpsTime  = u.timestamp ? new Date(u.timestamp) : now;

      } else if (!isOnline) {
        // Device went offline — mark it but keep last known coords intact
        baseSet.gpsSignal = false;
      }

      bulkOps.push({
        updateOne: {
          filter: { imei: u.imei },
          update: { $set: baseSet },
          // ✅ upsert: false — never create ghost vehicles from poller data
          upsert: false,
        },
      });
    }

    if (bulkOps.length > 0) {
      const result = await Vehicle.bulkWrite(bulkOps, { ordered: false });
      logger.info(`batchUpdate: matched=${result.matchedCount} modified=${result.modifiedCount}`);

      // ── Emit socket events + check geofences ─────────────────────────────
      const updatedVehicles = await Vehicle.find({
        imei: { $in: updates.map(u => u.imei).filter(Boolean) },
      }).lean();

      for (const vehicle of updatedVehicles) {
        // Geofence check
        GPSEngine.checkGeofences(vehicle).catch(e =>
          logger.error(`Geofence [${vehicle.imei}]: ${e.message}`)
        );

        // ✅ Emit WGS-84 coords over socket — Flutter receives these
        if (global.io) {
          global.io.emit('vehicleMovement', {
            id:           vehicle._id.toString(),
            imei:         vehicle.imei,
            lat:          vehicle.latitude,    // WGS-84 from DB
            lng:          vehicle.longitude,   // WGS-84 from DB
            speed:        vehicle.speed,
            status:       vehicle.status,
            heading:      vehicle.heading,
            isOnline:     vehicle.isOnline,
            isLive:       vehicle.isLive,
            gpsSignal:    vehicle.gpsSignal,
            lastUpdate:   vehicle.lastUpdate,
            lastOnlineAt: vehicle.lastOnlineAt,
          });
        }
      }
    }

    res.json({
      success: true,
      message: `Processed ${bulkOps.length} updates`,
    });

  } catch (error) {
    logger.error(`batchUpdate error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tracking/history/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleHistory = async (req, res) => {
  try {
    const { start, end } = req.query;
    const query = { vehicleId: req.params.id };

    if (start && end) {
      query.timestamp = {
        $gte: new Date(start),
        $lte: new Date(end),
      };
    }

    const history = await LocationPing.find(query)
      .sort({ timestamp: 1 })
      .limit(2000)
      .lean();

    res.json({ success: true, count: history.length, data: history });

  } catch (error) {
    logger.error(`getVehicleHistory error: ${error.message}`);
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
      return res.status(404).json({
        success: false, message: 'Vehicle not found',
      });
    }
    res.json({ success: true, data: vehicle });

  } catch (error) {
    logger.error(`getVehicleById error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};