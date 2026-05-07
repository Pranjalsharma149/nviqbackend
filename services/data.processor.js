'use strict';

/**
 * services/data.processor.js
 *
 * UNIFIED DATA PIPELINE — single entry point for ALL GPS data.
 *
 * Responsibilities (in order):
 *   1. Normalize TCP / WanWay payloads into a common schema
 *   2. Convert GCJ-02 → WGS-84
 *   3. Convert timestamps (WanWay seconds → ms)
 *   4. Validate coordinates
 *   5. Duplicate guard (time + distance threshold)
 *   6. *** UNCONDITIONALLY store RawGpsLog ***
 *   7. Update Vehicle latest-state document
 *   8. Emit Socket.IO event
 *   9. Trigger trip detection
 *
 * CRITICAL RULES:
 *   - Every valid GPS point is stored — no speed filter, no idle skip
 *   - RawGpsLog is NEVER updated/overwritten, only inserted
 *   - All coordinate conversion happens HERE, not in callers
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

// ── Reverse geocode cache (Nominatim) ─────────────────────────────────────────
const _geocodeCache = new Map();

async function _reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (_geocodeCache.has(key)) return _geocodeCache.get(key);

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
}

// ── Duplicate guard ───────────────────────────────────────────────────────────
// In-memory: { imei → { lat, lng, ts } }
// A point is a duplicate if it arrives within DEDUP_WINDOW_MS AND
// is closer than DEDUP_MIN_DIST_KM to the previous stored point.
const DEDUP_WINDOW_MS    = 10 * 1000;          // 10 seconds
const DEDUP_MIN_DIST_KM  = 0.005;              // 5 metres
const _lastStored        = new Map();

function _isDuplicate(imei, lat, lng, ts) {
  const prev = _lastStored.get(imei);
  if (!prev) return false;

  const ageDiff  = ts - prev.ts;
  if (ageDiff > DEDUP_WINDOW_MS) return false;   // old enough — always accept

  const distKm = haversineKm(prev.lat, prev.lng, lat, lng);
  return distKm < DEDUP_MIN_DIST_KM;
}

function _markStored(imei, lat, lng, ts) {
  _lastStored.set(imei, { lat, lng, ts });
}

// ── Trip detection state ───────────────────────────────────────────────────────
const TRIP_START_SPEED_KMH = 5;
const TRIP_IDLE_END_MS     = 3 * 60 * 1000;   // 3 minutes of speed=0 ends trip

const _tripState = new Map();   // imei → TripState

async function _handleTripDetection({ vehicleId, imei, speed, lat, lng, timestamp, hasValidGPS }) {
  if (!vehicleId || !hasValidGPS) return;

  const Trip = require('../models/Trip');
  const isMoving = speed > TRIP_START_SPEED_KMH;
  const prev = _tripState.get(imei) ?? {
    tripId: null, idleSince: null,
    lastLat: null, lastLng: null,
    maxSpeed: 0, totalDistance: 0, speedReadings: [],
  };

  // Segment distance
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
          vehicleId,
          imei,
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

  // Vehicle is NOT moving
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
        '🏁 Trip ENDED | imei=%s | tripId=%s | %.2f km | %d min | max=%.1f km/h',
        imei, prev.tripId, newTotal, duration, newMax
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
    tripId: null, idleSince: null,
    lastLat: lat, lastLng: lng,
    maxSpeed: 0, totalDistance: 0, speedReadings: [],
  });
}

// ── Normalize WanWay payload → common schema ──────────────────────────────────
function _normalizeWanway(dev) {
  return {
    imei:         String(dev.imei || dev.imeino || dev.deviceId || ''),
    rawLat:       dev.lat  ?? dev.latitude  ?? null,
    rawLng:       dev.lng  ?? dev.longitude ?? null,
    speed:        parseFloat(dev.speed  ?? 0),
    heading:      parseFloat(dev.course ?? dev.heading ?? 0),
    satellites:   parseInt(dev.satellites ?? dev.gpsNum ?? 0, 10),
    accuracy:     parseFloat(dev.accuracy ?? dev.hdop   ?? 0),
    voltage:      dev.extVoltage != null ? dev.extVoltage / 10 : null,
    odometer:     dev.odometer ?? dev.mileage ?? null,
    ignition:     dev.acc != null ? Boolean(dev.acc) : null,
    address:      dev.address ?? dev.location ?? null,
    // WanWay timestamps are Unix seconds → convert to ms
    gpsTimestampMs:    dev.gpsTime    ? dev.gpsTime    * 1000 : null,
    signalTimestampMs: dev.signalTime ? dev.signalTime * 1000 : null,
    source:       'wanway',
    needsGcjConversion: true,
  };
}

// ── Normalize TCP payload → common schema ─────────────────────────────────────
function _normalizeTcp(dev) {
  // TCP devices already pass WGS-84 via gps.server.js's gcj02ToWgs84 call.
  // Coordinates arrive as { latitude, longitude } already converted.
  return {
    imei:          String(dev.imei || ''),
    rawLat:        dev.latitude  ?? dev.lat  ?? null,
    rawLng:        dev.longitude ?? dev.lng  ?? null,
    speed:         parseFloat(dev.speed   ?? 0),
    heading:       parseFloat(dev.heading ?? dev.course ?? 0),
    satellites:    parseInt(dev.satellites ?? 0, 10),
    accuracy:      parseFloat(dev.accuracy  ?? 0),
    voltage:       dev.voltage  ?? null,
    odometer:      dev.odometer ?? null,
    ignition:      dev.ignition ?? null,
    address:       null,
    gpsTimestampMs:    dev.gpsTimestamp ? new Date(dev.gpsTimestamp).getTime() : null,
    signalTimestampMs: Date.now(),
    source:        'tcp',
    needsGcjConversion: false,  // Already converted by gps.server.js
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// processIncomingData — MAIN ENTRY POINT (single device)
// Called by both gps.server.js (TCP) and wanway.poller.js
// ─────────────────────────────────────────────────────────────────────────────
async function processIncomingData(rawDevice, source = 'wanway') {
  const Vehicle   = require('../models/Vehicle');
  const RawGpsLog = require('../models/RawGpsLog');
  const now       = new Date();

  // 1. Normalize
  const dev = source === 'tcp' ? _normalizeTcp(rawDevice) : _normalizeWanway(rawDevice);

  if (!dev.imei) {
    logger.warn('⚠️ [Processor] Received device with no IMEI — skipped');
    return;
  }

  // 2. Timestamp
  const gpsTs    = dev.gpsTimestampMs    ? new Date(dev.gpsTimestampMs)    : now;
  const signalTs = dev.signalTimestampMs ? new Date(dev.signalTimestampMs) : now;

  // 3. Coordinate conversion (WanWay only; TCP already converted)
  let lat = dev.rawLat != null ? parseFloat(dev.rawLat) : null;
  let lng = dev.rawLng != null ? parseFloat(dev.rawLng) : null;

  if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
    if (lat === 0 && lng === 0) {
      logger.warn('⚠️ [Processor] Null-island (0,0) for IMEI=%s — coords nulled', dev.imei);
      lat = null;
      lng = null;
    } else if (dev.needsGcjConversion) {
      const wgs = gcj02ToWgs84(lng, lat);
      lat = wgs.lat;
      lng = wgs.lng;
    }
  }

  const hasValidGPS = lat != null && lng != null && !isNaN(lat) && !isNaN(lng);

  // 4. Online status (reported within last 5 minutes)
  const isOnline = (Date.now() - signalTs.getTime()) < 5 * 60 * 1000;

  const status = !isOnline
    ? 'offline'
    : dev.speed > TRIP_START_SPEED_KMH
      ? 'moving'
      : 'idle';

  // 5. Resolve vehicle
  const vehicle = await Vehicle.findOne({ imei: dev.imei })
    .select('_id imei lastKnownLocation')
    .lean();

  if (!vehicle) {
    logger.warn('⚠️ [Processor] Unknown IMEI=%s — not in DB', dev.imei);
    return;
  }

  const vehicleId = vehicle._id;

  // 6. Duplicate guard (skip STORE but still update vehicle state for heartbeat)
  let isDuplicate = false;
  if (hasValidGPS) {
    isDuplicate = _isDuplicate(dev.imei, lat, lng, gpsTs.getTime());
    if (isDuplicate) {
      logger.debug('🔁 [Processor] Duplicate point skipped for IMEI=%s', dev.imei);
    } else {
      _markStored(dev.imei, lat, lng, gpsTs.getTime());
    }
  }

  // 7. ██████████████████████████████████████████████████████████████████████
  //    STORE RAW GPS LOG — UNCONDITIONALLY (no speed filter, no idle skip)
  //    This is the source of truth. NEVER add conditions here.
  // ██████████████████████████████████████████████████████████████████████████
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
      // DO NOT return — continue with vehicle update and socket emit
    }
  }

  // 8. Address resolution
  let address = null;
  if (dev.address && dev.address.trim().length > 0) {
    address = dev.address.trim();
  } else if (hasValidGPS && !isDuplicate) {
    address = await _reverseGeocode(lat, lng).catch(() => null);
  }
  if (!address && hasValidGPS) {
    address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  // 9. Update Vehicle latest state
  const vehicleUpdate = {
    speed:      dev.speed,
    heading:    dev.heading,
    isOnline,
    isLive:     isOnline,
    lastUpdate: now,
    status,
  };

  if (hasValidGPS) {
    vehicleUpdate.latitude        = lat;
    vehicleUpdate.longitude       = lng;
    vehicleUpdate.lat             = lat;
    vehicleUpdate.lng             = lng;
    vehicleUpdate.lastKnownLocation = {
      latitude:   lat,
      longitude:  lng,
      speed:      dev.speed,
      heading:    dev.heading,
      altitude:   dev.altitude ?? 0,
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

  if (isOnline && hasValidGPS) {
    vehicleUpdate.lastOnlineAt = gpsTs;
  }

  try {
    await Vehicle.findByIdAndUpdate(vehicleId, { $set: vehicleUpdate });
  } catch (err) {
    logger.error('❌ [Processor] Vehicle update failed for IMEI=%s: %s', dev.imei, err.message);
  }

  // 10. Socket.IO emit
  if (global.io && hasValidGPS) {
    global.io.emit('vehicleMovement', {
      id:               vehicleId.toString(),
      imei:             dev.imei,
      lat,
      lng,
      latitude:         lat,
      longitude:        lng,
      speed:            dev.speed,
      heading:          dev.heading,
      isOnline,
      isLive:           isOnline,
      status,
      satellites:       dev.satellites,
      accuracy:         dev.accuracy,
      voltage:          dev.voltage,
      ignition:         dev.ignition,
      acc:              dev.ignition,
      address,
      location:         address,
      formattedLocation: address,
      lastKnownLocation: vehicleUpdate.lastKnownLocation ?? null,
      gpsTime:          gpsTs.toISOString(),
      deviceTime:       now.toISOString(),
      lastUpdate:       now.toISOString(),
      source:           dev.source,
    });
  }

  // 11. Trip detection (non-blocking but sequential per device)
  setImmediate(() => {
    _handleTripDetection({
      vehicleId,
      imei:        dev.imei,
      speed:       dev.speed,
      lat,
      lng,
      timestamp:   gpsTs,
      hasValidGPS,
    }).catch(err =>
      logger.error('❌ [Processor] Trip detect error [%s]: %s', dev.imei, err.message)
    );
  });

  logger.info(
    '✅ [Processor] IMEI=%s | src=%s | lat=%s lng=%s | spd=%s | ign=%s | dup=%s',
    dev.imei, dev.source,
    lat?.toFixed(6), lng?.toFixed(6),
    dev.speed, dev.ignition, isDuplicate
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// processBulkUpdates — batch entry point (used by wanway.poller.js)
// ─────────────────────────────────────────────────────────────────────────────
async function processBulkUpdates(deviceArray, source = 'wanway') {
  if (!Array.isArray(deviceArray) || deviceArray.length === 0) return;

  logger.info('📦 [Processor] Processing batch of %d devices from %s', deviceArray.length, source);

  // Process concurrently but cap at 10 at a time to avoid DB saturation
  const CONCURRENCY = 10;
  for (let i = 0; i < deviceArray.length; i += CONCURRENCY) {
    const chunk = deviceArray.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      chunk.map(dev => processIncomingData(dev, source))
    );
  }

  logger.info('✅ [Processor] Batch complete (%d devices)', deviceArray.length);
}

module.exports = {
  processIncomingData,
  processBulkUpdates,
};
