'use strict';

const Vehicle = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const RawGpsLog = require('../models/RawGpsLog');
const GPSEngine = require('./geofenceController');
const logger = require('../utils/logger');

// ── GCJ-02 → WGS-84 ──────────────────────────────────────────────────────────
// This is not neccessory because the Wanway GPS is already providing wgs84 coordinates but gcj02 is required for other gps devices basically it is used in China. and It adds a purposeful random offset (shift) to GPS coordinates for security reasons

function gcj02ToWgs84(gcjLng, gcjLat) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;

  function transformLat(lng, lat) {
    let r = -100 + 2 * lng + 3 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
    r += (20 * Math.sin(6 * lng * Math.PI) + 20 * Math.sin(2 * lng * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(lat * Math.PI) + 40 * Math.sin(lat / 3 * Math.PI)) * 2 / 3;
    r += (160 * Math.sin(lat / 12 * Math.PI) + 320 * Math.sin(lat * Math.PI / 30)) * 2 / 3;
    return r;
  }

  function transformLng(lng, lat) {
    let r = 300 + lng + 2 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
    r += (20 * Math.sin(6 * lng * Math.PI) + 20 * Math.sin(2 * lng * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(lng * Math.PI) + 40 * Math.sin(lng / 3 * Math.PI)) * 2 / 3;
    r += (150 * Math.sin(lng / 12 * Math.PI) + 300 * Math.sin(lng / 30 * Math.PI)) * 2 / 3;
    return r;
  }

  const dLat = transformLat(gcjLng - 105, gcjLat - 35);
  const dLng = transformLng(gcjLng - 105, gcjLat - 35);
  const radLat = gcjLat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  return {
    lat: gcjLat - (dLat * 180) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI),
    lng: gcjLng - (dLng * 180) / (a / sqrtMagic * Math.cos(radLat) * Math.PI),
  };
}

