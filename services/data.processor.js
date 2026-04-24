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

async function processBulkUpdates(deviceArray) {
  if (!deviceArray || deviceArray.length === 0) return;

  const Vehicle      = require('../models/Vehicle');
  const LocationPing = require('../models/LocationPing');

  const vehicleOps = [];
  const pingOps    = [];
  const now        = new Date();

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

      logger.info(
        '🔍 IMEI %s | isOnline=%s | hasValidGPS=%s | lat=%s | lng=%s (raw GCJ-02: %s,%s)',
        dev.imei, isOnline, hasValidGPS,
        lat?.toFixed(6), lng?.toFixed(6),
        rawLat, rawLng
      );

      // ── Base fields (always written every poll) ───────────────────────────
      const baseUpdate = {
        speed:      dev.speed  ?? 0,
        heading:    dev.course ?? 0,
        isOnline,
        isLive:     isOnline,
        lastUpdate: now,
        status: !isOnline
          ? 'offline'
          : (dev.speed ?? 0) > 5
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
          speed:     dev.speed  ?? 0,
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
      if (isOnline && hasValidGPS && (dev.speed ?? 0) > 0) {
        pingOps.push({
          vehicleId: vId,
          latitude:  lat,                   // WGS-84
          longitude: lng,                   // WGS-84
          speed:     dev.speed,
          heading:   dev.course ?? 0,
          timestamp,
        });
      }
    }

    // ── Commit to MongoDB ─────────────────────────────────────────────────
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

  } catch (err) {
    logger.error('❌ Data Processor Error: %s', err.message);
  }
}

module.exports = { processBulkUpdates };