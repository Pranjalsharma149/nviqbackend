'use strict';

const logger = require('../utils/logger');

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
      // ✅ DEBUG — remove once working correctly
      logger.info('🔍 Raw IOP data: %s', JSON.stringify(dev));

      const vId = idMap.get(dev.imei);
      if (!vId) {
        logger.warn('⚠️ No vehicle found in DB for IMEI: %s', dev.imei);
        continue;
      }

      // ✅ IOPGPS sends gpsTime/signalTime as unix seconds
      const timestamp = dev.gpsTime
        ? new Date(dev.gpsTime * 1000)
        : dev.signalTime
          ? new Date(dev.signalTime * 1000)
          : now;

      // ✅ IOPGPS sends lat/lng as STRINGS, not latitude/longitude as numbers
      const lat = dev.lat != null ? parseFloat(dev.lat) : null;
      const lng = dev.lng != null ? parseFloat(dev.lng) : null;

      // ✅ IOPGPS uses accStatus (boolean) not online (integer)
      const isOnline = dev.online === 1 || dev.accStatus === true;

      // ✅ Valid GPS = parsed floats, not NaN, not 0,0
      const hasValidGPS =
        lat != null && lng != null &&
        !isNaN(lat) && !isNaN(lng) &&
        !(lat === 0 && lng === 0);

      logger.info(
        '🔍 IMEI %s | isOnline=%s | hasValidGPS=%s | lat=%s | lng=%s',
        dev.imei, isOnline, hasValidGPS, lat, lng
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

      // Always update live coords when GPS is valid
      if (hasValidGPS) {
        baseUpdate.latitude  = lat;
        baseUpdate.longitude = lng;
      }

      // ── lastKnownLocation ─────────────────────────────────────────────────
      // ✅ Written whenever we have valid GPS — online OR offline
      // This is what Flutter shows when isOnline === false
      const conditionalUpdate = {};
      if (hasValidGPS) {
        conditionalUpdate.lastKnownLocation = {
          latitude:  lat,
          longitude: lng,
          speed:     dev.speed  ?? 0,
          heading:   dev.course ?? 0,
          altitude:  dev.altitude ?? 0,
          // ✅ extVoltage comes as integer e.g. 129 = 12.9V
          voltage:   dev.extVoltage != null ? dev.extVoltage / 10 : null,
          odometer:  dev.odometer   ?? null,
          timestamp,
        };
      }

      // ✅ lastOnlineAt — only update when device was actually online
      if (isOnline && hasValidGPS) {
        conditionalUpdate.lastOnlineAt = timestamp;
      }

      vehicleOps.push({
        updateOne: {
          filter: { imei: dev.imei },
          update: {
            $set: { ...baseUpdate, ...conditionalUpdate }
          }
        }
      });

      // ── Location ping (trip history) ──────────────────────────────────────
      // Only record when moving + online + valid GPS
      if (isOnline && hasValidGPS && (dev.speed ?? 0) > 0) {
        pingOps.push({
          vehicleId: vId,
          latitude:  lat,
          longitude: lng,
          speed:     dev.speed,
          heading:   dev.course ?? 0,
          timestamp,
        });
      }
    }

    // ── Commit to MongoDB ──────────────────────────────────────────────────
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