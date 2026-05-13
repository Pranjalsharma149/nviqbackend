'use strict';

/**
 * services/data.processor.js — FIXED VERSION
 *
 * FIXES APPLIED:
 *   FIX-1: needsGcjConversion = false for Wanway (they send WGS-84 already)
 *   FIX-2: Ignition field NOW included in socket.io emit
 *   FIX-3: Daily distance reset uses LOCAL timezone, not UTC
 *   FIX-4: Engine hours checks CURRENT ignition, not previous
 */

const logger        = require('../utils/logger');
const { haversineKm, isNoisePoint } = require('../utils/distance');

// ── GCJ-02 → WGS-84 ──────────────────────────────────────────────────────────
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

// ── FIX-6: Nominatim geocode queue (max 1 req/sec per ToS) ───────────────────
const _geocodeCache = new Map();
let   _geocodeQueue = Promise.resolve();

function _reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (_geocodeCache.has(key)) return Promise.resolve(_geocodeCache.get(key));

  // Chain each request so they execute serially with a 1s gap
  _geocodeQueue = _geocodeQueue
    .then(() => new Promise(resolve => setTimeout(resolve, 1050)))
    .then(async () => {
      try {
        const axios = require('axios');
        const res   = await axios.get('https://nominatim.openstreetmap.org/reverse', {
          params:  { lat, lon: lng, format: 'json', zoom: 18 },
          headers: { 'User-Agent': 'NVIQFleetServer/1.0' },
          timeout: 5000,
        });
        const addr = res.data?.display_name ?? null;
        if (addr) _geocodeCache.set(key, addr);
        return addr;
      } catch (_) {
        return null;
      }
    });

  return _geocodeQueue;
}

// ── Duplicate guard ───────────────────────────────────────────────────────────
const DEDUP_WINDOW_MS   = 10 * 1000;
const DEDUP_MIN_DIST_KM = 0.005;
const _lastStored       = new Map();

function _isDuplicate(imei, lat, lng, ts) {
  const prev = _lastStored.get(imei);
  if (!prev) return false;
  if ((ts - prev.ts) > DEDUP_WINDOW_MS) return false;
  return haversineKm(prev.lat, prev.lng, lat, lng) < DEDUP_MIN_DIST_KM;
}

function _markStored(imei, lat, lng, ts) {
  _lastStored.set(imei, { lat, lng, ts });
}

// ── FIX-2 + FIX-3: Daily distance accumulator ────────────────────────────────
const _dailyDist = new Map();

