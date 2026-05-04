'use strict';

const logger = require('../utils/logger');

// ── GCJ-02 → WGS-84 coordinate converter ─────────────────────────────────────
// Wanway/IOPGPS API returns GCJ-02 (Chinese encrypted) coordinates.
// This converts them to WGS-84 (standard GPS / Google Maps).
// Called ONCE here in the processor — do NOT apply any offset in Flutter.
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

// ── Reverse geocode using Nominatim (free, no API key) ───────────────────────
// Only called when IOPGPS doesn't supply an address string.
// Results are cached in _geocodeCache to avoid hammering Nominatim.
const _geocodeCache = new Map(); // "lat5,lng5" → address string

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

// ── Trip auto-detection state ─────────────────────────────────────────────────
const IDLE_GRACE_MS    = 3 * 60 * 1000;
const MOVING_SPEED_KMH = 5;

const _tripState = new Map();

async function _handleTripDetection({
  vehicleId, imei, isOnline, speed, lat, lng, timestamp, hasValidGPS,
}) {
  if (!vehicleId || !isOnline || !hasValidGPS) return;

  const Trip = require('../models/Trip');

  const isMoving = speed > MOVING_SPEED_KMH;
  const stateKey = imei;
  const prev     = _tripState.get(stateKey) || {
    tripId: null, idleSince: null,
    lastLat: null, lastLng: null,
    maxSpeed: 0, totalDistance: 0, speedReadings: [],
  };

  function haversine(lat1, lng1, lat2, lng2) {
    const R  = 6371;
    const dL = (lat2 - lat1) * Math.PI / 180;
    const dG = (lng2 - lng1) * Math.PI / 180;
    const a  =
      Math.sin(dL/2) * Math.sin(dL/2) +
      Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
      Math.sin(dG/2) * Math.sin(dG/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  let segmentKm = 0;
  if (prev.lastLat != null && prev.lastLng != null && isMoving) {
    segmentKm = haversine(prev.lastLat, prev.lastLng, lat, lng);
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
          global.io.emit('trip_started', {
            tripId:    tripId.toString(),
            vehicleId: vehicleId.toString(),
            imei,
          });
        }
      } catch (err) {
        logger.error('❌ createTrip error for imei=%s: %s', imei, err.message);
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
        '🏁 Trip ENDED | imei=%s | tripId=%s | %.2f km | %d min | maxSpeed=%.1f km/h',
        imei, prev.tripId, prev.totalDistance, duration, newMaxSpeed,
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
    logger.error('❌ endTrip error for imei=%s: %s', imei, err.message);
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

  const vehicleOps = [];
  const pingOps    = [];
  const now        = new Date();
  const tripTasks  = [];

  try {
    const vehicles = await Vehicle.find(
      { imei: { $in: deviceArray.map(d => d.imei) } },
      '_id imei lastKnownLocation'
    ).lean();

    const idMap = new Map(vehicles.map(v => [v.imei, v._id]));

    for (const dev of deviceArray) {
      logger.info('🔍 Raw IOP data: %s', JSON.stringify(dev));

      const vId = idMap.get(dev.imei);
      if (!vId) {
        logger.warn('⚠️ No vehicle found in DB for IMEI: %s', dev.imei);
        continue;
      }

      // ── Timestamp ─────────────────────────────────────────────────────────
      // dev.gpsTime from Wanway is Unix epoch in SECONDS — multiply by 1000.
      const timestamp = dev.gpsTime
        ? new Date(dev.gpsTime * 1000)
        : dev.signalTime
          ? new Date(dev.signalTime * 1000)
          : now;

      // ── Coordinate conversion: GCJ-02 → WGS-84 ───────────────────────────
      // Wanway/IOPGPS always sends GCJ-02 (China encrypted) coordinates.
      // We convert here ONCE. The Flutter app must NOT apply any additional
      // offset — set _applyOffset() to a passthrough (return LatLng(lat, lng)).
      const rawLat = dev.lat != null ? parseFloat(dev.lat) : null;
      const rawLng = dev.lng != null ? parseFloat(dev.lng) : null;

      let lat = rawLat;
      let lng = rawLng;

      if (rawLat != null && rawLng != null && !isNaN(rawLat) && !isNaN(rawLng)) {
        // Only convert if coords look valid (not 0,0 null island)
        if (!(rawLat === 0 && rawLng === 0)) {
          const converted = gcj02ToWgs84(rawLng, rawLat);
          lat = converted.lat;
          lng = converted.lng;
          logger.info(
            '🗺️  GCJ02→WGS84 | IMEI=%s | raw=(%s,%s) → wgs84=(%s,%s)',
            dev.imei,
            rawLat.toFixed(6), rawLng.toFixed(6),
            lat.toFixed(6),    lng.toFixed(6)
          );
        } else {
          logger.warn('⚠️  Null-island coords (0,0) skipped for IMEI=%s', dev.imei);
          lat = null;
          lng = null;
        }
      }

      // ── Online status ─────────────────────────────────────────────────────
      // Device is considered online if it reported within the last 5 minutes.
      const fiveMinutesAgo = (Date.now() / 1000) - 300;
      const isOnline = dev.signalTime != null && dev.signalTime >= fiveMinutesAgo;

      // ── GPS validity ──────────────────────────────────────────────────────
      const hasValidGPS =
        lat != null && lng != null &&
        !isNaN(lat) && !isNaN(lng) &&
        !(lat === 0 && lng === 0);

      const speed = dev.speed ?? 0;

      // ── Address resolution ────────────────────────────────────────────────
      // Priority: (1) address from IOPGPS response, (2) Nominatim reverse
      // geocode, (3) coordinate string. "Unknown location" never reaches Flutter.
      let address = null;

      if (dev.address && dev.address.trim().length > 0) {
        // 1. Direct from IOPGPS — most reliable, zero extra latency
        address = dev.address.trim();
        logger.info('📍 Address from IOPGPS: %s', address);
      } else if (hasValidGPS) {
        // 2. Nominatim reverse geocode (cached, free)
        address = await _reverseGeocode(lat, lng);
        if (address) logger.info('📍 Address from Nominatim: %s', address);
      }

      // 3. Coordinate string fallback — always better than "Unknown location"
      if (!address && hasValidGPS) {
        address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        logger.info('📍 Address fallback (coords): %s', address);
      }

      logger.info(
        '✅ Processed | IMEI=%s | online=%s | gps=%s | lat=%s | lng=%s | spd=%s | addr=%s',
        dev.imei, isOnline, hasValidGPS,
        lat?.toFixed(6), lng?.toFixed(6), speed, address
      );

      // ── Base DB update fields ─────────────────────────────────────────────
      const baseUpdate = {
        speed,
        heading:    dev.course ?? 0,
        isOnline,
        isLive:     isOnline,
        lastUpdate: now,
        status: !isOnline
          ? 'offline'
          : speed > MOVING_SPEED_KMH
            ? 'moving'
            : 'idle',
      };

      if (hasValidGPS) {
        // Store under both naming conventions for max compatibility
        // with existing vehicleController queries
        baseUpdate.lat       = lat;
        baseUpdate.lng       = lng;
        baseUpdate.latitude  = lat;
        baseUpdate.longitude = lng;
      }

      // Always write address to top-level fields so vehicleController
      // can select them without digging into lastKnownLocation
      if (address) {
        baseUpdate.address           = address;
        baseUpdate.location          = address;
        baseUpdate.formattedLocation = address;
      }

      // ── lastKnownLocation sub-document ────────────────────────────────────
      const conditionalUpdate = {};
      if (hasValidGPS) {
        conditionalUpdate.lastKnownLocation = {
          latitude:  lat,
          longitude: lng,
          speed,
          heading:   dev.course    ?? 0,
          altitude:  dev.altitude  ?? 0,
          voltage:   dev.extVoltage != null ? dev.extVoltage / 10 : null,
          odometer:  dev.odometer  ?? dev.mileage ?? null,
          address:   address ?? null,
          timestamp,
        };
      }

      if (isOnline && hasValidGPS) {
        conditionalUpdate.lastOnlineAt = timestamp;
      }

      vehicleOps.push({
        updateOne: {
          filter: { imei: dev.imei },
          update: { $set: { ...baseUpdate, ...conditionalUpdate } },
        },
      });

      // ── Socket push to Flutter ────────────────────────────────────────────
      // IMPORTANT: event name is 'vehicleMovement' (camelCase) to match
      // gps.server.js and the FleetProvider socket listener in Flutter.
      // Do NOT use 'vehicle_movement' (snake_case) — Flutter won't receive it.
      if (global.io && hasValidGPS) {
        global.io.emit('vehicleMovement', {
          // Identity
          id:   vId?.toString(),
          imei: dev.imei,

          // ✅ WGS-84 converted coordinates — Flutter must NOT re-offset these
          lat,
          lng,
          latitude:  lat,
          longitude: lng,

          // Motion
          speed,
          heading:  dev.course ?? 0,

          // Status
          isOnline,
          isLive:   isOnline,
          status:   baseUpdate.status,

          // GPS quality
          satellites: dev.satellites ?? 0,
          accuracy:   dev.accuracy   ?? 0,

          // Battery / ignition
          voltage:   dev.extVoltage != null ? dev.extVoltage / 10 : null,
          acc:       dev.acc ?? null,

          // Address — all three field names so Flutter _resolveAddress() finds it
          address,
          location:          address,
          formattedLocation: address,

          // lastKnownLocation for Flutter's VehicleModel parsing
          lastKnownLocation: conditionalUpdate.lastKnownLocation ?? null,

          // Timestamps — both so Flutter can display GPS fix time vs server time
          // gpsTime = when the device got its GPS fix (Unix ms)
          // deviceTime = when our server received/processed it
          gpsTime:    timestamp.toISOString(),
          deviceTime: now.toISOString(),
          lastUpdate: now.toISOString(),
        });
      }

      // ── Location ping (history trail) ─────────────────────────────────────
      if (isOnline && hasValidGPS && speed > 0) {
        pingOps.push({
          vehicleId: vId,
          latitude:  lat,
          longitude: lng,
          speed,
          heading:   dev.course ?? 0,
          timestamp,
        });
      }

      tripTasks.push({
        vehicleId: vId,
        imei:      dev.imei,
        isOnline,
        speed,
        lat,
        lng,
        timestamp,
        hasValidGPS,
      });
    }

    // ── Bulk DB write ─────────────────────────────────────────────────────────
    await Promise.all([
      vehicleOps.length > 0
        ? Vehicle.bulkWrite(vehicleOps, { ordered: false })
        : Promise.resolve(),
      pingOps.length > 0
        ? LocationPing.insertMany(pingOps, { ordered: false })
        : Promise.resolve(),
    ]);

    logger.info(
      '🚀 Data Processor: Synced %d units — %d pings recorded',
      deviceArray.length, pingOps.length
    );

    // ── Trip detection (sequential to avoid race conditions) ─────────────────
    for (const task of tripTasks) {
      await _handleTripDetection(task);
    }

  } catch (err) {
    logger.error('❌ Data Processor Error: %s', err.message);
  }
}

module.exports = { processBulkUpdates };