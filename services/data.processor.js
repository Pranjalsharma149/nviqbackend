'use strict';

const logger = require('../utils/logger');

// ── GCJ-02 → WGS-84 coordinate converter ─────────────────────────────────────
//
// WHY THIS IS NEEDED:
//   wanwaygps.com (IOP GPS) is a Chinese platform. It returns ALL coordinates
//   in GCJ-02 format (China's encrypted "Mars Coordinates") regardless of
//   where the physical device is located — including India.
//
//   Google Maps and Flutter expect WGS-84 (standard GPS).
//   Without this conversion the map marker is offset by ~484 metres.
//
// PROOF (from actual log data lat=27.386688, lng=76.662071):
//   Raw IOP (GCJ-02) : lat=27.386688, lng=76.662071
//   Converted (WGS-84): lat=27.390493, lng=76.659688
//   Offset            : 484 metres
//
//   Raw (wrong):      https://maps.google.com/?q=27.386688,76.662071
//   Converted (real): https://maps.google.com/?q=27.390493,76.659688
//
// DO NOT REMOVE THIS CONVERSION.
// ─────────────────────────────────────────────────────────────────────────────
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


// ── Trip auto-detection state ─────────────────────────────────────────────────
//
// We keep an in-memory map of:  imei → { tripId, startSpeed, lastMovingAt }
//
// Rules:
//   • Vehicle transitions from idle/stopped → speed > 5 km/h
//     → create a new Trip document (if none open already)
//
//   • Vehicle transitions from moving → speed ≤ 5 km/h  AND
//     stays stopped for IDLE_GRACE_MS (default 3 minutes)
//     → end the open Trip, save stats
//
// The grace period prevents micro-stops (traffic lights, junctions)
// from splitting one journey into many small trips.
// ─────────────────────────────────────────────────────────────────────────────
const IDLE_GRACE_MS   = 3 * 60 * 1000;   // 3 minutes of stillness before ending trip
const MOVING_SPEED_KMH = 5;              // km/h threshold

// imei → { tripId: ObjectId|string, idleSince: Date|null, lastLat, lastLng, maxSpeed, totalDistance, speedReadings }
const _tripState = new Map();

/**
 * Auto-detect trip start/end for one vehicle.
 * Called after the vehicle document has already been written to MongoDB.
 */