// ✅ FIX-3: Get TODAY STRING in LOCAL timezone, not UTC
function _getTodayStr() {
  const now = new Date();
  // Use local timezone, not UTC
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function _addDailyDistance(imei, lat, lng, speed) {
  const today = _getTodayStr();
  const prev  = _dailyDist.get(imei);

  // Reset on new UTC day
  if (!prev || prev.dateStr !== today) {
    _dailyDist.set(imei, { distKm: 0, lastLat: lat, lastLng: lng, dateStr: today });
    return 0;
  }

  let delta = 0;
  if (prev.lastLat != null && speed > 1) {
    const raw = haversineKm(prev.lastLat, prev.lastLng, lat, lng);
    if (!isNoisePoint(raw)) delta = raw;
  }

  const newDist = prev.distKm + delta;
  _dailyDist.set(imei, { distKm: newDist, lastLat: lat, lastLng: lng, dateStr: today });
  return newDist;
}

// FIX-7: Prune _dailyDist and _tripState once per day
setInterval(() => {
  const today = _getTodayStr();
  for (const [imei, rec] of _dailyDist.entries()) {
    if (rec.dateStr !== today) _dailyDist.delete(imei);
  }
  for (const [imei, state] of _tripState.entries()) {
    if (!state.tripId) _tripState.delete(imei);
  }
  logger.info('[Processor] Pruned daily accumulators');
}, 24 * 60 * 60 * 1000);

// ── Engine hours accumulator ──────────────────────────────────────────────────
const _engineHours = new Map();

// ✅ FIX-4: Check CURRENT ignition state, not previous
function _updateEngineHours(imei, ignitionOn, pointTs) {
  const today = _getTodayStr();
  const prev  = _engineHours.get(imei);

  if (!prev || prev.dateStr !== today) {
    _engineHours.set(imei, { hoursToday: 0, lastTs: pointTs, ignitionOn, dateStr: today });
    return 0;
  }

  let addedHours = 0;
  if (ignitionOn && prev.lastTs) {  // ✅ FIX-4: Check CURRENT ignitionOn, not prev.ignitionOn
    const elapsedMs = pointTs - prev.lastTs;
    // Sanity cap: don't add more than 1h per point (catches clock jumps)
    if (elapsedMs > 0 && elapsedMs < 60 * 60 * 1000) {
      addedHours = elapsedMs / (1000 * 3600);
    }
  }

  const newHours = prev.hoursToday + addedHours;
  _engineHours.set(imei, { hoursToday: newHours, lastTs: pointTs, ignitionOn, dateStr: today });
  return newHours;
}

// ── Trip detection state ──────────────────────────────────────────────────────
const TRIP_START_SPEED_KMH = 5;
const TRIP_IDLE_END_MS     = 3 * 60 * 1000;
const _tripState           = new Map();

async function _handleTripDetection({ vehicleId, imei, speed, lat, lng, timestamp, hasValidGPS }) {
  if (!vehicleId || !hasValidGPS) return;

  const Trip     = require('../models/Trip');
  const isMoving = speed > TRIP_START_SPEED_KMH;
  const prev     = _tripState.get(imei) ?? {
    tripId: null, idleSince: null,
    lastLat: null, lastLng: null,
    maxSpeed: 0, totalDistance: 0, speedReadings: [],
  };

  let segKm = 0;
  if (prev.lastLat != null && isMoving) {
    const raw = haversineKm(prev.lastLat, prev.lastLng, lat, lng);
    if (!isNoisePoint(raw)) segKm = raw;
  }

  const newTotal    = prev.totalDistance + segKm;
  const newMax      = Math.max(prev.maxSpeed, speed);
  const newReadings = isMoving ? [...prev.speedReadings, speed] : prev.speedReadings;

  if (isMoving) {
    let tripId = prev.tripId;
    if (!tripId) {
      try {
        const trip = await Trip.create({
          vehicleId, imei,
          startTime:     timestamp,
          startLocation: { latitude: lat, longitude: lng },
          isCompleted:   false,
        });
        tripId = trip._id;
        logger.info('🚗 Trip STARTED | imei=%s | tripId=%s', imei, tripId);
        if (global.io) {
          global.io.emit('trip_started', {
            tripId:    tripId.toString(),
            vehicleId: vehicleId.toString(),
            imei,
          });
        }
      } catch (err) {
        logger.error('❌ Trip create error [%s]: %s', imei, err.message);
      }
    }
    _tripState.set(imei, {
      tripId, idleSince: null,
      lastLat: lat, lastLng: lng,
      maxSpeed: newMax, totalDistance: newTotal, speedReadings: newReadings,
    });
    return;
  }

  const idleSince = prev.idleSince ?? new Date();
  if (!prev.tripId) {
    _tripState.set(imei, { ...prev, idleSince, lastLat: lat, lastLng: lng });
    return;
  }

  const idleMs = Date.now() - idleSince.getTime();
  if (idleMs < TRIP_IDLE_END_MS) {
    _tripState.set(imei, {
      ...prev, idleSince, lastLat: lat, lastLng: lng,
      maxSpeed: newMax, totalDistance: newTotal, speedReadings: newReadings,
    });
    return;
  }

  // Close the trip
  try {
    const avgSpeed = newReadings.length > 0
      ? newReadings.reduce((a, b) => a + b, 0) / newReadings.length
      : 0;

    const openTrip = await Trip.findById(prev.tripId);
    if (openTrip && !openTrip.isCompleted) {
      const duration = Math.max(0, Math.round((timestamp - openTrip.startTime) / 60000));
      openTrip.endTime       = timestamp;
      openTrip.duration      = duration;
      openTrip.endLocation   = { latitude: lat, longitude: lng };
      openTrip.totalDistance = parseFloat(newTotal.toFixed(3));
      openTrip.maxSpeed      = parseFloat(newMax.toFixed(1));
      openTrip.avgSpeed      = parseFloat(avgSpeed.toFixed(1));
      openTrip.isCompleted   = true;
      await openTrip.save();

      logger.info(
        '🏁 Trip ENDED | imei=%s | tripId=%s | %s km | %d min',
        imei, prev.tripId, newTotal.toFixed(2), duration
      );

      if (global.io) {
        global.io.emit('trip_ended', {
          tripId:        prev.tripId.toString(),
          vehicleId:     vehicleId.toString(),
          imei,
          totalDistance: openTrip.totalDistance,
          duration:      openTrip.duration,
        });
      }
    }
  } catch (err) {
    logger.error('❌ Trip end error [%s]: %s', imei, err.message);
  }

  _tripState.set(imei, {
    tripId: null, idleSince: null, lastLat: lat, lastLng: lng,
    maxSpeed: 0, totalDistance: 0, speedReadings: [],
  });
}

// ── Normalize WanWay payload → common schema ──────────────────────────────────
function _normalizeWanway(dev) {
  return {
    // Identity
    imei: String(dev.imei || dev.imeino || dev.deviceId || ''),

    // Coordinates
    rawLat:     dev.lat  ?? dev.latitude  ?? null,
    rawLng:     dev.lng  ?? dev.longitude ?? null,

    // Motion
    speed:      parseFloat(dev.speed   ?? 0),
    heading:    parseFloat(dev.course  ?? dev.heading ?? 0),

    // Vehicle info
    altitude:   parseFloat(dev.altitude ?? 0),
    satellites: parseInt(dev.satellites ?? dev.gpsNum ?? 0, 10),
    accuracy:   parseFloat(dev.accuracy ?? dev.hdop ?? 0),
    voltage:    dev.extVoltage != null ? dev.extVoltage / 10 : null,
    odometer:   dev.odometer ?? dev.mileage ?? null,

    // Ignition / ACC
    ignition:   dev.acc != null ? Boolean(Number(dev.acc)) : null,

    // Address if Wanway provided it
    address:    dev.address ?? dev.location ?? null,

    // Timestamps — data.processor.js handles staleness validation
    gpsTimestampMs:     dev.gpsTime    ? dev.gpsTime    * 1000 : null,
    signalTimestampMs:  dev.signalTime ? dev.signalTime * 1000 : null,

    source:             'wanway',
    // ✅ FIX-1: Wanway sends WGS-84 already, NOT GCJ-02
    needsGcjConversion: false,  // Changed from: true
  };
}

// ── Normalize TCP payload → common schema ─────────────────────────────────────
function _normalizeTcp(dev) {
  return {
    imei:       String(dev.imei || ''),
    rawLat:     dev.latitude  ?? dev.lat  ?? null,
    rawLng:     dev.longitude ?? dev.lng  ?? null,
    speed:      parseFloat(dev.speed   ?? 0),
    heading:    parseFloat(dev.heading ?? dev.course ?? 0),
    altitude:   parseFloat(dev.altitude ?? 0),
    satellites: parseInt(dev.satellites ?? 0, 10),
    accuracy:   parseFloat(dev.accuracy  ?? 0),
    voltage:    dev.voltage  ?? null,
    odometer:   dev.odometer ?? null,
    ignition:   dev.ignition ?? null,
    address:    null,
    gpsTimestampMs:     dev.gpsTimestamp ? new Date(dev.gpsTimestamp).getTime() : null,
    signalTimestampMs:  Date.now(),
    source:             'tcp',
    needsGcjConversion: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// processIncomingData — MAIN ENTRY POINT (single device)
// ─────────────────────────────────────────────────────────────────────────────
async function processIncomingData(rawDevice, source = 'wanway') {
  const Vehicle      = require('../models/Vehicle');
  const RawGpsLog    = require('../models/RawGpsLog');
  const LocationPing = require('../models/LocationPing');
  const now          = new Date();

  // 1. Normalize
  const dev = source === 'tcp' ? _normalizeTcp(rawDevice) : _normalizeWanway(rawDevice);

  if (!dev.imei) {
    logger.warn('⚠️ [Processor] Received device with no IMEI — skipped');
    return;
  }

  // 2. Timestamps
  const gpsTs    = dev.gpsTimestampMs    ? new Date(dev.gpsTimestampMs)    : now;
  const signalTs = dev.signalTimestampMs ? new Date(dev.signalTimestampMs) : now;

  // 3. Coordinate conversion
  let lat = dev.rawLat != null ? parseFloat(dev.rawLat) : null;
  let lng = dev.rawLng != null ? parseFloat(dev.rawLng) : null;

  if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
    if (lat === 0 && lng === 0) {
      logger.warn('⚠️ [Processor] Null-island (0,0) for IMEI=%s — coords nulled', dev.imei);
      lat = null; lng = null;
    } else if (dev.needsGcjConversion) {
      const wgs = gcj02ToWgs84(lng, lat);
      lat = wgs.lat; lng = wgs.lng;
    }
  }

  const hasValidGPS = lat != null && lng != null && !isNaN(lat) && !isNaN(lng);

  // 4. Online / status
  const isOnline = (Date.now() - signalTs.getTime()) < 5 * 60 * 1000;
  const status   = !isOnline ? 'offline' : dev.speed > TRIP_START_SPEED_KMH ? 'moving' : 'idle';

  // 5. Resolve vehicle
  const vehicle = await Vehicle.findOne({ imei: dev.imei })
    .select('_id imei lastKnownLocation')
    .lean();
  if (!vehicle) {
    logger.warn('⚠️ [Processor] Unknown IMEI=%s — not in DB', dev.imei);
    return;
  }
  const vehicleId = vehicle._id;

  // 6. Duplicate guard
  let isDuplicate = false;
  if (hasValidGPS) {
    isDuplicate = _isDuplicate(dev.imei, lat, lng, gpsTs.getTime());
    if (isDuplicate) {
      logger.debug('🔁 [Processor] Duplicate point skipped for IMEI=%s', dev.imei);
    } else {
      _markStored(dev.imei, lat, lng, gpsTs.getTime());
    }
  }

  // Compute running daily totals BEFORE writing to DB
  let todayDistKm = 0;
  let engineHrs   = 0;
  if (hasValidGPS && !isDuplicate) {
    todayDistKm = _addDailyDistance(dev.imei, lat, lng, dev.speed);
    engineHrs   = _updateEngineHours(dev.imei, dev.ignition === true, gpsTs.getTime());
  } else if (hasValidGPS) {
    // Duplicate point: return current accumulator without incrementing
    const dailyRec = _dailyDist.get(dev.imei);
    const engRec   = _engineHours.get(dev.imei);
    todayDistKm = dailyRec?.distKm   ?? 0;
    engineHrs   = engRec?.hoursToday ?? 0;
  }

  // 7a. Store RawGpsLog (unconditional — source of truth)
  if (hasValidGPS) {
    try {
      await RawGpsLog.create({
        imei:            dev.imei,
        vehicleId,
        latitude:        lat,
        longitude:       lng,
        speed:           dev.speed,
        heading:         dev.heading,
        ignition:        dev.ignition,
        status,
        source:          dev.source,
        gpsTimestamp:    gpsTs,
        serverTimestamp: now,
        satellites:      dev.satellites,
        accuracy:        dev.accuracy,
        voltage:         dev.voltage,
        odometer:        dev.odometer,
        isDuplicate,
      });
    } catch (err) {
      logger.error('❌ [Processor] RawGpsLog insert failed for IMEI=%s: %s', dev.imei, err.message);
    }
  }

  // 7b. Store LocationPing (queried by TripPlaybackController)
  if (hasValidGPS && !isDuplicate) {
    try {
      await LocationPing.create({
        vehicleId:        vehicleId.toString(),
        imei:             dev.imei,
        latitude:         lat,
        longitude:        lng,
        speed:            dev.speed,
        heading:          dev.heading,
        altitude:         dev.altitude,
        accuracy:         dev.accuracy,
        satellites:       dev.satellites,
        batteryVoltage:   dev.voltage,
        ignitionOn:       dev.ignition === true,
        gpsTime:          gpsTs,
        deviceTime:       now,
        address:          null,           // filled in after geocode below
        serverOdometerKm: dev.odometer ?? 0,
        todayDistance:    todayDistKm,
        engineHours:      engineHrs,
        source:           dev.source,
      });
    } catch (err) {
      logger.error('❌ [Processor] LocationPing insert failed for IMEI=%s: %s', dev.imei, err.message);
    }
  }

  // 8. Address resolution (async, non-blocking)
  let address = null;
  if (dev.address?.trim().length > 0) {
    address = dev.address.trim();
  } else if (hasValidGPS && !isDuplicate) {
    _reverseGeocode(lat, lng).then(async addr => {
      if (!addr) return;
      address = addr;
      try {
        await LocationPing.findOneAndUpdate(
          { vehicleId: vehicleId.toString(), gpsTime: gpsTs },
          { $set: { address: addr } }
        );
      } catch (_) {}
    }).catch(() => {});
  }

  if (!address && hasValidGPS) {
    address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  // 9. Update Vehicle latest state
  const vehicleUpdate = {
    speed:    dev.speed,
    heading:  dev.heading,
    isOnline, isLive: isOnline,
    lastUpdate: now,
    status,
    todayDistance:    todayDistKm,
    todayEngineHours: engineHrs,
  };

  if (hasValidGPS) {
    vehicleUpdate.latitude  = lat;
    vehicleUpdate.longitude = lng;
    vehicleUpdate.lat       = lat;
    vehicleUpdate.lng       = lng;
    vehicleUpdate.satellites = dev.satellites;
    vehicleUpdate.accuracy   = dev.accuracy;
    if (dev.voltage  != null) vehicleUpdate.voltage  = dev.voltage;
    if (dev.odometer != null) vehicleUpdate.odometer = dev.odometer;
    if (dev.ignition != null) vehicleUpdate.ignition = dev.ignition;
    vehicleUpdate.lastKnownLocation = {
      latitude:   lat,
      longitude:  lng,
      speed:      dev.speed,
      heading:    dev.heading,
      altitude:   dev.altitude,
      voltage:    dev.voltage,
      odometer:   dev.odometer,
      address:    address ?? null,
      timestamp:  gpsTs,
      serverTime: now,
    };
  }

  if (address) {
    vehicleUpdate.address           = address;
    vehicleUpdate.location          = address;
    vehicleUpdate.formattedLocation = address;
  }

  if (isOnline && hasValidGPS) vehicleUpdate.lastOnlineAt = gpsTs;

  try {
    await Vehicle.findByIdAndUpdate(vehicleId, {
      $set: vehicleUpdate,
      $max: { todayMaxSpeed: dev.speed },
    });
  } catch (err) {
    logger.error('❌ [Processor] Vehicle update failed for IMEI=%s: %s', dev.imei, err.message);
  }

  // ✅ FIX-2: 10. Socket.IO emit — NOW WITH IGNITION FIELD
  if (global.io && hasValidGPS) {
    global.io.emit('vehicleMovement', {
      id:               vehicleId.toString(),
      imei:             dev.imei,
      lat,  lng,
      latitude:         lat,
      longitude:        lng,
      speed:            dev.speed,
      heading:          dev.heading,
      isOnline,         isLive: isOnline,
      status,
      // ✅ FIX-2: ALL ignition aliases now included
      ignition:         dev.ignition,
      ignitionOn:       dev.ignition === true,
      acc:              dev.ignition,
      engineOn:         dev.ignition === true,
      engine:           dev.ignition,
      power:            dev.ignition,
      // End ignition aliases
      satellites:       dev.satellites,
      accuracy:         dev.accuracy,
      voltage:          dev.voltage,
      external_voltage: dev.voltage,
      bat_v:            dev.voltage,
      address,
      location:          address,
      formattedLocation: address,
      lastKnownLocation: vehicleUpdate.lastKnownLocation ?? null,
      gpsTime:           gpsTs.toISOString(),
      deviceTime:        now.toISOString(),
      lastUpdate:        now.toISOString(),
      source:            dev.source,
      todayDistance:    todayDistKm,
      todayKm:          todayDistKm,
      engineHours:      engineHrs,
    });
  }

  // 11. Trip detection (non-blocking)
  setImmediate(() => {
    _handleTripDetection({
      vehicleId, imei: dev.imei,
      speed: dev.speed, lat, lng,
      timestamp: gpsTs, hasValidGPS,
    }).catch(err =>
      logger.error('❌ [Processor] Trip detect error [%s]: %s', dev.imei, err.message)
    );
  });

  // FIX-8: Winston only supports %s/%d/%i/%o — not printf-style %.Nf.
  logger.info(
    '✅ [Processor] IMEI=%s | src=%s | lat=%s lng=%s | spd=%s | ign=%s | dup=%s | todayKm=%s | engH=%s',
    dev.imei,
    dev.source,
    lat?.toFixed(6) ?? 'null',
    lng?.toFixed(6) ?? 'null',
    dev.speed,
    dev.ignition,
    isDuplicate,
    todayDistKm.toFixed(2),
    engineHrs.toFixed(2)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// processBulkUpdates — batch entry point (used by wanway.poller.js)
// ─────────────────────────────────────────────────────────────────────────────
async function processBulkUpdates(deviceArray, source = 'wanway') {
  if (!Array.isArray(deviceArray) || deviceArray.length === 0) return;

  logger.info('📦 [Processor] Batch of %d devices from %s', deviceArray.length, source);

  const CONCURRENCY = 10;
  for (let i = 0; i < deviceArray.length; i += CONCURRENCY) {
    const chunk = deviceArray.slice(i, i + CONCURRENCY);
    await Promise.allSettled(chunk.map(dev => processIncomingData(dev, source)));
  }

  logger.info('✅ [Processor] Batch complete (%d devices)', deviceArray.length);
}

module.exports = { processIncomingData, processBulkUpdates };