// ── Coord validity ────────────────────────────────────────────────────────────
function isValidCoord(lat, lng) {
  if (lat == null || lng == null) return false;
  if (isNaN(lat) || isNaN(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
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
    id: v._id.toString(),
    vehicleId: v._id.toString(),
    imei: v.imei,
    IMEI: v.imei,
    deviceId: v.imei,

    // Coordinates
    lat: v.latitude,
    lng: v.longitude,
    latitude: v.latitude,
    longitude: v.longitude,

    // Motion
    speed: v.speed ?? 0,
    heading: v.heading ?? 0,
    course: v.heading ?? 0,
    direction: v.heading ?? 0,
    status: v.status ?? 'offline',

    // Flutter FIX-3: ignition — all aliases
    ignition: v.ignitionOn ?? false,
    ignitionOn: v.ignitionOn ?? false,
    acc: v.ignitionOn ?? false,
    ACC: v.ignitionOn ?? false,
    engine: v.ignitionOn ?? false,
    ignitionSince: v.ignitionSince ? new Date(v.ignitionSince).toISOString() : null,
    statusSince: v.statusSince ? new Date(v.statusSince).toISOString() : null,

    // Flutter FIX-2: battery voltage — all aliases
    voltage: v.batteryVoltage ?? 0,
    battery: v.batteryVoltage ?? 0,
    bat: v.batteryVoltage ?? 0,
    external_voltage: v.batteryVoltage ?? 0,

    // GPS quality
    satellites: v.satellites ?? 0,
    sats: v.satellites ?? 0,
    accuracy: v.accuracy ?? 0,
    hdop: v.accuracy ?? 0,

    // Online state
    isOnline: v.isOnline ?? false,
    isLive: v.isLive ?? false,

    // Timestamps — Flutter checks multiple field names
    gpsTime: v.lastUpdate,
    timestamp: v.lastUpdate,
    deviceTime: v.lastUpdate,
    dt: v.lastUpdate,
    ts: v.lastUpdate,

    // Flutter FIX-1: today distance — all aliases
    todayDistanceKm: v.todayDistance ?? 0,
    todayDistance: v.todayDistance ?? 0,
    todayKm: v.todayDistance ?? 0,
    today_km: v.todayDistance ?? 0,
    dailyDistance: v.todayDistance ?? 0,

    // Flutter FIX-4: odometer — all aliases
    odometer: v.odometer ?? 0,
    mileage: v.odometer ?? 0,
    totalDistance: v.odometer ?? 0,
    totalKm: v.odometer ?? 0,

    // Engine hours aliases
    engineHoursToday: v.todayEngineHours ?? 0,
    todayEngineHours: v.todayEngineHours ?? 0,
    engineHours: v.todayEngineHours ?? 0,

    // Running hours aliases
    todayRunningHours: v.todayRunningHours ?? 0,
    runningHoursToday: v.todayRunningHours ?? 0,
    runningHours: v.todayRunningHours ?? 0,

    // Today max speed
    todayMaxSpeed: v.todayMaxSpeed ?? 0,

    // Today idle time
    todayIdleTime: (() => {
      const totalSeconds = Math.round((v.todayIdleTime ?? 0) * 3600);
      const idleH = Math.floor(totalSeconds / 3600);
      const idleM = Math.floor((totalSeconds % 3600) / 60);
      const idleS = Math.round(totalSeconds % 60);
      return `${idleH}h ${idleM}m ${idleS}s`;
    })(),
    idleHours: v.todayIdleTime ?? 0,

    // Address
    address: v.address ?? v.lastKnownLocation?.address ?? '',
    location: v.address ?? '',

    lastKnownLocation: v.lastKnownLocation ? {
      latitude: v.lastKnownLocation.latitude,
      longitude: v.lastKnownLocation.longitude,
      lat: v.lastKnownLocation.latitude,
      long: v.lastKnownLocation.longitude,
      speed: v.lastKnownLocation.speed,
      heading: v.lastKnownLocation.heading,
      voltage: v.lastKnownLocation.voltage,
      odometer: v.lastKnownLocation.odometer,
      address: v.lastKnownLocation.address,
      locationName: v.lastKnownLocation.address || '',
      timestamp: v.lastKnownLocation.timestamp,
    } : (v.latitude ? {
      latitude: v.latitude,
      longitude: v.longitude,
      lat: v.latitude,
      long: v.longitude,
      speed: v.speed ?? 0,
      heading: v.heading ?? 0,
      voltage: v.batteryVoltage ?? 0,
      odometer: v.odometer ?? 0,
      address: v.address,
      locationName: v.address || '',
      timestamp: v.lastUpdate
    } : null),

    lastUpdate: v.lastUpdate,
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
        'isOnline', 'isLive', 'ignitionOn', 'ignitionSince', 'statusSince', 'batteryVoltage', 'satellites', 'accuracy',
        'address', 'lastUpdate', 'lastOnlineAt', 'lastKnownLocation',
        'todayDistance', 'todayEngineHours', 'todayRunningHours', 'todayMaxSpeed', 'todayIdleTime',
        'odometer', 'pocName', 'pocContact', 'speedLimit', 'analytics',
      ].join(' '))
      .limit(2000)
      .lean();

    // Calculate IST today boundaries
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const ist = new Date(utc + (3600000 * 5.5));
    const yr = ist.getFullYear();
    const mo = String(ist.getMonth() + 1).padStart(2, '0');
    const dy = String(ist.getDate()).padStart(2, '0');
    const istStart = new Date(Date.UTC(yr, mo - 1, dy - 1, 18, 30, 0, 0));
    const istEnd = new Date(Date.UTC(yr, mo - 1, dy, 18, 29, 59, 999));

    // 1. Calculate idle time for today for all vehicles from RawGpsLog
    const RawGpsLog = require('../models/RawGpsLog');
    const allPoints = await RawGpsLog.find({
      gpsTimestamp: { $gte: istStart, $lte: istEnd },
      isDuplicate: false
    })
      .sort({ gpsTimestamp: 1 })
      .select('vehicleId speed ignition gpsTimestamp latitude longitude')
      .lean();

    const pointsByVehicle = {};
    for (const p of allPoints) {
      if (!p.vehicleId) continue;
      const vidStr = p.vehicleId.toString();
      if (!pointsByVehicle[vidStr]) {
        pointsByVehicle[vidStr] = [];
      }
      pointsByVehicle[vidStr].push(p);
    }

    const idleMap = {};
    const distanceMap = {};
    const { haversineKm, isNoisePoint } = require('../utils/distance');

    for (const vidStr in pointsByVehicle) {
      const points = pointsByVehicle[vidStr];
      let idleSeconds = 0;
      let totalDist = 0;
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];

        const segSec = Math.min(
          Math.max((curr.gpsTimestamp - prev.gpsTimestamp) / 1000, 0),
          600
        );

        const ignOn = curr.ignition === true || prev.ignition === true || curr.speed > 0;
        if (ignOn && curr.speed <= 5) {
          idleSeconds += segSec;
        }

        // Calculate distance matching same movement filter logic as processor:
        if (ignOn && curr.speed > 1) {
          const distKm = haversineKm(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
          if (!isNoisePoint(distKm)) {
            totalDist += distKm;
          }
        }
      }
      idleMap[vidStr] = idleSeconds;
      distanceMap[vidStr] = parseFloat(totalDist.toFixed(3));
    }

    // 2. Fetch today's trips for all vehicles from Trip to calculate running time
    const Trip = require('../models/Trip');
    const allTrips = await Trip.find({
      startTime: { $gte: istStart, $lte: istEnd }
    }).lean();

    const tripsByVehicle = {};
    for (const t of allTrips) {
      if (!t.vehicleId) continue;
      const vidStr = t.vehicleId.toString();
      if (!tripsByVehicle[vidStr]) {
        tripsByVehicle[vidStr] = [];
      }
      tripsByVehicle[vidStr].push(t);
    }

    // Deduplicate function (same as historyController)
    function getUniqueRunningTimeMins(vehicleTrips) {
      if (!vehicleTrips || vehicleTrips.length === 0) return 0;
      const sorted = [...vehicleTrips].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
      const unique = [];

      for (const t of sorted) {
        if (unique.length === 0) {
          unique.push(t);
          continue;
        }

        const last = unique[unique.length - 1];
        const diffMs = Math.abs(new Date(t.startTime).getTime() - new Date(last.startTime).getTime());

        if (diffMs <= 60 * 1000) {
          last.duration = Math.max(last.duration || 0, t.duration || 0);
          if (t.endTime && (!last.endTime || new Date(t.endTime) > new Date(last.endTime))) {
            last.endTime = t.endTime;
          }
        } else {
          unique.push(t);
        }
      }

      let runningTimeMins = 0;
      for (const t of unique) {
        runningTimeMins += t.duration || 0;
      }
      return runningTimeMins;
    }

    const runningTimeMap = {};
    for (const vidStr in tripsByVehicle) {
      runningTimeMap[vidStr] = getUniqueRunningTimeMins(tripsByVehicle[vidStr]);
    }

    const data = vehicles.map(v => {
      const lkl = v.lastKnownLocation;
      const vidStr = v._id.toString();
      const correctIdleSeconds = idleMap[vidStr] ?? 0;
      const idleH = Math.floor(correctIdleSeconds / 3600);
      const idleM = Math.floor((correctIdleSeconds % 3600) / 60);
      const idleS = Math.round(correctIdleSeconds % 60);
      const idle_time = `${idleH}h ${idleM}m ${idleS}s`;
      
      const hasUpdatesToday = v.lastUpdate && new Date(v.lastUpdate) >= istStart;

      const currentDbIdle = v.todayIdleTime ?? 0;
      const currentDbRunning = v.todayRunningHours ?? 0;
      const currentDbDistance = v.todayDistance ?? 0;
      const currentDbEngine = v.todayEngineHours ?? 0;
      const currentDbMaxSpeed = v.todayMaxSpeed ?? 0;

      const targetIdle = hasUpdatesToday ? (correctIdleSeconds / 3600) : 0;

      // Calculate running time (same logic as history API)
      let runningTimeMins = Math.round(runningTimeMap[vidStr] ?? 0);
      if (runningTimeMins === 0 && hasUpdatesToday && v.todayRunningHours) {
        // Fallback to todayRunningHours in minutes if no trips recorded
        runningTimeMins = Math.round(v.todayRunningHours * 60);
      }
      const targetRunning = runningTimeMins / 60;
      const runH = Math.floor(runningTimeMins / 60);
      const runM = Math.floor(runningTimeMins % 60);
      const running_time = `${runH}h ${runM}m`;

      let targetDistance = hasUpdatesToday ? (distanceMap[vidStr] ?? 0) : 0;
      if (targetDistance === 0 && hasUpdatesToday && v.todayDistance) {
        targetDistance = v.todayDistance;
      }
      const targetEngine = hasUpdatesToday ? (v.todayEngineHours ?? 0) : 0;
      const targetMaxSpeed = hasUpdatesToday ? (v.todayMaxSpeed ?? 0) : 0;

      // Self-heal the database values if they are out of sync
      const needsUpdate = 
        (Math.abs(currentDbIdle - targetIdle) > 0.01) || 
        (Math.abs(currentDbRunning - targetRunning) > 0.01) ||
        (Math.abs(currentDbDistance - targetDistance) > 0.001) ||
        (Math.abs(currentDbEngine - targetEngine) > 0.01) ||
        (Math.abs(currentDbMaxSpeed - targetMaxSpeed) > 0.1);

      if (needsUpdate) {
        Vehicle.updateOne(
          { _id: v._id },
          {
            $set: {
              todayIdleTime: targetIdle,
              todayRunningHours: targetRunning,
              todayDistance: targetDistance,
              todayEngineHours: targetEngine,
              todayMaxSpeed: targetMaxSpeed
            }
          }
        ).catch(err =>
          logger.error('Failed to sync live metrics for vehicle %s: %s', vidStr, err.message)
        );
      }

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
        const ms = Date.now() - new Date(v.lastOnlineAt).getTime();
        const min = Math.floor(ms / 60000);
        const d = Math.floor(min / 1440);
        const h = Math.floor((min % 1440) / 60);
        const m = min % 60;
        offlineDuration = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
      }

      let parkingDuration = null;
      let parkingSeconds = 0;
      if (v.status !== 'moving' && v.statusSince) {
        const ms = Date.now() - new Date(v.statusSince).getTime();
        parkingSeconds = Math.floor(ms / 1000);
        const min = Math.floor(ms / 60000);
        const d = Math.floor(min / 1440);
        const h = Math.floor((min % 1440) / 60);
        const m = min % 60;
        parkingDuration = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
      }



      const address = v.address || lkl?.address || null;

      return {
        id: v._id.toString(),
        vehicleId: v._id.toString(),
        name: v.name,
        vehicleReg: v.vehicleReg,
        type: v.type,
        vehicleTypeKey: v.type,
        imei: v.imei,
        protocol: v.protocol,

        // Coordinates
        lat, lng,
        latitude: lat, longitude: lng,

        // Motion
        speed: v.speed ?? 0,
        heading: v.heading ?? 0,
        status: v.status ?? 'offline',

        // today idle time
        todayIdleTime: idle_time,
        idleTime: idle_time,
        idleHours: targetIdle,

        // Flutter FIX-3: ignition
        ignition: v.ignitionOn ?? false,
        ignitionOn: v.ignitionOn ?? false,
        acc: v.ignitionOn ?? false,
        ignitionSince: v.ignitionSince ? new Date(v.ignitionSince).toISOString() : null,
        statusSince: v.statusSince ? new Date(v.statusSince).toISOString() : null,

        // Flutter FIX-2: battery
        batteryVoltage: v.batteryVoltage ?? 0,
        voltage: v.batteryVoltage ?? 0,
        battery: v.batteryVoltage ?? 0,

        satellites: v.satellites ?? 0,
        accuracy: v.accuracy ?? 0,

        isOnline: v.isOnline ?? false,
        isLive: v.isLive ?? false,

        // Address — all aliases Flutter checks
        // address,
        // location: address,
        // formattedLocation: address,
        // formattedLocationStr: address,
        liveAddress: address,

        lastKnownLocation: lkl ? {
          latitude: lkl.latitude,
          longitude: lkl.longitude,
          lat: lkl.latitude,
          long: lkl.longitude,
          speed: lkl.speed,
          heading: lkl.heading,
          voltage: lkl.voltage,
          odometer: lkl.odometer,
          address: lkl.address,
          locationName: lkl.address || '',
          timestamp: lkl.timestamp,
        } : (lat ? {
          latitude: lat,
          longitude: lng,
          lat: lat,
          long: lng,
          speed: v.speed ?? 0,
          heading: v.heading ?? 0,
          voltage: v.batteryVoltage ?? 0,
          odometer: v.odometer ?? 0,
          address,
          locationName: address || '',
          timestamp: v.lastUpdate
        } : null),

        lastUpdate: v.lastUpdate,
        lastGpsTime: v.lastUpdate,
        lastOnlineAt: v.lastOnlineAt,
        offlineDuration,
        parkingDuration,
        parkingSeconds,
        parkingSince: v.status !== 'moving' && v.statusSince ? new Date(v.statusSince).toISOString() : null,

        // Flutter FIX-1: today distance
        todayDistanceKm: targetDistance,
        todayDistance: targetDistance,
        // Flutter FIX-4: odometer
        totalDistanceKm: targetDistance,
        odometer: v.odometer ?? 0,
        // Flutter FIX-2: engine hours
        engineHoursToday: targetEngine,
        todayEngineHours: targetEngine,
        todayRunningHours: targetRunning,
        runningHoursToday: (targetRunning),
        runningHours: targetRunning,
        running_time,
        runningTime: running_time,
        todayMaxSpeed: targetMaxSpeed,

        pocName: v.pocName ?? '',
        pocContact: v.pocContact ?? '',
        speedLimit: v.speedLimit ?? 80,
        analytics: v.analytics ?? {},
        timestamp: v.lastUpdate,
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
    const now = new Date();

    for (const u of updates) {
      if (!u.imei) continue;

      const isOnline = u.isOnline !== undefined ? Boolean(u.isOnline) : true;
      const rawLat = u.latitude != null ? parseFloat(u.latitude) : null;
      const rawLng = u.longitude != null ? parseFloat(u.longitude) : null;

      let lat = null, lng = null;
      if (rawLat != null && rawLng != null && !isNaN(rawLat) && !isNaN(rawLng)) {
        // const wgs = gcj02ToWgs84(rawLng, rawLat);
        lat = rawLat;
        lng = rawLng;
      }

      const hasValidGPS = isValidCoord(lat, lng);
      const speed = parseFloat(u.speed) || 0;
      const ignition = u.acc != null ? Boolean(u.acc) : (u.ignition ?? false);
      const status = speed > 2 ? 'moving' : (ignition ? 'idle' : 'offline');
      const previousStatus = u.status || 'offline';
      let currentStatus = status;


      const baseSet = {
        speed,
        heading: parseFloat(u.heading ?? u.course) || 0,
        ignitionOn: ignition,
        batteryVoltage: parseFloat(u.voltage ?? u.extVoltage) || 0,
        satellites: parseInt(u.satellites ?? u.gpsNum ?? 0, 10),
        accuracy: parseFloat(u.accuracy ?? u.hdop) || 0,
        odometer: parseFloat(u.odometer ?? u.mileage) || 0,
        status,
        isOnline,
        isLive: isOnline,
        lastUpdate: u.timestamp ? new Date(u.timestamp) : now,
      };

      if (u.todayIdleTime !== undefined) {
        baseSet.todayIdleTime = u.todayIdleTime;
      }

      if (hasValidGPS) {
        baseSet.latitude = lat;
        baseSet.longitude = lng;
        baseSet.gpsSignal = true;
        baseSet.lastOnlineAt = u.timestamp ? new Date(u.timestamp) : now;

        baseSet['lastKnownLocation.latitude'] = lat;
        baseSet['lastKnownLocation.longitude'] = lng;
        baseSet['lastKnownLocation.lat'] = lat;
        baseSet['lastKnownLocation.long'] = lng;
        baseSet['lastKnownLocation.speed'] = speed;
        baseSet['lastKnownLocation.heading'] = baseSet.heading;
        baseSet['lastKnownLocation.voltage'] = baseSet.batteryVoltage;
        baseSet['lastKnownLocation.odometer'] = baseSet.odometer;
        baseSet['lastKnownLocation.timestamp'] = u.timestamp ? new Date(u.timestamp) : now;

        if (u.address) {
          baseSet.address = u.address;
          baseSet.location = u.address;
          baseSet['lastKnownLocation.address'] = u.address;
          baseSet['lastKnownLocation.locationName'] = u.address;
        }
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
          global.io.emit('vehicleMovement', buildSocketPayload(vehicle));
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
      if (end) query.timestamp.$lte = new Date(end);
    }

    // Try RawGpsLog first (richer data), fallback to LocationPing
    const rawCount = await RawGpsLog.countDocuments({ vehicleId: req.params.id });
    let history;

    if (rawCount > 0) {
      const rawQuery = { vehicleId: req.params.id, isDuplicate: false };
      if (start || end) {
        rawQuery.gpsTimestamp = {};
        if (start) rawQuery.gpsTimestamp.$gte = new Date(start);
        if (end) rawQuery.gpsTimestamp.$lte = new Date(end);
      }
      history = await RawGpsLog.find(rawQuery)
        .sort({ gpsTimestamp: 1 })
        .limit(parseInt(limit))
        .select('latitude longitude speed heading ignition status gpsTimestamp source voltage')
        .lean();

      history = history.map(p => ({
        lat: p.latitude,
        lng: p.longitude,
        latitude: p.latitude,
        longitude: p.longitude,
        speed: p.speed,
        heading: p.heading,
        ignition: p.ignition,
        status: p.status,
        timestamp: p.gpsTimestamp,
        deviceTime: p.gpsTimestamp,
        gpsTime: p.gpsTimestamp,
        source: p.source,
        voltage: p.voltage,
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