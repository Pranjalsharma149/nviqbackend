'use strict';

/**
 * services/persistentSync.service.js
 *
 * Server-side handler for Flutter's PersistentSyncService calls.
 *
 * Flutter live_tracking_screen.dart calls (via fleet_provider):
 *   _persistentSync.recordGPSFixWithOdometer(...)  → saves a RawGpsLog entry
 *   _persistentSync.getAllVehicleSummaries()        → returns per-vehicle summary map
 *
 * These are called via the REST API:
 *   POST /api/sync/gps-fix          → recordGPSFix
 *   GET  /api/sync/vehicle-summaries → getVehicleSummaries
 *
 * Mount in server.js as:
 *   app.use('/api/sync', require('./routes/sync.routes'));
 */

const mongoose     = require('mongoose');
const RawGpsLog    = require('../models/RawGpsLog');
const DailySummary = require('../models/DailySummary');
const Vehicle      = require('../models/Vehicle');
const logger       = require('../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// UTC midnight for a Date
function utcDayStart(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync/gps-fix
//
// Flutter calls this via _tryRecordGPSFix() in live_tracking_screen.dart.
// Saves one GPS fix to RawGpsLog and updates Vehicle live telemetry.
//
// Body (all fields Flutter sends):
// {
//   vehicleId, latitude, longitude, speed, heading,
//   accuracy, satellites, batteryVoltage, ignitionOn,
//   gpsTime, deviceTime, address,
//   serverOdometerKm, todayDistance, source
// }
// ─────────────────────────────────────────────────────────────────────────────
async function recordGPSFix(req, res) {
  try {
    const {
      vehicleId,
      latitude,
      longitude,
      speed         = 0,
      heading       = 0,
      accuracy      = 0,
      satellites    = 0,
      batteryVoltage = 0,
      ignitionOn    = false,
      gpsTime,
      deviceTime,
      address       = '',
      serverOdometerKm = null,
      todayDistance = 0,
      source        = 'wanway',
    } = req.body;

    // ── Validation ────────────────────────────────────────────────────────────
    if (!vehicleId || !isValidObjectId(vehicleId)) {
      return res.status(400).json({ success: false, message: 'Valid vehicleId required' });
    }
    if (latitude == null || longitude == null) {
      return res.status(400).json({ success: false, message: 'latitude and longitude required' });
    }

    const vid        = new mongoose.Types.ObjectId(vehicleId);
    const gpsTs      = gpsTime    ? new Date(gpsTime)    : new Date();
    const deviceTs   = deviceTime ? new Date(deviceTime) : new Date();

    // ── Duplicate check (same imei + same gpsTimestamp) ───────────────────────
    const vehicle = await Vehicle.findById(vid).select('imei').lean();
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    const isDuplicate = await RawGpsLog.exists({
      vehicleId:    vid,
      gpsTimestamp: gpsTs,
      latitude,
      longitude,
    });

    // ── Save to RawGpsLog ──────────────────────────────────────────────────────
    const log = await RawGpsLog.create({
      imei:            vehicle.imei ?? '',
      vehicleId:       vid,
      latitude,
      longitude,
      speed,
      heading,
      ignition:        ignitionOn,
      status:          speed > 1 ? 'moving' : ignitionOn ? 'idle' : 'offline',
      source:          ['tcp', 'wanway'].includes(source) ? source : 'wanway',
      gpsTimestamp:    gpsTs,
      serverTimestamp: deviceTs,
      satellites,
      accuracy,
      voltage:         batteryVoltage > 0 ? batteryVoltage : null,
      odometer:        serverOdometerKm  > 0 ? serverOdometerKm : null,
      isDuplicate:     !!isDuplicate,
    });

    // ── Update Vehicle live telemetry ─────────────────────────────────────────
    // Only update if this fix is newer than what's stored
    const updatePayload = {
      lat:       latitude,
      lng:       longitude,
      latitude,
      longitude,
      speed,
      heading,
      isOnline:  true,
      lastUpdate: deviceTs,
      lastGpsTime: gpsTs,
      status:    speed > 1 ? 'moving' : ignitionOn ? 'idle' : 'parked',
    };

    if (address) {
      updatePayload.address           = address;
      updatePayload.formattedLocation = address;
      updatePayload.location          = address;
      updatePayload['lastKnownLocation.address'] = address;
    }

    if (batteryVoltage > 0) {
      updatePayload['lastKnownLocation.voltage'] = batteryVoltage;
    }

    if (serverOdometerKm > 0) {
      updatePayload['lastKnownLocation.odometer'] = serverOdometerKm;
    }

    await Vehicle.findByIdAndUpdate(vid, { $set: updatePayload });

    // ── Update today's DailySummary (partial, intra-day update) ───────────────
    if (todayDistance > 0) {
      const todayStart = utcDayStart(gpsTs);
      await DailySummary.findOneAndUpdate(
        { vehicleId: vid, date: todayStart },
        {
          $set: {
            vehicleId:  vid,
            imei:       vehicle.imei ?? '',
            date:       todayStart,
            isPartial:  true,
          },
          $max: {
            // Only update totalDistance if the new value is larger
            // (avoids overwriting accurate nightly cron values with stale data)
            totalDistance: todayDistance,
          },
        },
        { upsert: true }
      );
    }

    logger.debug(
      '📍 [SyncService] GPS fix saved | vehicle=%s | %.5f,%.5f | spd=%d | ign=%s',
      vehicleId, latitude, longitude, speed, ignitionOn
    );

    return res.status(201).json({
      success: true,
      data: { id: log._id.toString() },
    });

  } catch (err) {
    logger.error('[SyncService] recordGPSFix: %s', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sync/vehicle-summaries
//
// Flutter's PersistentSyncService.getAllVehicleSummaries() calls this
// during cold-start hydration in _loadLastFixTimes() and _hydrateColdStartData().
//
// Returns a map of vehicleId → summary so Flutter can seed _VState with
// real data before the first live GPS packet arrives.
//
// Flutter reads from summary:
//   summary.totalOdometerKm    → odometer panel
//   summary.todayDistanceKm    → today distance panel
//   summary.lastSatelliteCount → GPS signal panel
//   summary.engineHoursToday   → today hours panel
//   summary.lastGpsTime        → last fix time
//   summary.lastSeenTime       → last seen label
// ─────────────────────────────────────────────────────────────────────────────
async function getVehicleSummaries(req, res) {
  try {
    // Today start in UTC
    const todayStart = utcDayStart(new Date());

    // All vehicles
    const vehicles = await Vehicle.find({})
      .select('_id imei speed heading isOnline status lastUpdate lastGpsTime lastKnownLocation')
      .lean();

    if (!vehicles.length) {
      return res.json({ success: true, data: {} });
    }

    const vehicleIds = vehicles.map(v => v._id);

    // Today's DailySummary for all vehicles (one query)
    const dailies = await DailySummary.find({
      vehicleId: { $in: vehicleIds },
      date:      todayStart,
    })
      .select('vehicleId totalDistance engineHours')
      .lean();

    const dailyMap = new Map(
      dailies.map(d => [d.vehicleId.toString(), d])
    );

    // Latest odometer per vehicle (one aggregation)
    const odoAgg = await RawGpsLog.aggregate([
      {
        $match: {
          vehicleId: { $in: vehicleIds },
          odometer:  { $ne: null, $gt: 0 },
        },
      },
      { $sort: { gpsTimestamp: -1 } },
      {
        $group: {
          _id:      '$vehicleId',
          odometer: { $first: '$odometer' },
        },
      },
    ]);

    const odoMap = new Map(
      odoAgg.map(o => [o._id.toString(), o.odometer])
    );

    // Latest satellite count per vehicle (one aggregation)
    const satAgg = await RawGpsLog.aggregate([
      {
        $match: {
          vehicleId:  { $in: vehicleIds },
          satellites: { $gt: 0 },
        },
      },
      { $sort: { gpsTimestamp: -1 } },
      {
        $group: {
          _id:        '$vehicleId',
          satellites: { $first: '$satellites' },
        },
      },
    ]);

    const satMap = new Map(
      satAgg.map(s => [s._id.toString(), s.satellites])
    );

    // Build result map
    const result = {};

    for (const v of vehicles) {
      const vid    = v._id.toString();
      const daily  = dailyMap.get(vid);
      const odo    = odoMap.get(vid)   ?? 0;
      const sats   = satMap.get(vid)   ?? 0;

      result[vid] = {
        vehicleId:          vid,

        // Flutter _hydrateColdStartData reads these
        todayDistanceKm:    daily?.totalDistance ?? 0,
        totalOdometerKm:    odo,
        engineHoursToday:   daily?.engineHours   ?? 0,
        lastSatelliteCount: sats,

        // Flutter _loadLastFixTimes reads these
        lastGpsTime:  v.lastGpsTime  ?? v.lastKnownLocation?.timestamp ?? v.lastUpdate ?? null,
        lastSeenTime: v.lastUpdate   ?? null,
        lastUpdate:   v.lastUpdate   ?? null,

        // Extra context
        isOnline: v.isOnline ?? false,
        speed:    v.speed    ?? 0,
        status:   v.status   ?? 'offline',
      };
    }

    return res.json({ success: true, data: result });

  } catch (err) {
    logger.error('[SyncService] getVehicleSummaries: %s', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = {
  recordGPSFix,
  getVehicleSummaries,
};