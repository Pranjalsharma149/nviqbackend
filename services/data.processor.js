'use strict';

/**
 * services/data.processor.js — v2.2
 *
 * FIXES vs v2.1:
 *
 *   FIX-IGN-3: When ignition is null (not reported by device), INFER it from
 *              speed. If speed > 1 km/h → assume ignition ON. This prevents
 *              todayKm and engineHours from always being 0 when the IOPGPS
 *              API doesn't return an ignition field for a device.
 *              Log message now shows 'inferred' vs 'reported'.
 *
 *   FIX-IGN-4: _normalizeWanway() now reads dev.acc which already contains
 *              the pre-parsed ignition boolean from wanway.poller.js
 *              (parseIgnition function). No change needed here — just
 *              confirming the chain is correct.
 *
 *   FIX-DIST:  Vehicle document is updated with todayDistance and
 *              todayEngineHours on EVERY tick, not just when hasValidGPS.
 *              Previously if GPS was valid but isDuplicate=true, the
 *              accumulator values were computed but never written to Vehicle.
 *
 *   FIX-SOCK:  Socket emit now sends gpsTime as the DEVICE GPS fix time
 *              (gpsTs.toISOString()), not server time. Flutter's _onMovement
 *              reads 'gpsTime' first for the "last seen" display. Using server
 *              time caused "20m ago" display bug.
 *
 *   FIX-ODO:   Vehicle.odometer is only overwritten if the incoming value is
 *              GREATER than the existing value. Prevents odometer from going
 *              backwards if device sends 0 briefly.
 */

const logger = require('../utils/logger');
const { haversineKm, isNoisePoint } = require('../utils/distance');

// ── GCJ-02 → WGS-84 (kept for TCP devices that need it) ──────────────────────
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

// ── GPS Quality Check ─────────────────────────────────────────────────────────
function _isGpsReliable(satellites, accuracy, speed) {
  if (satellites < 4)               return false;
  if (accuracy > 25)                return false;
  if (speed < 1 && accuracy > 10)   return false;
  return true;
}

// ── Nominatim geocode queue ───────────────────────────────────────────────────
const _geocodeCache = new Map();
let   _geocodeQueue = Promise.resolve();

function getManualAddressOverride(lat, lng) {
  if (lat >= 20.37 && lat <= 20.38 && lng >= 72.92 && lng <= 72.93) {
    return 'Krishna Society, Vapi, Valsad District, Gujarat, India';
  }
  return null;
}

