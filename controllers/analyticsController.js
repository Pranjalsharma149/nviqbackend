'use strict';

/**
 * controllers/analyticsController.js
 *
 * Express controller that backs the /api/analytics/* routes.
 *
 * Routes (from analytics.routes.js):
 *   GET /fleet/summary              → getFleetSummary
 *   GET /fleet/trends               → getFleetTrends
 *   GET /vehicles/:id               → getVehicleAnalytics
 *   GET /vehicles/:id/playback      → getPlayback
 *   GET /vehicles/:id/live          → getLiveStats
 *   GET /vehicles/:id/mileage       → getMileageReport
 *   GET /vehicles/:id/device-info   → getDeviceInfo
 *
 * Flutter live_tracking_screen.dart calls:
 *   fleet.fetchMileageReport(id, date) → GET /vehicles/:id/mileage?date=YYYY-MM-DD
 *   fleet.fetchDeviceInfo(id)          → GET /vehicles/:id/device-info
 *   fleet.fetchTripHistory(id, date)   → GET /vehicles/:id/playback?date=YYYY-MM-DD
 *   fleet.getLiveStats(id)             → GET /vehicles/:id/live
 *   fleet.getFleetSummary()            → GET /fleet/summary
 */

const mongoose         = require('mongoose');
const AnalyticsService = require('../services/analytics.service');
const DailySummary     = require('../models/DailySummary');
const Vehicle          = require('../models/Vehicle');
const RawGpsLog        = require('../models/RawGpsLog');
const logger           = require('../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function sendError(res, status, message, detail = undefined) {
  const body = { success: false, message };
  if (detail && process.env.NODE_ENV !== 'production') body.detail = detail;
  return res.status(status).json(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/fleet/summary
// ─────────────────────────────────────────────────────────────────────────────
async function getFleetSummary(req, res) {
  try {
    const data = await AnalyticsService.getFleetSummary();
    return res.json({ success: true, data });
  } catch (err) {
    logger.error('[AnalyticsCtrl] getFleetSummary: %s', err.message);
    return sendError(res, 500, 'Failed to fetch fleet summary', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/fleet/trends
//   ?days=7           Rolling window (1-90, default 7)
//   ?vehicleId=...    Optional: single vehicle trends
// ─────────────────────────────────────────────────────────────────────────────
async function getFleetTrends(req, res) {
  try {
    const days      = Math.min(Math.max(parseInt(req.query.days ?? 7, 10), 1), 90);
    const vehicleId = req.query.vehicleId;

    const endDate   = new Date();
    const startDate = new Date(Date.now() - days * 86_400_000);

    if (vehicleId) {
      if (!isValidObjectId(vehicleId)) return sendError(res, 400, 'Invalid vehicleId');

      const series = await AnalyticsService.getDateRangeAnalytics(
        vehicleId,
        startDate.toISOString().split('T')[0],
        endDate.toISOString().split('T')[0]
      );
      return res.json({ success: true, data: { days, vehicleId, series } });
    }

    const pipeline = [
      {
        $match: {
          date: {
            $gte: new Date(
              Date.UTC(
                startDate.getUTCFullYear(),
                startDate.getUTCMonth(),
                startDate.getUTCDate()
              )
            ),
          },
        },
      },
      {
        $group: {
          _id:           { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          totalDistance: { $sum: '$totalDistance' },
          engineHours:   { $sum: '$engineHours' },
          idleHours:     { $sum: '$idleHours' },
          runningHours:  { $sum: '$runningHours' },
          tripCount:     { $sum: '$tripCount' },
          vehicleCount:  { $sum: 1 },
          maxSpeed:      { $max: '$maxSpeed' },
          avgSpeedSum:   { $sum: { $multiply: ['$avgSpeed', '$rawPointCount'] } },
          pointCount:    { $sum: '$rawPointCount' },
        },
      },
      {
        $project: {
          _id:           0,
          date:          '$_id',
          totalDistance: { $round: ['$totalDistance', 2] },
          engineHours:   { $round: ['$engineHours',   2] },
          idleHours:     { $round: ['$idleHours',     2] },
          runningHours:  { $round: ['$runningHours',  2] },
          tripCount:     1,
          vehicleCount:  1,
          maxSpeed:      { $round: ['$maxSpeed', 1] },
          avgSpeed: {
            $round: [
              {
                $cond: [
                  { $gt: ['$pointCount', 0] },
                  { $divide: ['$avgSpeedSum', '$pointCount'] },
                  0,
                ],
              },
              1,
            ],
          },
        },
      },
      { $sort: { date: 1 } },
    ];

    const series = await DailySummary.aggregate(pipeline);
    return res.json({ success: true, data: { days, series } });

  } catch (err) {
    logger.error('[AnalyticsCtrl] getFleetTrends: %s', err.message);
    return sendError(res, 500, 'Failed to fetch fleet trends', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/vehicles/:id/mileage
//   ?date=YYYY-MM-DD  (defaults to today)
//
// Called by Flutter as: fleet.fetchMileageReport(vehicleId, DateTime)
//
// FIX-1: todayDistanceKm  → DailySummary.totalDistance  (day's driven km)
// FIX-2: engineHours      → DailySummary.engineHours
// FIX-4: totalDistanceKm  → cumulative odometer from RawGpsLog.odometer
//         (DailySummary has no odometer field — we compute it from RawGpsLog)
// ─────────────────────────────────────────────────────────────────────────────
async function getMileageReport(req, res) {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid vehicle id');

    const vehicle = await Vehicle.findById(id)
      .select('_id imei name')
      .lean();
    if (!vehicle) return sendError(res, 404, 'Vehicle not found');

    // Default to today in IST (UTC+5:30) if no date supplied
    const dateParam = req.query.date ?? (() => {
      const d = new Date(Date.now() + 5.5 * 3600_000);
      return d.toISOString().split('T')[0];
    })();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return sendError(res, 400, 'date must be YYYY-MM-DD');
    }

    // ── FIX-1 & FIX-2: Today distance + engine hours from DailySummary ────────
    const daily = await AnalyticsService.getDailyAnalytics(id, dateParam);

    // DailySummary.totalDistance = km driven on that specific day (NOT odometer)
    const todayDistanceKm = daily?.totalDistance ?? 0;
    const engineHours     = daily?.engineHours   ?? daily?.runningHours ?? 0;

    // ── FIX-4: Cumulative odometer from RawGpsLog ─────────────────────────────
    // Strategy: use the latest non-null odometer reading from RawGpsLog.
    // This is the real cumulative odometer pushed by the device.
    // Fall back to summing all DailySummary.totalDistance if odometer is null.
    let totalDistanceKm = 0;

    const latestOdoLog = await RawGpsLog.findOne({
      vehicleId: new mongoose.Types.ObjectId(id),
      odometer:  { $ne: null, $gt: 0 },
    })
      .sort({ gpsTimestamp: -1 })
      .select('odometer')
      .lean();

    if (latestOdoLog?.odometer > 0) {
      // Device pushes cumulative odometer — use it directly
      totalDistanceKm = latestOdoLog.odometer;
    } else {
      // No device odometer — sum all historical DailySummary records
      const [odometerAgg] = await DailySummary.aggregate([
        {
          $match: { vehicleId: new mongoose.Types.ObjectId(id) },
        },
        {
          $group: {
            _id:   null,
            total: { $sum: '$totalDistance' },
          },
        },
      ]);
      totalDistanceKm = odometerAgg?.total ?? 0;
    }

    return res.json({
      success: true,
      data: {
        // ── Primary field names Flutter reads first ────────────────────────────
        todayDistanceKm:  +todayDistanceKm.toFixed(2),   // FIX-1
        totalDistanceKm:  +totalDistanceKm.toFixed(2),   // FIX-4
        engineHours:      +engineHours.toFixed(2),        // FIX-2

        // ── Alias fallback names Flutter tries if primary returns 0 ───────────
        dailyDistance:    +todayDistanceKm.toFixed(2),
        distanceToday:    +todayDistanceKm.toFixed(2),
        odometer:         +totalDistanceKm.toFixed(2),
        odometerKm:       +totalDistanceKm.toFixed(2),
        totalEngineHours: +engineHours.toFixed(2),
        runningHours:     +engineHours.toFixed(2),

        // ── Meta ──────────────────────────────────────────────────────────────
        date:        dateParam,
        vehicleId:   id,
        vehicleName: vehicle.name,
      },
    });

  } catch (err) {
    logger.error('[AnalyticsCtrl] getMileageReport [%s]: %s', req.params.id, err.message);
    return sendError(res, 500, 'Failed to fetch mileage report', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/vehicles/:id/device-info
//
// Called by Flutter as: fleet.fetchDeviceInfo(vehicleId)
//
// FIX-6: Flutter's _fetchInstallDate() reads these field names in order:
//   activationTime, registrationTime, installDate, install_date,
//   deviceRegistered, firstSeen, created_at, createdAt,
//   addTime, add_time, activateTime, activate_time
//
// Vehicle model has NO activationTime field — we use createdAt (timestamps:true)
// which is always present and represents when the vehicle was added to the system.
// ─────────────────────────────────────────────────────────────────────────────
async function getDeviceInfo(req, res) {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid vehicle id');

    const vehicle = await Vehicle.findById(id)
      .select('_id imei name vehicleReg type createdAt updatedAt')
      .lean();

    if (!vehicle) return sendError(res, 404, 'Vehicle not found');

    // createdAt is always present (timestamps: true in Vehicle schema)
    // This is the device registration/install date
    const installTs = vehicle.createdAt instanceof Date
      ? vehicle.createdAt.toISOString()
      : vehicle.createdAt
        ? new Date(vehicle.createdAt).toISOString()
        : new Date().toISOString();

    return res.json({
      success: true,
      data: {
        // All field-name variants Flutter's _firstStr() checks
        activationTime:   installTs,
        registrationTime: installTs,
        installDate:      installTs,
        install_date:     installTs,
        deviceRegistered: installTs,
        firstSeen:        installTs,
        created_at:       installTs,
        createdAt:        installTs,
        addTime:          installTs,
        add_time:         installTs,
        activateTime:     installTs,
        activate_time:    installTs,

        // Device details
        vehicleId:   id,
        imei:        vehicle.imei        ?? null,
        name:        vehicle.name        ?? null,
        plateNumber: vehicle.vehicleReg  ?? null,
        vehicleType: vehicle.type        ?? 'car',
      },
    });

  } catch (err) {
    logger.error('[AnalyticsCtrl] getDeviceInfo [%s]: %s', req.params.id, err.message);
    return sendError(res, 500, 'Failed to fetch device info', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/vehicles/:id
//   ?days=7        Rolling window (default 7)
//   ?date=YYYY-MM-DD  Single day (overrides ?days)
//   ?playback=true    Include GPS playback points in response
//   ?page=1&limit=20  Pagination for trips
// ─────────────────────────────────────────────────────────────────────────────
async function getVehicleAnalytics(req, res) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid vehicle id');

    const vehicle = await Vehicle.findById(id)
      .select('_id imei name vehicleReg')
      .lean();
    if (!vehicle) return sendError(res, 404, 'Vehicle not found');

    const dateParam = req.query.date;

    // ── Single-day mode ───────────────────────────────────────────────────────
    if (dateParam) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        return sendError(res, 400, 'date must be YYYY-MM-DD');
      }

      const [daily, trips] = await Promise.all([
        AnalyticsService.getDailyAnalytics(id, dateParam),
        AnalyticsService.getTrips(id, {
          startDate: dateParam,
          endDate:   dateParam,
          limit:     50,
          page:      1,
        }),
      ]);

      const responseData = {
        vehicle: {
          id:          vehicle._id,
          imei:        vehicle.imei,
          name:        vehicle.name,
          plateNumber: vehicle.vehicleReg,
        },
        daily,
        trips,
      };

      if (req.query.playback === 'true') {
        const maxPts = Math.min(parseInt(req.query.maxPoints ?? 500, 10), 2000);
        responseData.playback = await AnalyticsService.getPlayback(id, dateParam, maxPts);
      }

      return res.json({ success: true, data: responseData });
    }

    // ── Rolling window mode ───────────────────────────────────────────────────
    const days  = Math.min(Math.max(parseInt(req.query.days  ?? 7,  10), 1), 90);
    const page  = Math.max(parseInt(req.query.page  ?? 1,  10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? 20, 10), 1), 100);

    const [analytics, trips] = await Promise.all([
      AnalyticsService.getVehicleAnalytics(id, { days }),
      AnalyticsService.getTrips(id, { limit, page }),
    ]);

    return res.json({
      success: true,
      data: {
        vehicle: {
          id:          vehicle._id,
          imei:        vehicle.imei,
          name:        vehicle.name,
          plateNumber: vehicle.vehicleReg,
        },
        analytics,
        trips,
      },
    });

  } catch (err) {
    logger.error('[AnalyticsCtrl] getVehicleAnalytics [%s]: %s', req.params.id, err.message);
    return sendError(res, 500, 'Failed to fetch vehicle analytics', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/vehicles/:id/playback
//   ?date=YYYY-MM-DD (required)
//   ?maxPoints=500
//
// Flutter fetchTripHistory(id, date) expects a List of points.
// The fleet_provider must unwrap data.points before returning to Flutter.
// ─────────────────────────────────────────────────────────────────────────────
async function getPlayback(req, res) {
  try {
    const { id }   = req.params;
    const { date } = req.query;

    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid vehicle id');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return sendError(res, 400, 'date (YYYY-MM-DD) is required');
    }

    const maxPoints = Math.min(parseInt(req.query.maxPoints ?? 500, 10), 2000);
    const result    = await AnalyticsService.getPlayback(id, date, maxPoints);

    return res.json({ success: true, data: result });

  } catch (err) {
    logger.error('[AnalyticsCtrl] getPlayback: %s', err.message);
    return sendError(res, 500, 'Failed to fetch playback data', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/vehicles/:id/live
//
// Returns current live stats for Flutter's live panel.
// Response: { speed, ignitionOn, satellites, batteryVoltage, heading,
//             todayDistanceKm, engineHours, lastSeen, isOnline }
// ─────────────────────────────────────────────────────────────────────────────
async function getLiveStats(req, res) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return sendError(res, 400, 'Invalid vehicle id');

    const data = await AnalyticsService.getLiveStats(id);
    return res.json({ success: true, data });
  } catch (err) {
    logger.error('[AnalyticsCtrl] getLiveStats: %s', err.message);
    return sendError(res, 500, 'Failed to fetch live stats', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/vehicles/summaries
//
// Called by Flutter's PersistentSyncService.getAllVehicleSummaries()
// Returns a map of vehicleId → summary for cold-start hydration.
//
// Flutter reads:
//   summary.totalOdometerKm    → odometer
//   summary.todayDistanceKm    → today distance
//   summary.lastSatelliteCount → GPS satellites
//   summary.engineHoursToday   → engine hours
//   summary.lastGpsTime        → last fix time
//   summary.lastSeenTime       → last seen
// ─────────────────────────────────────────────────────────────────────────────
async function getAllVehicleSummaries(req, res) {
  try {
    // Get today's date string
    const todayStr = (() => {
      const d = new Date(Date.now() + 5.5 * 3600_000); // IST
      return d.toISOString().split('T')[0];
    })();

    // Get all vehicles
    const vehicles = await Vehicle.find({})
      .select('_id imei name speed heading isOnline lastUpdate lastGpsTime lastKnownLocation status')
      .lean();

    if (!vehicles.length) {
      return res.json({ success: true, data: {} });
    }

    // Batch fetch today's DailySummary for all vehicles
    const todayStart = new Date(todayStr);
    todayStart.setUTCHours(0, 0, 0, 0);

    const summaries = await DailySummary.find({ date: todayStart })
      .select('vehicleId totalDistance engineHours rawPointCount')
      .lean();

    const summaryMap = new Map(
      summaries.map(s => [s.vehicleId.toString(), s])
    );

    // Batch fetch latest odometer from RawGpsLog for all vehicles
    const odoAgg = await RawGpsLog.aggregate([
      {
        $match: {
          vehicleId: { $in: vehicles.map(v => v._id) },
          odometer:  { $ne: null, $gt: 0 },
        },
      },
      {
        $sort: { gpsTimestamp: -1 },
      },
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

    // Batch fetch latest satellite count
    const satAgg = await RawGpsLog.aggregate([
      {
        $match: {
          vehicleId:  { $in: vehicles.map(v => v._id) },
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

    // Build result map: vehicleId → summary object
    const result = {};

    for (const v of vehicles) {
      const vid     = v._id.toString();
      const daily   = summaryMap.get(vid);
      const odometer = odoMap.get(vid) ?? 0;
      const sats    = satMap.get(vid)  ?? 0;

      result[vid] = {
        vehicleId:          vid,
        todayDistanceKm:    daily?.totalDistance  ?? 0,
        totalOdometerKm:    odometer,
        engineHoursToday:   daily?.engineHours    ?? 0,
        lastSatelliteCount: sats,
        lastGpsTime:        v.lastGpsTime   ?? v.lastUpdate ?? null,
        lastSeenTime:       v.lastUpdate    ?? null,
        lastUpdate:         v.lastUpdate    ?? null,
        isOnline:           v.isOnline      ?? false,
        speed:              v.speed         ?? 0,
        status:             v.status        ?? 'offline',
      };
    }

    return res.json({ success: true, data: result });

  } catch (err) {
    logger.error('[AnalyticsCtrl] getAllVehicleSummaries: %s', err.message);
    return sendError(res, 500, 'Failed to fetch vehicle summaries', err.message);
  }
}

module.exports = {
  getFleetSummary,
  getFleetTrends,
  getVehicleAnalytics,
  getPlayback,
  getLiveStats,
  getMileageReport,
  getDeviceInfo,
  getAllVehicleSummaries,
};