async function _handleTripDetection({
  vehicleId,    // Mongo ObjectId (from DB lookup)
  imei,
  isOnline,
  speed,        // km/h — already parsed
  lat,          // WGS-84
  lng,
  timestamp,
  hasValidGPS,
}) {
  if (!vehicleId || !isOnline || !hasValidGPS) return;

  const Trip = require('../models/Trip');

  const isMoving  = speed > MOVING_SPEED_KMH;
  const stateKey  = imei;
  const prev      = _tripState.get(stateKey) || {
    tripId:        null,
    idleSince:     null,
    lastLat:       null,
    lastLng:       null,
    maxSpeed:      0,
    totalDistance: 0,
    speedReadings: [],
  };

  // ── Distance calculation (Haversine, km) ───────────────────────────────────
  function haversine(lat1, lng1, lat2, lng2) {
    const R  = 6371;
    const dL = (lat2 - lat1) * Math.PI / 180;
    const dG = (lng2 - lng1) * Math.PI / 180;
    const a  =
      Math.sin(dL / 2) * Math.sin(dL / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dG / 2) * Math.sin(dG / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Accumulate distance between consecutive GPS pings
  let segmentKm = 0;
  if (prev.lastLat != null && prev.lastLng != null && isMoving) {
    segmentKm = haversine(prev.lastLat, prev.lastLng, lat, lng);
    // Sanity cap: ignore jumps > 5 km per poll (GPS glitch / tunnel exit)
    if (segmentKm > 5) segmentKm = 0;
  }

  const newTotalDistance = prev.totalDistance + segmentKm;
  const newMaxSpeed      = Math.max(prev.maxSpeed, speed);
  const newSpeedReadings = isMoving
    ? [...prev.speedReadings, speed]
    : prev.speedReadings;

  // ── CASE 1: Vehicle is MOVING ──────────────────────────────────────────────
  if (isMoving) {
    let tripId = prev.tripId;

    // No open trip → create one
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

        // Notify Flutter via socket
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

    // Reset idle timer because vehicle is moving
    _tripState.set(stateKey, {
      tripId,
      idleSince:     null,
      lastLat:       lat,
      lastLng:       lng,
      maxSpeed:      newMaxSpeed,
      totalDistance: newTotalDistance,
      speedReadings: newSpeedReadings,
    });
    return;
  }

  // ── CASE 2: Vehicle is STOPPED / IDLE ─────────────────────────────────────
  const idleSince = prev.idleSince ?? new Date();

  // No open trip — nothing to end, just track idle start
  if (!prev.tripId) {
    _tripState.set(stateKey, {
      ...prev,
      idleSince,
      lastLat: lat,
      lastLng: lng,
    });
    return;
  }

  // Has open trip but just stopped — start/continue grace period
  const idleMs = Date.now() - idleSince.getTime();

  if (idleMs < IDLE_GRACE_MS) {
    // Within grace period — update idle start but keep trip open
    _tripState.set(stateKey, {
      ...prev,
      idleSince,
      lastLat:       lat,
      lastLng:       lng,
      maxSpeed:      newMaxSpeed,
      totalDistance: newTotalDistance,
      speedReadings: newSpeedReadings,
    });
    return;
  }

  // ── Grace period EXPIRED → END the trip ───────────────────────────────────
  try {
    const avgSpeed = prev.speedReadings.length > 0
      ? prev.speedReadings.reduce((a, b) => a + b, 0) / prev.speedReadings.length
      : 0;

    const openTrip = await Trip.findById(prev.tripId);
    if (openTrip && !openTrip.isCompleted) {
      const endTime  = timestamp;
      const duration = Math.round((endTime - openTrip.startTime) / 60000); // minutes

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

  // Reset state — no open trip
  _tripState.set(stateKey, {
    tripId:        null,
    idleSince:     null,
    lastLat:       lat,
    lastLng:       lng,
    maxSpeed:      0,
    totalDistance: 0,
    speedReadings: [],
  });
}
// ─────────────────────────────────────────────────────────────────────────────


async function processBulkUpdates(deviceArray) {
  if (!deviceArray || deviceArray.length === 0) return;

  const Vehicle      = require('../models/Vehicle');
  const LocationPing = require('../models/LocationPing');

  const vehicleOps = [];
  const pingOps    = [];
  const now        = new Date();

  // Collect trip detection tasks to run after the bulk write
  const tripTasks  = [];

  try {
    const vehicles = await Vehicle.find({
      imei: { $in: deviceArray.map(d => d.imei) }
    }, '_id imei lastKnownLocation').lean();

    const idMap = new Map(vehicles.map(v => [v.imei, v._id]));

    for (const dev of deviceArray) {
      // DEBUG — remove once working correctly
      logger.info('🔍 Raw IOP data: %s', JSON.stringify(dev));

      const vId = idMap.get(dev.imei);
      if (!vId) {
        logger.warn('⚠️ No vehicle found in DB for IMEI: %s', dev.imei);
        continue;
      }

      // IOPGPS sends gpsTime/signalTime as unix seconds
      const timestamp = dev.gpsTime
        ? new Date(dev.gpsTime * 1000)
        : dev.signalTime
          ? new Date(dev.signalTime * 1000)
          : now;

      // IOPGPS sends lat/lng as STRINGS — parse first, then convert GCJ-02 → WGS-84
      const rawLat = dev.lat != null ? parseFloat(dev.lat) : null;
      const rawLng = dev.lng != null ? parseFloat(dev.lng) : null;

      // Convert GCJ-02 → WGS-84 so Flutter / Google Maps shows the correct location
      const { lat, lng } = (rawLat != null && rawLng != null)
        ? gcj02ToWgs84(rawLng, rawLat)
        : { lat: rawLat, lng: rawLng };

      // Online = signalTime received within last 5 minutes
      // NOTE: accStatus is ignition (on/off), NOT connectivity — not used for isOnline
      const fiveMinutesAgo = (Date.now() / 1000) - 300;
      const isOnline = dev.signalTime != null && dev.signalTime >= fiveMinutesAgo;

      // Valid GPS = parsed floats, not NaN, not 0,0
      const hasValidGPS =
        lat != null && lng != null &&
        !isNaN(lat) && !isNaN(lng) &&
        !(lat === 0 && lng === 0);

      const speed = dev.speed ?? 0;

      logger.info(
        '🔍 IMEI %s | isOnline=%s | hasValidGPS=%s | lat=%s | lng=%s (raw GCJ-02: %s,%s) | speed=%s',
        dev.imei, isOnline, hasValidGPS,
        lat?.toFixed(6), lng?.toFixed(6),
        rawLat, rawLng, speed
      );

      // ── Base fields (always written every poll) ───────────────────────────
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

      // Update live coords when GPS is valid (WGS-84)
      if (hasValidGPS) {
        baseUpdate.latitude  = lat;
        baseUpdate.longitude = lng;
      }

      // ── lastKnownLocation ─────────────────────────────────────────────────
      // Written whenever we have valid GPS — online OR offline.
      // This is what Flutter shows when isOnline === false.
      const conditionalUpdate = {};
      if (hasValidGPS) {
        conditionalUpdate.lastKnownLocation = {
          latitude:  lat,                   // WGS-84
          longitude: lng,                   // WGS-84
          speed,
          heading:   dev.course ?? 0,
          altitude:  dev.altitude ?? 0,
          // extVoltage is integer e.g. 130 = 13.0V
          voltage:   dev.extVoltage != null ? dev.extVoltage / 10 : null,
          odometer:  dev.odometer   ?? null,
          timestamp,
        };
      }

      // lastOnlineAt — only update when device was actually online
      if (isOnline && hasValidGPS) {
        conditionalUpdate.lastOnlineAt = timestamp;
      }

      vehicleOps.push({
        updateOne: {
          filter: { imei: dev.imei },
          update: { $set: { ...baseUpdate, ...conditionalUpdate } }
        }
      });

      // ── Location ping (trip history) ──────────────────────────────────────
      // Only record when moving + online + valid GPS
      if (isOnline && hasValidGPS && speed > 0) {
        pingOps.push({
          vehicleId: vId,
          latitude:  lat,                   // WGS-84
          longitude: lng,                   // WGS-84
          speed,
          heading:   dev.course ?? 0,
          timestamp,
        });
      }

      // ── Queue trip detection for after the bulk write ─────────────────────
      tripTasks.push({
        vehicleId:   vId,
        imei:        dev.imei,
        isOnline,
        speed,
        lat,
        lng,
        timestamp,
        hasValidGPS,
      });
    }

    // ── Commit vehicle + ping writes to MongoDB ────────────────────────────
    await Promise.all([
      vehicleOps.length > 0
        ? Vehicle.bulkWrite(vehicleOps, { ordered: false })
        : Promise.resolve(),
      pingOps.length > 0
        ? LocationPing.insertMany(pingOps, { ordered: false })
        : Promise.resolve(),
    ]);

    logger.info(
      `🚀 Data Processor: Synced ${deviceArray.length} units — ` +
      `${pingOps.length} pings recorded`
    );

    // ── Run trip detection AFTER bulk write succeeds ───────────────────────
    // Run sequentially (not Promise.all) to avoid race conditions on _tripState
    for (const task of tripTasks) {
      await _handleTripDetection(task);
    }

  } catch (err) {
    logger.error('❌ Data Processor Error: %s', err.message);
  }
}

module.exports = { processBulkUpdates };