function _reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (_geocodeCache.has(key)) return Promise.resolve(_geocodeCache.get(key));

  _geocodeQueue = _geocodeQueue
    .then(() => new Promise(resolve => setTimeout(resolve, 1050)))
    .then(async () => {
      try {
        const manualAddr = getManualAddressOverride(lat, lng);
        if (manualAddr) {
          _geocodeCache.set(key, manualAddr);
          logger.debug('✅ [Geocoding] Manual Override: %s', manualAddr);
          return manualAddr;
        }

        const axios = require('axios');

        if (process.env.GOOGLE_GEOCODING_KEY) {
          try {
            const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
              params: {
                latlng: `${lat},${lng}`,
                key: process.env.GOOGLE_GEOCODING_KEY,
                language: 'en',
                region: 'in',
              },
              timeout: 5000,
            });
            const addr = res.data?.results?.[0]?.formatted_address ?? null;
            if (addr) {
              _geocodeCache.set(key, addr);
              logger.debug('✅ [Geocoding] Google Maps: %s', addr);
              return addr;
            }
          } catch (_) {
            logger.debug('⚠️ [Geocoding] Google Maps failed, trying Nominatim');
          }
        }

        const res = await axios.get('https://nominatim.openstreetmap.org/reverse', {
          params:  { lat, lon: lng, format: 'json', zoom: 18 },
          headers: { 'User-Agent': 'NVIQFleetServer/1.0' },
          timeout: 5000,
        });
        const addr = res.data?.display_name ?? null;
        if (addr) {
          _geocodeCache.set(key, addr);
          logger.debug('📍 [Geocoding] Nominatim: %s', addr);
          return addr;
        }

        const coordStr = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        _geocodeCache.set(key, coordStr);
        return coordStr;
      } catch (err) {
        logger.warn('⚠️ [Geocoding] Error: %s', err.message);
        return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
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

// ── Bearing / heading consistency guard ──────────────────────────────────────
// Tracks the last accepted (quality-passed) GPS point per IMEI so we can
// compute the actual travel bearing and compare it to the device's reported
// heading. A large mismatch while accuracy is poor = post-turn GPS drift.
const _lastGoodPoint = new Map(); // imei → { lat, lng }

function _bearingDeg(lat1, lng1, lat2, lng2) {
  const dLng  = (lng2 - lng1) * Math.PI / 180;
  const lat1r = lat1 * Math.PI / 180;
  const lat2r = lat2 * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2r);
  const x = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function _headingDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Returns false when the point looks like a post-turn GPS drift artefact:
//   distance from last good point must be > 30m (short hops are unreliable for bearing),
//   heading vs calculated bearing must differ by > 90° AND accuracy must be > 20m.
function _isBearingConsistent(imei, lat, lng, deviceHeading, accuracy) {
  const prev = _lastGoodPoint.get(imei);
  if (!prev) return true;

  const distKm = haversineKm(prev.lat, prev.lng, lat, lng);
  if (distKm < 0.030) return true; // < 30 m: bearing calc is unreliable

  const bearing = _bearingDeg(prev.lat, prev.lng, lat, lng);
  const diff    = _headingDiff(deviceHeading, bearing);

  if (diff > 90 && accuracy > 20) {
    logger.debug(
      '⚠️ [BearingGuard] IMEI=%s device=%d° calc=%d° diff=%d° acc=%dm — point rejected',
      imei, Math.round(deviceHeading), Math.round(bearing), Math.round(diff), Math.round(accuracy)
    );
    return false;
  }
  return true;
}

// ── Ignition state tracker (detects OFF→ON transitions) ──────────────────────
// imei → { ignitionOn: bool, since: Date|null }
const _ignitionState = new Map();

// Returns the ignitionSince Date for this IMEI:
//   - If ignition just turned ON (transition), sets `since` to `ts` and persists it.
//   - If ignition was already ON, returns the existing `since`.
//   - If ignition is OFF, clears `since` and returns null.
function _updateIgnitionSince(imei, currentIgnition, ts) {
  const prev = _ignitionState.get(imei);

  if (!currentIgnition) {
    _ignitionState.set(imei, { ignitionOn: false, since: null });
    return null;
  }

  // Ignition is ON
  if (!prev || !prev.ignitionOn) {
    // Transition OFF → ON (or first-ever point with ignition ON)
    _ignitionState.set(imei, { ignitionOn: true, since: ts });
    return ts;
  }

  // Already ON — keep the existing start time
  _ignitionState.set(imei, { ignitionOn: true, since: prev.since });
  return prev.since;
}

// ── Daily distance accumulator ────────────────────────────────────────────────
const _dailyDist = new Map();

function _getTodayStr() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day   = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// FIX-IGN-3: ignitionOn now accepts the effective ignition (after inference)
function _addDailyDistance(imei, lat, lng, speed, ignitionOn) {
  const today = _getTodayStr();
  const prev  = _dailyDist.get(imei);

  if (!prev || prev.dateStr !== today) {
    _dailyDist.set(imei, { distKm: 0, lastLat: lat, lastLng: lng, dateStr: today });
    return 0;
  }

  let delta = 0;
  // Accumulate distance when ignition ON (or inferred ON from speed) and moving
  if (ignitionOn && prev.lastLat != null && speed > 1) {
    const raw = haversineKm(prev.lastLat, prev.lastLng, lat, lng);
    if (!isNoisePoint(raw)) delta = raw;
  }

  const newDist = prev.distKm + delta;
  _dailyDist.set(imei, { distKm: newDist, lastLat: lat, lastLng: lng, dateStr: today });
  return newDist;
}

// ── Engine hours accumulator ──────────────────────────────────────────────────
const _engineHours = new Map();

// FIX-IGN-3: ignitionOn accepts the effective ignition (after inference)
function _updateEngineHours(imei, ignitionOn, pointTs) {
  const today = _getTodayStr();
  const prev  = _engineHours.get(imei);

  if (!prev || prev.dateStr !== today) {
    _engineHours.set(imei, { hoursToday: 0, lastTs: pointTs, ignitionOn, dateStr: today });
    return 0;
  }

  let addedHours = 0;
  if (ignitionOn && prev.lastTs) {
    const elapsedMs = pointTs - prev.lastTs;
    // Cap at 1h per point to handle clock jumps
    if (elapsedMs > 0 && elapsedMs < 60 * 60 * 1000) {
      addedHours = elapsedMs / (1000 * 3600);
    }
  }

  const newHours = prev.hoursToday + addedHours;
  _engineHours.set(imei, { hoursToday: newHours, lastTs: pointTs, ignitionOn, dateStr: today });
  return newHours;
}

// ── Daily accumulator pruning ─────────────────────────────────────────────────
const _tripState = new Map();

setInterval(() => {
  const today = _getTodayStr();
  for (const [imei, rec] of _dailyDist.entries()) {
    if (rec.dateStr !== today) _dailyDist.delete(imei);
  }
  for (const [imei, state] of _tripState.entries()) {
    if (!state.tripId) _tripState.delete(imei);
  }
  _lastGoodPoint.clear(); // reset bearing baseline daily
  logger.info('[Processor] Pruned daily accumulators');
}, 24 * 60 * 60 * 1000);

// ── Trip detection ────────────────────────────────────────────────────────────
const TRIP_START_SPEED_KMH = 5;
const TRIP_IDLE_END_MS     = 3 * 60 * 1000;

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

// ── Normalizers ───────────────────────────────────────────────────────────────

// FIX-IGN-4: dev.acc from poller is already the parsed boolean|null from parseIgnition()
function _normalizeWanway(dev) {
  return {
    imei:     String(dev.imei || dev.imeino || dev.deviceId || ''),
    rawLat:   dev.lat  ?? dev.latitude  ?? null,
    rawLng:   dev.lng  ?? dev.longitude ?? null,
    speed:    parseFloat(dev.speed   ?? 0),
    heading:  parseFloat(dev.course  ?? dev.heading ?? 0),
    altitude: parseFloat(dev.altitude ?? 0),
    satellites: parseInt(dev.satellites ?? dev.gpsNum ?? 0, 10),
    accuracy:   parseFloat(dev.accuracy ?? dev.hdop ?? 0),
    voltage:    dev.extVoltage != null ? dev.extVoltage : null,
    odometer:   dev.odometer ?? dev.mileage ?? null,
    // dev.acc is the pre-parsed boolean|null from wanway.poller.js parseIgnition()
    ignition:   dev.acc,
    address:    dev.address ?? dev.location ?? null,
    gpsTimestampMs:    dev.gpsTime    ? dev.gpsTime    * 1000 : null,
    signalTimestampMs: dev.signalTime ? dev.signalTime * 1000 : null,
    source:             'wanway',
    needsGcjConversion: false,
  };
}

function _normalizeMultitrack(dev) {
  return {
    imei:     String(dev.imei || ''),
    rawLat:   dev.lat  ?? null,
    rawLng:   dev.lng  ?? null,
    speed:    parseFloat(dev.speed ?? 0),
    heading:  parseFloat(dev.course ?? 0),
    altitude: parseFloat(dev.altitude ?? 0),
    satellites: parseInt(dev.satellites ?? 0, 10),
    accuracy:   parseFloat(dev.accuracy ?? 0),
    voltage:    dev.extVoltage ?? null,
    odometer:   dev.odometer ?? null,
    ignition:   dev.acc != null ? Boolean(Number(dev.acc)) : null,
    address:    dev.address ?? null,
    gpsTimestampMs:    dev.gpsTime    ? dev.gpsTime    * 1000 : null,
    signalTimestampMs: dev.signalTime ? dev.signalTime * 1000 : null,
    source:             'multitrack',
    needsGcjConversion: false,
  };
}

function _normalizeTcp(dev) {
  return {
    imei:     String(dev.imei || ''),
    rawLat:   dev.latitude  ?? dev.lat  ?? null,
    rawLng:   dev.longitude ?? dev.lng  ?? null,
    speed:    parseFloat(dev.speed   ?? 0),
    heading:  parseFloat(dev.heading ?? dev.course ?? 0),
    altitude: parseFloat(dev.altitude ?? 0),
    satellites: parseInt(dev.satellites ?? 0, 10),
    accuracy:   parseFloat(dev.accuracy  ?? 0),
    voltage:    dev.voltage  ?? null,
    odometer:   dev.odometer ?? null,
    ignition:   dev.ignition ?? null,
    address:    null,
    gpsTimestampMs:    dev.gpsTimestamp ? new Date(dev.gpsTimestamp).getTime() : null,
    signalTimestampMs: Date.now(),
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
  let dev;
  if (source === 'tcp')        dev = _normalizeTcp(rawDevice);
  else if (source === 'multitrack') dev = _normalizeMultitrack(rawDevice);
  else                         dev = _normalizeWanway(rawDevice);

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

  // ─────────────────────────────────────────────────────────────────────────
  // FIX-IGN-3: Effective ignition — infer from speed when device doesn't report
  //
  //   dev.ignition === true   → device explicitly says ON
  //   dev.ignition === false  → device explicitly says OFF
  //   dev.ignition === null   → device didn't report it (IOPGPS without accStatus)
  //                             → INFER: ON if speed > 1, OFF if speed == 0
  //
  // effectiveIgnition is what we use for distance/engine accumulation.
  // We still store the raw dev.ignition in RawGpsLog for debugging.
  // ─────────────────────────────────────────────────────────────────────────
  let effectiveIgnition;
  let ignitionSource;
  if (dev.ignition !== null && dev.ignition !== undefined) {
    effectiveIgnition = dev.ignition;
    ignitionSource    = 'reported';
  } else {
    // Infer from speed — if moving, engine must be on
    effectiveIgnition = dev.speed > 1;
    ignitionSource    = 'inferred';
  }

  // 3b. Ignition since — track when ignition last flipped ON
  const ignitionSince = _updateIgnitionSince(dev.imei, effectiveIgnition, gpsTs);

  // 4. Online / status
  const isOnline = (Date.now() - signalTs.getTime()) < 5 * 60 * 1000;
  const status   = !isOnline
    ? 'offline'
    : dev.speed > TRIP_START_SPEED_KMH
      ? 'moving'
      : effectiveIgnition ? 'idle' : 'parked';

  // 5. Resolve vehicle
  const vehicle = await Vehicle.findOne({ imei: dev.imei })
    .select('_id imei lastKnownLocation odometer')
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

  // 7. Compute running daily totals
  let todayDistKm = 0;
  let engineHrs   = 0;
  if (hasValidGPS && !isDuplicate) {
    todayDistKm = _addDailyDistance(dev.imei, lat, lng, dev.speed, effectiveIgnition);
    engineHrs   = _updateEngineHours(dev.imei, effectiveIgnition, gpsTs.getTime());
  } else if (hasValidGPS) {
    // Duplicate — return current accumulator without incrementing
    const dailyRec = _dailyDist.get(dev.imei);
    const engRec   = _engineHours.get(dev.imei);
    todayDistKm = dailyRec?.distKm   ?? 0;
    engineHrs   = engRec?.hoursToday ?? 0;
  }

  // 8a. Store RawGpsLog (unconditional — source of truth)
  if (hasValidGPS) {
    try {
      await RawGpsLog.create({
        imei:            dev.imei,
        vehicleId,
        latitude:        lat,
        longitude:       lng,
        speed:           dev.speed,
        heading:         dev.heading,
        ignition:        effectiveIgnition,  // store effective, not raw null
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

  // 8b. Store LocationPing — only when GPS quality and bearing are trustworthy.
  // Poor-accuracy post-turn drift points still land in RawGpsLog above but are
  // excluded from the route visualization layer to prevent zig-zag rendering.
  const gpsQualityOk = _isGpsReliable(dev.satellites, dev.accuracy, dev.speed);
  const bearingOk    = hasValidGPS
    ? _isBearingConsistent(dev.imei, lat, lng, dev.heading, dev.accuracy)
    : true;

  if (hasValidGPS && !isDuplicate) {
    if (gpsQualityOk && bearingOk) {
      _lastGoodPoint.set(dev.imei, { lat, lng });
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
          ignitionOn:       effectiveIgnition,
          gpsTime:          gpsTs,
          deviceTime:       now,
          address:          null,
          serverOdometerKm: dev.odometer ?? 0,
          todayDistance:    todayDistKm,
          engineHours:      engineHrs,
          source:           dev.source,
        });
      } catch (err) {
        logger.error('❌ [Processor] LocationPing insert failed for IMEI=%s: %s', dev.imei, err.message);
      }
    } else {
      logger.debug(
        '⚠️ [Processor] LocationPing skipped IMEI=%s — quality=%s bearing=%s acc=%dm',
        dev.imei, gpsQualityOk, bearingOk, Math.round(dev.accuracy)
      );
    }
  }

  // 9. Address resolution (async, non-blocking)
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
        await Vehicle.findByIdAndUpdate(vehicleId, {
          $set: { address: addr, location: addr, formattedLocation: addr },
        });
      } catch (_) {}
    }).catch(() => {});
  }

  if (!address && hasValidGPS) {
    address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  // 10. Update Vehicle document
  //
  // FIX-DIST: Always write todayDistance and todayEngineHours to Vehicle,
  // even for duplicate points (we computed the current accumulator value above).
  // This ensures getLiveVehicles() always returns fresh values.
  //
  // FIX-ODO: Only overwrite odometer if incoming value > existing
  // (prevents backwards odometer when device briefly sends 0)
  const vehicleUpdate = {
    speed:            dev.speed,
    heading:          dev.heading,
    isOnline,
    isLive:           isOnline,
    lastUpdate:       now,
    status,
    todayDistance:    todayDistKm,       // ← always written
    todayEngineHours: engineHrs,         // ← always written
    satellites:       dev.satellites,
    accuracy:         dev.accuracy,
  };

  if (dev.ignition !== null && dev.ignition !== undefined) {
    vehicleUpdate.ignition = dev.ignition;
  } else {
    vehicleUpdate.ignition = effectiveIgnition;
  }
  vehicleUpdate.ignitionSince = ignitionSince ?? null;

  if (hasValidGPS) {
    vehicleUpdate.latitude  = lat;
    vehicleUpdate.longitude = lng;
    vehicleUpdate.lat       = lat;
    vehicleUpdate.lng       = lng;
    if (dev.voltage  != null) vehicleUpdate.voltage  = dev.voltage;
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
    const updateOp = {
      $set: vehicleUpdate,
      $max: { todayMaxSpeed: dev.speed },
    };

    // FIX-ODO: only overwrite odometer if device sends a valid, larger value
    if (dev.odometer != null && dev.odometer > 0) {
      updateOp.$max.odometer = dev.odometer;
    }

    await Vehicle.findByIdAndUpdate(vehicleId, updateOp);
  } catch (err) {
    logger.error('❌ [Processor] Vehicle update failed for IMEI=%s: %s', dev.imei, err.message);
  }

  // 11. Socket.IO emit
  // FIX-SOCK: gpsTime = device GPS fix time (not server time)
  // This fixes the "20m ago" display in Flutter
  if (global.io && hasValidGPS) {
    const gpsReliable  = _isGpsReliable(dev.satellites, dev.accuracy, dev.speed);
    const displaySpeed = (effectiveIgnition && gpsReliable) ? dev.speed : 0;

    global.io.emit('vehicleMovement', {
      id:               vehicleId.toString(),
      vehicleId:        vehicleId.toString(),
      imei:             dev.imei,
      lat,  lng,
      latitude:         lat,
      longitude:        lng,
      speed:            displaySpeed,
      heading:          dev.heading,
      isOnline,
      isLive:           isOnline,
      status,

      // All ignition aliases Flutter checks
      ignition:         effectiveIgnition,
      ignitionOn:       effectiveIgnition,
      acc:              effectiveIgnition,
      ACC:              effectiveIgnition,
      engine:           effectiveIgnition,
      engineOn:         effectiveIgnition,
      power:            effectiveIgnition,
      // When ignition turned ON — Flutter uses this to calculate "ignition for X mins"
      ignitionSince:    ignitionSince ? ignitionSince.toISOString() : null,

      satellites:       dev.satellites,
      accuracy:         dev.accuracy,

      // All voltage aliases Flutter checks
      voltage:          dev.voltage,
      external_voltage: dev.voltage,
      bat_v:            dev.voltage,
      battery:          dev.voltage,

      address,
      location:          address,
      formattedLocation: address,
      lastKnownLocation: vehicleUpdate.lastKnownLocation ?? null,

      // FIX-SOCK: GPS fix time first, server time as fallback
      // Flutter _onMovement reads: gpsTime, fix_time, gpsFixTime (first group)
      // then deviceTime (second group), then timestamp (last resort)
      gpsTime:    gpsTs.toISOString(),     // ← device GPS fix time
      fix_time:   gpsTs.toISOString(),
      gpsFixTime: gpsTs.toISOString(),
      deviceTime: now.toISOString(),
      lastUpdate: now.toISOString(),
      timestamp:  now.toISOString(),

      // All distance/odometer aliases Flutter checks
      todayDistance:  todayDistKm,
      todayKm:        todayDistKm,
      today_km:       todayDistKm,
      dailyDistance:  todayDistKm,
      engineHours:    engineHrs,

      // Odometer — Flutter reads: mileage, odometer, totalDistance, totalKm
      odometer:      dev.odometer ?? vehicle.odometer ?? 0,
      mileage:       dev.odometer ?? vehicle.odometer ?? 0,
      totalDistance: dev.odometer ?? vehicle.odometer ?? 0,
      totalKm:       dev.odometer ?? vehicle.odometer ?? 0,

      source: dev.source,
    });
  }

  // 12. Trip detection (non-blocking)
  setImmediate(() => {
    _handleTripDetection({
      vehicleId, imei: dev.imei,
      speed: dev.speed, lat, lng,
      timestamp: gpsTs, hasValidGPS,
    }).catch(err =>
      logger.error('❌ [Processor] Trip detect error [%s]: %s', dev.imei, err.message)
    );
  });

  logger.info(
    '✅ [Processor] IMEI=%s | src=%s | lat=%s lng=%s | spd=%s | ign=%s(%s) | dup=%s | todayKm=%s | engH=%s',
    dev.imei,
    dev.source,
    lat?.toFixed(6) ?? 'null',
    lng?.toFixed(6) ?? 'null',
    dev.speed,
    effectiveIgnition,
    ignitionSource,
    isDuplicate,
    todayDistKm.toFixed(2),
    engineHrs.toFixed(2)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// processBulkUpdates — batch entry point
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