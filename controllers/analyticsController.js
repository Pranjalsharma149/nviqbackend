'use strict';

/**
 * controllers/analyticsController.js
 *
 * Express controller that backs the /api/analytics/* routes.
 *
 * Routes (from analytics.routes.js):
 *   GET /fleet/summary        → getFleetSummary
 *   GET /fleet/trends         → getFleetTrends
 *   GET /vehicles/:id         → getVehicleAnalytics
 *
 * All heavy lifting is delegated to analytics.service.js.
 * Controllers only handle HTTP: validate input, call service, format response.
 */

const mongoose        = require('mongoose');
const AnalyticsService = require('../services/analytics.service');
const DailySummary    = require('../models/DailySummary');
const Vehicle         = require('../models/Vehicle');
const logger          = require('../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/** Send a uniform error response. */
function sendError(res, status, message, detail = undefined) {
  const body = { success: false, message };
  if (detail && process.env.NODE_ENV !== 'production') body.detail = detail;
  return res.status(status).json(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/fleet/summary
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Fleet-wide KPI card — live data, no caching.
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     totalCount, movingCount, idleCount, offlineCount,
 *     totalDistance, avgSpeed, uptime, lastUpdated
 *   }
 * }
 */
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
//   ?vehicleId=...    Optional: single vehicle trends (else fleet aggregate)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns an array of daily stats objects suitable for a line chart.
 *
 * When vehicleId is provided → per-vehicle DailySummary records.
 * When omitted              → fleet aggregate (sum across all vehicles per day).
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     days: number,
 *     series: [
 *       { date: 'YYYY-MM-DD', totalDistance, engineHours, idleHours,
 *         maxSpeed, avgSpeed, tripCount, vehicleCount? },
 *       ...
 *     ]
 *   }
 * }
 */
async function getFleetTrends(req, res) {
  try {
    const days      = Math.min(Math.max(parseInt(req.query.days ?? 7, 10), 1), 90);
    const vehicleId = req.query.vehicleId;

    // Date window
    const endDate   = new Date();
    const startDate = new Date(Date.now() - days * 86_400_000);

    if (vehicleId) {
      // ── Single vehicle trend ──────────────────────────────────────────────
      if (!isValidObjectId(vehicleId)) {
        return sendError(res, 400, 'Invalid vehicleId');
      }

      const series = await AnalyticsService.getDateRangeAnalytics(
        vehicleId,
        startDate.toISOString().split('T')[0],
        endDate.toISOString().split('T')[0]
      );

      return res.json({ success: true, data: { days, vehicleId, series } });
    }

    // ── Fleet aggregate trend ─────────────────────────────────────────────
    // Sum DailySummary across all vehicles, grouped by date.
    const pipeline = [
      {
        $match: {
          date: {
            $gte: new Date(
              Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
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
          // Weighted average speed (avoid dividing by 0 in JS)
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
// GET /api/analytics/vehicles/:id
//   ?days=7        Rolling window (default 7)
//   ?date=YYYY-MM-DD  Single day (overrides ?days)
//   ?playback=true    Include GPS playback points
//   ?page=1&limit=20  Pagination for trips
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Per-vehicle analytics.
 *
 * Response (rolling window):
 * {
 *   success: true,
 *   data: {
 *     vehicle: { id, imei, name },
 *     analytics: { totalDistance, totalTrips, avgSpeed, maxSpeed,
 *                  movingTime, engineHours, idleHours, period },
 *     trips: { total, page, pageSize, trips: [...] }
 *   }
 * }
 *
 * Response (single day with ?date=YYYY-MM-DD):
 * {
 *   success: true,
 *   data: {
 *     vehicle: ...,
 *     daily: { date, totalDistance, engineHours, ... },
 *     playback?: { total, sampled, points: [...] }
 *   }
 * }
 */
async function getVehicleAnalytics(req, res) {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return sendError(res, 400, 'Invalid vehicle id');
    }

    // Check vehicle exists
    const vehicle = await Vehicle.findById(id)
      .select('_id imei name plateNumber')
      .lean();

    if (!vehicle) {
      return sendError(res, 404, 'Vehicle not found');
    }

    const dateParam = req.query.date;   // 'YYYY-MM-DD'

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
          plateNumber: vehicle.plateNumber,
        },
        daily,
        trips,
      };

      // Optionally include GPS playback points
      if (req.query.playback === 'true') {
        const maxPts = Math.min(parseInt(req.query.maxPoints ?? 500, 10), 2000);
        responseData.playback = await AnalyticsService.getPlayback(id, dateParam, maxPts);
      }

      return res.json({ success: true, data: responseData });
    }

    // ── Rolling window mode ───────────────────────────────────────────────────
    const days  = Math.min(Math.max(parseInt(req.query.days ?? 7, 10), 1), 90);
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
          plateNumber: vehicle.plateNumber,
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
// ─────────────────────────────────────────────────────────────────────────────
async function getPlayback(req, res) {
  try {
    const { id }    = req.params;
    const { date }  = req.query;

    if (!isValidObjectId(id))         return sendError(res, 400, 'Invalid vehicle id');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return sendError(res, 400, 'date (YYYY-MM-DD) is required');
    }

    const maxPoints = Math.min(parseInt(req.query.maxPoints ?? 500, 10), 2000);
    const data      = await AnalyticsService.getPlayback(id, date, maxPoints);

    return res.json({ success: true, data });
  } catch (err) {
    logger.error('[AnalyticsCtrl] getPlayback: %s', err.message);
    return sendError(res, 500, 'Failed to fetch playback data', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/vehicles/:id/live
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

module.exports = {
  getFleetSummary,
  getFleetTrends,
  getVehicleAnalytics,
  getPlayback,
  getLiveStats,
};