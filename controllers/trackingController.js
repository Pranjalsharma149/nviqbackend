'use strict';

const Vehicle      = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const RawGpsLog    = require('../models/RawGpsLog');
const GPSEngine    = require('./geofenceController');
const logger       = require('../utils/logger');

// ── GCJ-02 → WGS-84 ──────────────────────────────────────────────────────────
// This is not neccessory because the Wanway GPS is already providing wgs84 coordinates but gcj02 is required for other gps devices basically it is used in China. and It adds a purposeful random offset (shift) to GPS coordinates for security reasons

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

// ── Coord validity ────────────────────────────────────────────────────────────
function isValidCoord(lat, lng) {
  if (lat == null || lng == null) return false;
  if (isNaN(lat)  || isNaN(lng))  return false;
  if (lat === 0   && lng === 0)   return false;
  if (lat < -90   || lat > 90)    return false;
  if (lng < -180  || lng > 180)   return false;
  // Reject old hardcoded Delhi default
  if (Math.abs(lat - 28.6139) < 0.01 && Math.abs(lng - 77.209) < 0.01) return false;
  return true;
}

// ── Build socket payload — matches Flutter _onMovement field names ─────────────
// Flutter reads: id, vehicleId, imei, lat, lng, speed, heading, status,
//   isOnline, ignition/ignitionOn/acc/ACC, voltage/battery/bat,
//   satellites/sats, accuracy/hdop, gpsTime/timestamp/deviceTime,
//   todayDistance/todayKm, odometer/totalDistance, address
function buildSocketPayload(v) {
  return {
    // Identity — Flutter checks multiple field names
    id:        v._id.toString(),
    vehicleId: v._id.toString(),
    imei:      v.imei,
    IMEI:      v.imei,
    deviceId:  v.imei,

    // Coordinates
    lat:       v.latitude,
    lng:       v.longitude,
    latitude:  v.latitude,
    longitude: v.longitude,

    // Motion
    speed:     v.speed   ?? 0,
    heading:   v.heading ?? 0,
    course:    v.heading ?? 0,
    direction: v.heading ?? 0,
    status:    v.status  ?? 'offline',

    // Flutter FIX-3: ignition — all aliases
    ignition:    v.ignitionOn ?? false,
    ignitionOn:  v.ignitionOn ?? false,
    acc:         v.ignitionOn ?? false,
    ACC:         v.ignitionOn ?? false,
    engine:      v.ignitionOn ?? false,
    ignitionSince: v.ignitionSince ? new Date(v.ignitionSince).toISOString() : null,

    // Flutter FIX-2: battery voltage — all aliases
    voltage:          v.batteryVoltage ?? 0,
    battery:          v.batteryVoltage ?? 0,
    bat:              v.batteryVoltage ?? 0,
    external_voltage: v.batteryVoltage ?? 0,

    // GPS quality
    satellites: v.satellites ?? 0,
    sats:       v.satellites ?? 0,
    accuracy:   v.accuracy   ?? 0,
    hdop:       v.accuracy   ?? 0,

    // Online state
    isOnline: v.isOnline ?? false,
    isLive:   v.isLive   ?? false,

    // Timestamps — Flutter checks multiple field names
    gpsTime:    v.lastUpdate,
    timestamp:  v.lastUpdate,
    deviceTime: v.lastUpdate,
    dt:         v.lastUpdate,
    ts:         v.lastUpdate,

    // Flutter FIX-1: today distance — all aliases
    todayDistance:  v.todayDistance ?? 0,
    todayKm:        v.todayDistance ?? 0,
    today_km:       v.todayDistance ?? 0,
    dailyDistance:  v.todayDistance ?? 0,

    // Flutter FIX-4: odometer — all aliases
    odometer:      v.odometer ?? 0,
    mileage:       v.odometer ?? 0,
    totalDistance: v.odometer ?? 0,
    totalKm:       v.odometer ?? 0,

    // Address
    address:  v.address ?? v.lastKnownLocation?.address ?? '',
    location: v.address ?? '',

    lastUpdate:  v.lastUpdate,
    lastOnlineAt: v.lastOnlineAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tracking/live
// ─────────────────────────────────────────────────────────────────────────────
exports.getLiveVehicles = async (req, res) => {
  try {
    const vehicles = await Vehicle.find({})
      .select([
        'name', 'vehicleReg', 'type', 'imei', 'protocol',
        'latitude', 'longitude', 'speed', 'heading', 'status',
        'isOnline', 'isLive', 'ignitionOn', 'ignitionSince', 'batteryVoltage', 'satellites', 'accuracy',
        'address', 'lastUpdate', 'lastOnlineAt', 'lastKnownLocation',
        'todayDistance', 'todayEngineHours', 'todayMaxSpeed',
        'odometer', 'pocName', 'pocContact', 'speedLimit', 'analytics',
      ].join(' '))
      .limit(2000)
      .lean();

    const data = vehicles.map(v => {
      const lkl = v.lastKnownLocation;

      // Best coords: live → lastKnownLocation → null
      let lat = null, lng = null;
      if (isValidCoord(v.latitude, v.longitude)) {
        lat = v.latitude; lng = v.longitude;
      } else if (isValidCoord(lkl?.latitude, lkl?.longitude)) {
        lat = lkl.latitude; lng = lkl.longitude;
      }

      // Offline duration
      let offlineDuration = null;
      if (!v.isOnline && v.lastOnlineAt) {
        const ms  = Date.now() - new Date(v.lastOnlineAt).getTime();
        const min = Math.floor(ms / 60000);
        const d   = Math.floor(min / 1440);
        const h   = Math.floor((min % 1440) / 60);
        const m   = min % 60;
        offlineDuration = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
      }

      const address = v.address || lkl?.address || null;

      return {
        id:          v._id.toString(),
        vehicleId:   v._id.toString(),
        name:        v.name,
        vehicleReg:  v.vehicleReg,
        type:        v.type,
        vehicleTypeKey: v.type,
        imei:        v.imei,
        protocol:    v.protocol,

        // Coordinates
        lat, lng,
        latitude: lat, longitude: lng,

        // Motion
        speed:   v.speed   ?? 0,
        heading: v.heading ?? 0,
        status:  v.status  ?? 'offline',

        // Flutter FIX-3: ignition
        ignition:      v.ignitionOn ?? false,
        ignitionOn:    v.ignitionOn ?? false,
        acc:           v.ignitionOn ?? false,
        ignitionSince: v.ignitionSince ? new Date(v.ignitionSince).toISOString() : null,

        // Flutter FIX-2: battery
        batteryVoltage: v.batteryVoltage ?? 0,
        voltage:        v.batteryVoltage ?? 0,
        battery:        v.batteryVoltage ?? 0,

        satellites: v.satellites ?? 0,
        accuracy:   v.accuracy   ?? 0,

        isOnline: v.isOnline ?? false,
        isLive:   v.isLive   ?? false,

        // Address — all aliases Flutter checks
        address,
        location:             address,
        formattedLocation:    address,
        formattedLocationStr: address,
        liveAddress:          address,

        lastKnownLocation: lkl ? {
          latitude:  lkl.latitude,
          longitude: lkl.longitude,
          speed:     lkl.speed,
          heading:   lkl.heading,
          voltage:   lkl.voltage,
          odometer:  lkl.odometer,
          address:   lkl.address,
          timestamp: lkl.timestamp,
        } : (lat ? { latitude: lat, longitude: lng, address, timestamp: v.lastUpdate } : null),

        lastUpdate:     v.lastUpdate,
        lastGpsTime:    v.lastUpdate,
        lastOnlineAt:   v.lastOnlineAt,
        offlineDuration,

        // Flutter FIX-1: today distance
        todayDistanceKm:  v.todayDistance    ?? 0,
        todayDistance:    v.todayDistance    ?? 0,
        // Flutter FIX-4: odometer
        totalDistanceKm:  v.odometer         ?? 0,
        odometer:         v.odometer         ?? 0,
        // Flutter FIX-2: engine hours
        engineHoursToday: v.todayEngineHours ?? 0,
        todayEngineHours: v.todayEngineHours ?? 0,
        todayMaxSpeed:    v.todayMaxSpeed    ?? 0,

        pocName:    v.pocName    ?? '',
        pocContact: v.pocContact ?? '',
        speedLimit: v.speedLimit ?? 80,
        analytics:  v.analytics  ?? {},
        timestamp:  v.lastUpdate,
      };
    });

    res.json({ success: true, count: data.length, data });
  } catch (error) {
    logger.error('getLiveVehicles error: %s', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tracking/batch-update
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

      const isOnline = u.isOnline !== undefined ? Boolean(u.isOnline) : true;
      const rawLat   = u.latitude  != null ? parseFloat(u.latitude)  : null;
      const rawLng   = u.longitude != null ? parseFloat(u.longitude) : null;

      let lat = null, lng = null;
      if (rawLat != null && rawLng != null && !isNaN(rawLat) && !isNaN(rawLng)) {
        // const wgs = gcj02ToWgs84(rawLng, rawLat);
        lat =rawLat; 
        lng = rawLng;
      }

      const hasValidGPS = isValidCoord(lat, lng);
      const speed       = parseFloat(u.speed) || 0;
      const ignition    = u.acc != null ? Boolean(u.acc) : (u.ignition ?? false);
      const status      = speed > 2 ? 'moving' : (ignition ? 'idle' : 'offline');

      const baseSet = {
        speed,
        heading:        parseFloat(u.heading ?? u.course) || 0,
        ignitionOn:     ignition,
        batteryVoltage: parseFloat(u.voltage ?? u.extVoltage) || 0,
        satellites: parseInt(u.satellites ?? u.gpsNum ?? 0, 10),
        accuracy:   parseFloat(u.accuracy ?? u.hdop)   || 0,
        odometer:   parseFloat(u.odometer ?? u.mileage) || 0,
        status,
        isOnline,
        isLive: isOnline,
        lastUpdate: u.timestamp ? new Date(u.timestamp) : now,
      };

      if (hasValidGPS) {
        baseSet.latitude      = lat;
        baseSet.longitude     = lng;
        baseSet.gpsSignal     = true;
        baseSet.lastOnlineAt  = u.timestamp ? new Date(u.timestamp) : now;
        baseSet.address       = u.address ?? null;
        baseSet.lastKnownLocation = {
          latitude:  lat,
          longitude: lng,
          speed,
          heading:   baseSet.heading,
          voltage:   baseSet.batteryVoltage,
          odometer:  baseSet.odometer,
          address:   u.address ?? null,
          timestamp: u.timestamp ? new Date(u.timestamp) : now,
        };
      } else if (!isOnline) {
        baseSet.gpsSignal = false;
      }

      bulkOps.push({
        updateOne: {
          filter: { imei: u.imei },
          update: { $set: baseSet },
          upsert: false,
        },
      });
    }

    if (bulkOps.length > 0) {
      const result = await Vehicle.bulkWrite(bulkOps, { ordered: false });
      logger.info('batchUpdate: matched=%d modified=%d', result.matchedCount, result.modifiedCount);

      // Emit socket + geofence check
      const updatedVehicles = await Vehicle.find({
        imei: { $in: updates.map(u => u.imei).filter(Boolean) },
      }).lean();

      for (const vehicle of updatedVehicles) {
        GPSEngine.checkGeofences(vehicle).catch(e =>
          logger.error('Geofence [%s]: %s', vehicle.imei, e.message)
        );

        if (global.io) {
          global.io.emit('vehicle_movement', buildSocketPayload(vehicle));
          global.io.emit('vehicleMovement',  buildSocketPayload(vehicle));
        }
      }
    }

    res.json({ success: true, message: `Processed ${bulkOps.length} updates` });
  } catch (error) {
    logger.error('batchUpdate error: %s', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tracking/history/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleHistory = async (req, res) => {
  try {
    const { start, end, limit = 2000 } = req.query;
    const query = { vehicleId: req.params.id };

    if (start || end) {
      query.timestamp = {};
      if (start) query.timestamp.$gte = new Date(start);
      if (end)   query.timestamp.$lte = new Date(end);
    }

    // Try RawGpsLog first (richer data), fallback to LocationPing
    const rawCount = await RawGpsLog.countDocuments({ vehicleId: req.params.id });
    let history;

    if (rawCount > 0) {
      const rawQuery = { vehicleId: req.params.id, isDuplicate: false };
      if (start || end) {
        rawQuery.gpsTimestamp = {};
        if (start) rawQuery.gpsTimestamp.$gte = new Date(start);
        if (end)   rawQuery.gpsTimestamp.$lte = new Date(end);
      }
      history = await RawGpsLog.find(rawQuery)
        .sort({ gpsTimestamp: 1 })
        .limit(parseInt(limit))
        .select('latitude longitude speed heading ignition status gpsTimestamp source voltage')
        .lean();

      history = history.map(p => ({
        lat:       p.latitude,
        lng:       p.longitude,
        latitude:  p.latitude,
        longitude: p.longitude,
        speed:     p.speed,
        heading:   p.heading,
        ignition:  p.ignition,
        status:    p.status,
        timestamp: p.gpsTimestamp,
        deviceTime: p.gpsTimestamp,
        gpsTime:   p.gpsTimestamp,
        source:    p.source,
        voltage:   p.voltage,
      }));
    } else {
      history = await LocationPing.find(query)
        .sort({ timestamp: 1 })
        .limit(parseInt(limit))
        .lean();
    }

    res.json({ success: true, count: history.length, data: history });
  } catch (error) {
    logger.error('getVehicleHistory error: %s', error.message);
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
    res.json({ success: true, data: buildSocketPayload(vehicle) });
  } catch (error) {
    logger.error('getVehicleById error: %s', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};