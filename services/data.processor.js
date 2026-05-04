'use strict';

const logger = require('../utils/logger');

// ── GCJ-02 → WGS-84 coordinate converter ─────────────────────────────────────
function gcj02ToWgs84(gcjLng, gcjLat) {
  const a  = 6378245.0;
  const ee = 0.00669342162296594323;

  function transformLat(lng, lat) {
    let r = -100 + 2*lng + 3*lat + 0.2*lat*lat + 0.1*lng*lat
            + 0.2*Math.sqrt(Math.abs(lng));
    r += (20*Math.sin(6*lng*Math.PI) + 20*Math.sin(2*lng*Math.PI)) * 2/3;
    r += (20*Math.sin(lat*Math.PI)   + 40*Math.sin(lat/3*Math.PI)) * 2/3;
    r += (160*Math.sin(lat/12*Math.PI) + 320*Math.sin(lat*Math.PI/30)) * 2/3;
    return r;
  }

  function transformLng(lng, lat) {
    let r = 300 + lng + 2*lat + 0.1*lng*lng + 0.1*lng*lat
            + 0.1*Math.sqrt(Math.abs(lng));
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
    lat: gcjLat - (dLat * 180) / ((a*(1-ee))/(magic*sqrtMagic) * Math.PI),
    lng: gcjLng - (dLng * 180) / (a/sqrtMagic * Math.cos(radLat) * Math.PI),
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────
const IDLE_GRACE_MS       = 3 * 60 * 1000;
const MOVING_SPEED_KMH    = 5;
const MAX_GPS_AGE_MINUTES = 10;    // Reject GPS fixes older than 10 minutes
const MAX_SPEED_KMH       = 250;   // Reject impossible speeds
const MAX_JUMP_KM         = 100;   // Reject position jumps > 100km
const INDIA_BOUNDS        = {
  minLat: 6.0, maxLat: 37.6,
  minLng: 68.0, maxLng: 97.5,
};

// ── Last known positions for spike detection ───────────────────────────────────
const _lastValidPos = new Map(); // imei → { lat, lng, ts }

// ── Geocode cache ──────────────────────────────────────────────────────────────
const _geocodeCache = new Map();

async function _reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (_geocodeCache.has(key)) return _geocodeCache.get(key);
  try {
    const axios = require('axios');
    const res   = await axios.get(
      'https://nominatim.openstreetmap.org/reverse',
      {
        params:  { lat, lon: lng, format: 'json', zoom: 18 },
        headers: { 'User-Agent': 'NVIQFleetServer/1.0' },
        timeout: 5000,
      }
    );
    const addr = res.data?.display_name ?? null;
    if (addr) _geocodeCache.set(key, addr);
    return addr;
  } catch (_) {
    return null;
  }
}

// ── Haversine distance (km) ───────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dG = (lng2 - lng1) * Math.PI / 180;
  const a  =
    Math.sin(dL/2) * Math.sin(dL/2) +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
    Math.sin(dG/2) * Math.sin(dG/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── GPS fix validator ─────────────────────────────────────────────────────────
function validateGpsFix({ imei, lat, lng, speed, gpsTimestamp, serverNow }) {

  // 1. Coordinate sanity
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
    return { valid: false, reason: 'null coordinates' };
  }
  if (lat === 0 && lng === 0) {
    return { valid: false, reason: 'null island (0,0)' };
  }

  // 2. India bounding box
  if (lat < INDIA_BOUNDS.minLat || lat > INDIA_BOUNDS.maxLat ||
      lng < INDIA_BOUNDS.minLng || lng > INDIA_BOUNDS.maxLng) {
    return { valid: false, reason: `out of India bounds (${lat.toFixed(4)}, ${lng.toFixed(4)})` };
  }

  // 3. GPS fix age — KEY FIX for stale location bug
  if (gpsTimestamp) {
    const ageMs      = serverNow - gpsTimestamp.getTime();
    const ageMinutes = ageMs / 60000;
    if (ageMinutes > MAX_GPS_AGE_MINUTES) {
      return {
        valid:  false,
        reason: `stale GPS fix — age=${ageMinutes.toFixed(1)}min `
               + `(gpsTime=${gpsTimestamp.toISOString()})`,
        isStale: true,
      };
    }
  }

  // 4. Impossible speed
  if (speed > MAX_SPEED_KMH) {
    return { valid: false, reason: `impossible speed ${speed} km/h` };
  }

  // 5. Position jump / spike detection
  const prev = _lastValidPos.get(imei);
  if (prev) {
    const jumpKm = haversineKm(prev.lat, prev.lng, lat, lng);
    if (jumpKm > MAX_JUMP_KM) {
      return {
        valid:  false,
        reason: `GPS spike ${jumpKm.toFixed(1)} km jump from last valid position`,
      };
    }
  }

  return { valid: true };
}

// ── Trip auto-detection state ─────────────────────────────────────────────────
const _tripState = new Map();

async function _handleTripDetection({
  vehicleId, imei, isOnline, speed, lat, lng, timestamp, hasValidGPS,
}) {
  if (!vehicleId || !isOnline || !hasValidGPS) return;

  const Trip     = require('../models/Trip');
  const isMoving = speed > MOVING_SPEED_KMH;
  const stateKey = imei;
  const prev     = _tripState.get(stateKey) || {
    tripId: null, idleSince: null,
    lastLat: null, lastLng: null,
    maxSpeed: 0, totalDistance: 0, speedReadings: [],
  };

  let segmentKm = 0;
  if (prev.lastLat != null && prev.lastLng != null && isMoving) {
    segmentKm = haversineKm(prev.lastLat, prev.lastLng, lat, lng);
    if (segmentKm > 5) segmentKm = 0;
  }

  const newTotalDistance = prev.totalDistance + segmentKm;
  const newMaxSpeed      = Math.max(prev.maxSpeed, speed);
  const newSpeedReadings = isMoving
    ? [...prev.speedReadings, speed]
    : prev.speedReadings;

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
          global.io.emit('vehicleMovement', {
            type:      'trip_started',
            tripId:    tripId.toString(),
            vehicleId: vehicleId.toString(),
            imei,
          });
        }
      } catch (err) {
        logger.error('❌ createTrip error imei=%s: %s', imei, err.message);
      }
    }
    _tripState.set(stateKey, {
      tripId, idleSince: null,
      lastLat: lat, lastLng: lng,
      maxSpeed: newMaxSpeed, totalDistance: newTotalDistance,
      speedReadings: newSpeedReadings,
    });
    return;
  }

  const idleSince = prev.idleSince ?? new Date();
  if (!prev.tripId) {
    _tripState.set(stateKey, { ...prev, idleSince, lastLat: lat, lastLng: lng });
    return;
  }

  const idleMs = Date.now() - idleSince.getTime();
  if (idleMs < IDLE_GRACE_MS) {
    _tripState.set(stateKey, {
      ...prev, idleSince, lastLat: lat, lastLng: lng,
      maxSpeed: newMaxSpeed, totalDistance: newTotalDistance,
      speedReadings: newSpeedReadings,
    });
    return;
  }

  try {
    const avgSpeed = prev.speedReadings.length > 0
      ? prev.speedReadings.reduce((a, b) => a + b, 0) / prev.speedReadings.length
      : 0;
    const openTrip = await Trip.findById(prev.tripId);
    if (openTrip && !openTrip.isCompleted) {
      const endTime  = timestamp;
      const duration = Math.round((endTime - openTrip.startTime) / 60000);
      openTrip.endTime       = endTime;
      openTrip.duration      = Math.max(0, duration);
      openTrip.endLocation   = { latitude: lat, longitude: lng };
      openTrip.totalDistance = parseFloat(prev.totalDistance.toFixed(3));
      openTrip.maxSpeed      = parseFloat(newMaxSpeed.toFixed(1));
      openTrip.avgSpeed      = parseFloat(avgSpeed.toFixed(1));
      openTrip.isCompleted   = true;
      await openTrip.save();
      logger.info(
        '🏁 Trip ENDED | imei=%s | tripId=%s | %.2f km | %d min',
        imei, prev.tripId, prev.totalDistance, duration,
      );
      if (global.io) {
        global.io.emit('vehicleMovement', {
          type:          'trip_ended',
          tripId:        prev.tripId.toString(),
          vehicleId:     vehicleId.toString(),
          imei,
          totalDistance: openTrip.totalDistance,
          duration:      openTrip.duration,
        });
      }
    }
  } catch (err) {
    logger.error('❌ endTrip error imei=%s: %s', imei, err.message);
  }

  _tripState.set(stateKey, {
    tripId: null, idleSince: null,
    lastLat: lat, lastLng: lng,
    maxSpeed: 0, totalDistance: 0, speedReadings: [],
  });
}

// ── Main processor ────────────────────────────────────────────────────────────
async function processBulkUpdates(deviceArray) {
  if (!deviceArray || deviceArray.length === 0) return;

  const Vehicle      = require('../models/Vehicle');
  const LocationPing = require('../models/LocationPing');

  const vehicleOps  = [];
  const pingOps     = [];
  const now         = new Date();
  const nowMs       = now.getTime();
  const tripTasks   = [];

  try {
    const vehicles = await Vehicle.find(
      { imei: { $in: deviceArray.map(d => d.imei) } },
      '_id imei lastKnownLocation latitude longitude'
    ).lean();

    const idMap = new Map(vehicles.map(v => [v.imei, v._id]));

    // Seed _lastValidPos from DB so spike detection works after server restart
    for (const v of vehicles) {
      if (!_lastValidPos.has(v.imei) && v.latitude && v.longitude) {
        _lastValidPos.set(v.imei, {
          lat: v.latitude, lng: v.longitude, ts: nowMs,
        });
      }
    }

    for (const dev of deviceArray) {
      const vId = idMap.get(dev.imei);
      if (!vId) {
        logger.warn('⚠️ No vehicle for IMEI: %s', dev.imei);
        continue;
      }

      // ── 1. Parse timestamps ───────────────────────────────────────────────
      // gpsTime  = when device got the GPS fix (may be stale/cached)
      // signalTime = when Wanway server received the packet (more reliable)
      const serverReceiptTime = now;

      let gpsTimestamp = null;
      if (dev.gpsTime != null) {
        // IOP sends Unix epoch in seconds
        gpsTimestamp = new Date(dev.gpsTime * 1000);
      }

      // signalTime = Wanway server receipt time (seconds epoch)
      const fiveMinutesAgoSec = (nowMs / 1000) - 300;
      const isOnline = dev.signalTime != null
        && dev.signalTime >= fiveMinutesAgoSec;

      // ── 2. Parse & convert coordinates ───────────────────────────────────
      const rawLat = dev.lat != null ? parseFloat(dev.lat) : null;
      const rawLng = dev.lng != null ? parseFloat(dev.lng) : null;

      const { lat, lng } = (rawLat != null && rawLng != null)
        ? gcj02ToWgs84(rawLng, rawLat)
        : { lat: rawLat, lng: rawLng };

      const speed = dev.speed ?? 0;

      // ── 3. Validate GPS fix ───────────────────────────────────────────────
      const validation = validateGpsFix({
        imei:         dev.imei,
        lat,
        lng,
        speed,
        gpsTimestamp,        // GPS device fix time
        serverNow:    nowMs,
      });

      const hasValidGPS = validation.valid;

      if (!hasValidGPS) {
        logger.warn(
          '⚠️ [Wanway] REJECTED GPS for %s: %s',
          dev.imei, validation.reason
        );

        // If stale fix: keep device online but DO NOT move marker
        if (validation.isStale) {
          vehicleOps.push({
            updateOne: {
              filter: { imei: dev.imei },
              update: {
                $set: {
                  isOnline:     isOnline,
                  isLive:       isOnline,
                  lastOnlineAt: serverReceiptTime,
                  // Critically: do NOT update lat/lng/lastUpdate
                },
              },
            },
          });

          // Tell Flutter device is online but position unchanged
          if (global.io && isOnline) {
            global.io.emit('vehicleMovement', {
              id:        vId.toString(),
              imei:      dev.imei,
              isOnline,
              isLive:    isOnline,
              gpsStale:  true,   // Flutter can show "GPS signal lost" badge
              deviceTime: serverReceiptTime.toISOString(),
            });
          }
        }
        continue; // Skip position update entirely
      }

      // ── 4. Fix is valid — update last known good position ─────────────────
      _lastValidPos.set(dev.imei, { lat, lng, ts: nowMs });

      // ── 5. Address resolution ─────────────────────────────────────────────
      let address = null;
      if (dev.address && dev.address.trim().length > 0) {
        address = dev.address.trim();
      } else {
        address = await _reverseGeocode(lat, lng);
      }
      if (!address) {
        address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      }

      logger.info(
        '📍 [Wanway] %s | lat=%s lng=%s speed=%s | gpsAge=%ds | addr=%s',
        dev.imei,
        lat.toFixed(6),
        lng.toFixed(6),
        speed,
        gpsTimestamp
          ? Math.round((nowMs - gpsTimestamp.getTime()) / 1000)
          : '?',
        address,
      );

      // ── 6. Build DB update ────────────────────────────────────────────────
      const status = !isOnline
        ? 'offline'
        : speed > MOVING_SPEED_KMH
          ? 'moving'
          : 'idle';

      const baseUpdate = {
        lat,  lng,
        latitude:  lat,
        longitude: lng,
        speed,
        heading:    dev.course ?? 0,
        isOnline,
        isLive:     isOnline,
        status,

        // KEY: lastUpdate = server receipt time (not GPS fix time)
        // This keeps Flutter's "X min ago" accurate
        lastUpdate:   serverReceiptTime,
        lastOnlineAt: isOnline ? serverReceiptTime : undefined,

        address,
        location:          address,
        formattedLocation: address,

        lastKnownLocation: {
          latitude:   lat,
          longitude:  lng,
          speed,
          heading:    dev.course   ?? 0,
          altitude:   dev.altitude ?? 0,
          voltage:    dev.extVoltage != null ? dev.extVoltage / 10 : null,
          odometer:   dev.odometer  ?? dev.mileage ?? null,
          address,
          // Store both times so Flutter panel can display both correctly
          timestamp:  gpsTimestamp ?? serverReceiptTime,
          serverTime: serverReceiptTime,
        },
      };

      vehicleOps.push({
        updateOne: {
          filter: { imei: dev.imei },
          update: { $set: baseUpdate },
        },
      });

      // ── 7. Socket emit to Flutter ─────────────────────────────────────────
      // FIX: was 'vehicle_movement' (underscore) — Flutter only listens for
      // 'vehicleMovement' (camelCase). This was silently dropping ALL
      // Wanway position updates in Flutter.
      if (global.io) {
        global.io.emit('vehicleMovement', {
          id:        vId.toString(),
          imei:      dev.imei,
          lat,
          lng,
          latitude:  lat,
          longitude: lng,
          speed,
          heading:   dev.course ?? 0,
          isOnline,
          isLive:    isOnline,
          status,
          gpsStale:  false,

          // KEY FIX: send BOTH timestamps separately
          // Flutter _onMovement reads 'gpsTime' and 'deviceTime' independently
          gpsTime:    gpsTimestamp
                        ? gpsTimestamp.toISOString()
                        : serverReceiptTime.toISOString(),
          deviceTime: serverReceiptTime.toISOString(),
          lastUpdate: serverReceiptTime.toISOString(),

          // Address fields — all three so Flutter _resolveAddress() finds one
          address,
          location:          address,
          formattedLocation: address,

          lastKnownLocation: baseUpdate.lastKnownLocation,

          // Extra fields Flutter uses for the info panel
          satellites: dev.satellites ?? dev.gpsSignal ?? 0,
          accuracy:   dev.accuracy   ?? 0,
          voltage:    dev.extVoltage != null ? dev.extVoltage / 10 : 0,
          ignition:   dev.acc === 1 || dev.acc === '1' || dev.acc === true,
          odometer:   dev.odometer ?? dev.mileage ?? 0,
        });
      }

      // ── 8. Location ping ──────────────────────────────────────────────────
      if (isOnline && speed > 0) {
        pingOps.push({
          vehicleId:  vId,
          latitude:   lat,
          longitude:  lng,
          speed,
          heading:    dev.course ?? 0,
          timestamp:  gpsTimestamp ?? serverReceiptTime,
          serverTime: serverReceiptTime,
        });
      }

      tripTasks.push({
        vehicleId: vId, imei: dev.imei,
        isOnline, speed, lat, lng,
        timestamp: gpsTimestamp ?? serverReceiptTime,
        hasValidGPS,
      });
    }

    // ── 9. Bulk write ─────────────────────────────────────────────────────
    await Promise.all([
      vehicleOps.length > 0
        ? Vehicle.bulkWrite(vehicleOps, { ordered: false })
        : Promise.resolve(),
      pingOps.length > 0
        ? LocationPing.insertMany(pingOps, { ordered: false })
        : Promise.resolve(),
    ]);

    logger.info(
      '🚀 [Wanway] Synced %d units — %d valid positions — %d pings',
      deviceArray.length,
      vehicleOps.filter(op => !op.updateOne.update.$set.gpsStale).length,
      pingOps.length,
    );

    for (const task of tripTasks) {
      await _handleTripDetection(task);
    }

  } catch (err) {
    logger.error('❌ Data Processor Error: %s', err.message);
  }
}

module.exports = { processBulkUpdates };