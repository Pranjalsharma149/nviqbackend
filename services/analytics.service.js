'use strict';

/**
 * services/analytics.service.js
 *
 * Merged AnalyticsService — preserves the original class-based API surface
 * (getFleetSummary, getVehicleAnalytics) while adding the full pipeline methods
 * (getDailyAnalytics, getDateRangeAnalytics, getTrips, getPlayback, etc.)
 *
 * Source of truth priority:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Past days  →  DailySummary (pre-computed by cron)       │
 *   │  Today      →  RawGpsLog    (live computation)           │
 *   │  Fleet card →  RawGpsLog + Vehicle.isOnline              │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Breaking changes vs original:
 *   - getFleetSummary() no longer reads Vehicle.analytics.todayDistance
 *     (that field is stale/unreliable). Distance is now from RawGpsLog.
 *   - getVehicleAnalytics() now includes engineHours + idleHours from
 *     RawGpsLog, not just Trip aggregates.
 *   - avgSpeed in getFleetSummary() is the fleet moving-vehicle average,
 *     not the mean of instantaneous Vehicle.speed values.
 *  * 🔧 BUGFIX (this version):
 *   Removed infinite-recursion exports at the bottom of the file.
 *   Previously, lines like
 *       module.exports.getFleetSummary = (...a) => AnalyticsService.getFleetSummary(...a)
 *   overwrote the class's own static methods (because module.exports IS
 *   AnalyticsService), causing every analytics endpoint to crash with
 *   "Maximum call stack size exceeded". The class's static methods are
 *   already accessible via module.exports (= AnalyticsService) without
 *   the wrapper lines.
 */

const mongoose = require('mongoose');
const RawGpsLog = require('../models/RawGpsLog');
const DailySummary = require('../models/DailySummary');
const Trip = require('../models/Trip');
const Vehicle = require('../models/Vehicle');
const { haversineKm, isNoisePoint } = require('../utils/distance');

// ─────────────────────────────────────────────────────────────────────────────
// Internal date helpers
// ─────────────────────────────────────────────────────────────────────────────

/** UTC midnight for a 'YYYY-MM-DD' string or Date */
function utcDayStart(input) {
  const d = input instanceof Date ? input : new Date(input);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** One millisecond before next UTC midnight */
function utcDayEnd(input) {
  return new Date(utcDayStart(input).getTime() + 86_400_000 - 1);
}

/** Is this date today (UTC)? */
function isToday(input) {
  return utcDayStart(input).getTime() === utcDayStart(new Date()).getTime();
}

// ─────────────────────────────────────────────────────────────────────────────
// Core computation — RawGpsLog → daily stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queries RawGpsLog for one vehicle over [from, to] and returns:
 *   totalDistance, engineOnSeconds, runningSeconds, idleSeconds,
 *   engineHours, runningHours, idleHours, maxSpeed, avgSpeed, rawPointCount
 *
 * Called by getDailyAnalytics() and the nightly cron job.
 *
 * @param {ObjectId|string} vehicleId
 * @param {Date}            from        UTC start of window
 * @param {Date}            to          UTC end of window (inclusive)
 * @returns {Object}
 */
async function computeDailyFromRaw(vehicleId, from, to) {
  const points = await RawGpsLog.find({
    vehicleId,
    gpsTimestamp: { $gte: from, $lte: to },
    isDuplicate: false,
  })
    .sort({ gpsTimestamp: 1 })
    .select('latitude longitude speed ignition gpsTimestamp')
    .lean();

  if (points.length === 0) {
    return {
      totalDistance: 0,
      engineOnSeconds: 0,
      runningSeconds: 0,
      idleSeconds: 0,
      engineHours: 0,
      runningHours: 0,
      idleHours: 0,
      maxSpeed: 0,
      avgSpeed: 0,
      todayStops: 0,
      rawPointCount: 0,
    };
  }

  let totalDistance = 0;
  let engineOnSeconds = 0;
  let runningSeconds = 0;
  let idleSeconds = 0;
  let maxSpeed = 0;
  let speedSum = 0;
  let speedCount = 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];

    // ── Distance ──────────────────────────────────────────────────────────────
    const distKm = haversineKm(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
    if (!isNoisePoint(distKm)) totalDistance += distKm;

    // ── Time segment (cap at 10 min to avoid inflating long gaps) ────────────
    const segSec = Math.min(
      Math.max((curr.gpsTimestamp - prev.gpsTimestamp) / 1000, 0),
      600
    );

    // Ignition: treat as ON if either point reports it, or speed > 0
    const ignOn = curr.ignition === true || prev.ignition === true || curr.speed > 0;

    if (ignOn) engineOnSeconds += segSec;
    if (curr.speed > 5) runningSeconds += segSec;
    else if (ignOn) idleSeconds += segSec;  // ignition ON but not moving

    // ── Speed stats ───────────────────────────────────────────────────────────
    if (curr.speed > maxSpeed) maxSpeed = curr.speed;
    if (curr.speed > 0) { speedSum += curr.speed; speedCount++; }
  }

  const avgSpeed = speedCount > 0 ? speedSum / speedCount : 0;

  // ── Stops (transitions from moving to stopped) ─────────────────────────────
  let stopsCount = 0;
  let wasMoving = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const speed = p.speed || 0;
    const isMoving = speed > 5;
    if (wasMoving && !isMoving) {
      stopsCount++;
    }
    wasMoving = isMoving;
  }

  return {
    totalDistance: parseFloat(totalDistance.toFixed(3)),
    engineOnSeconds: Math.round(engineOnSeconds),
    runningSeconds: Math.round(runningSeconds),
    idleSeconds: Math.round(idleSeconds),
    engineHours: parseFloat((engineOnSeconds / 3600).toFixed(2)),
    runningHours: parseFloat((runningSeconds / 3600).toFixed(2)),
    idleHours: parseFloat((idleSeconds / 3600).toFixed(2)),
    maxSpeed: parseFloat(maxSpeed.toFixed(1)),
    avgSpeed: parseFloat(avgSpeed.toFixed(1)),
    todayStops: stopsCount,
    rawPointCount: points.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AnalyticsService — class-based API (drop-in replacement for existing code)
// ─────────────────────────────────────────────────────────────────────────────

class AnalyticsService {

  // ── getFleetSummary ─────────────────────────────────────────────────────────
  /**
   * Fleet-wide dashboard card.
   *
   * Fixed vs original:
   *   - totalDistance now from today's RawGpsLog aggregation
   *     (not stale Vehicle.analytics.todayDistance)
   *   - avgSpeed is the mean speed of currently-moving vehicles
   *     (not the mean of all Vehicle.speed instantaneous values)
   *   - idle uses status='idle' (original used status='static' which
   *     was never set by the processor — caused idle count to always be 0)
   *
   * @returns {Object}
   */
  static async getFleetSummary() {
    const todayStart = utcDayStart(new Date());
    const todayEnd = utcDayEnd(new Date());

    // ── Live status counts ────────────────────────────────────────────────────
    const [statusResult] = await Vehicle.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          moving: { $sum: { $cond: [{ $eq: ['$status', 'moving'] }, 1, 0] } },
          // FIX: original checked 'static' — processor sets 'idle' not 'static'
          idle: { $sum: { $cond: [{ $eq: ['$status', 'idle'] }, 1, 0] } },
          offline: { $sum: { $cond: [{ $eq: ['$isOnline', false] }, 1, 0] } },
          // Sum speed only for moving vehicles (for meaningful avg)
          movingSpeedSum: { $sum: { $cond: [{ $eq: ['$status', 'moving'] }, '$speed', 0] } },
        },
      },
    ]);

    const sc = statusResult ?? {
      total: 0, moving: 0, idle: 0, offline: 0, movingSpeedSum: 0,
    };

    // ── Today's total distance ────────────────────────────────────────────────
    // Prefer pre-computed partial DailySummary records (updated intra-day by
    // routes/cron if running). Fall back to a fast RawGpsLog aggregate.
    const partialSummaries = await DailySummary.find({
      date: todayStart,
      isPartial: true,
    }).select('totalDistance').lean();

    let totalDistanceToday = partialSummaries.reduce(
      (s, d) => s + (d.totalDistance ?? 0),
      0
    );

    // Fallback: sum odometer from today's RawGpsLog as a proxy
    // (exact per-segment haversine requires a JS loop — expensive for large fleets)
    if (totalDistanceToday === 0) {
      const [odoAgg] = await RawGpsLog.aggregate([
        {
          $match: {
            gpsTimestamp: { $gte: todayStart, $lte: todayEnd },
            isDuplicate: false,
            odometer: { $ne: null, $gt: 0 },
          },
        },
        {
          $group: {
            _id: '$vehicleId',
            // max odometer - min odometer = km driven today per vehicle
            maxOdo: { $max: '$odometer' },
            minOdo: { $min: '$odometer' },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $subtract: ['$maxOdo', '$minOdo'] } },
          },
        },
      ]);
      totalDistanceToday = odoAgg?.total ?? 0;
    }

    const avgSpeed = sc.moving > 0
      ? sc.movingSpeedSum / sc.moving
      : 0;

    const uptime = sc.total > 0
      ? (((sc.moving + sc.idle) / sc.total) * 100).toFixed(1)
      : '0.0';

    return {
      totalDistance: parseFloat(totalDistanceToday).toFixed(2),
      avgSpeed: parseFloat(avgSpeed).toFixed(1),
      uptime,
      movingCount: sc.moving,
      idleCount: sc.idle,
      offlineCount: sc.offline,
      totalCount: sc.total,
      lastUpdated: new Date().toISOString(),
    };
  }

  // ── getVehicleAnalytics ─────────────────────────────────────────────────────
  /**
   * Per-vehicle analytics over a rolling N-day window.
   *
   * Fixed vs original:
   *   - Returns engineHours + idleHours from RawGpsLog (not Trip.idleTime
   *     which doesn't exist in the current Trip schema)
   *   - Returns a result even when 0 trips exist (vehicle idling all day)
   *   - movingTime unit is minutes (consistent with Trip.duration)
   *   - For windows > 31 days, reads DailySummary cache to avoid large scans
   *
   * @param {string} vehicleId
   * @param {Object} opts
   * @param {number} opts.days   rolling window in days (default 7)
   * @returns {Object}
   */
  static async getVehicleAnalytics(vehicleId, { days = 7 } = {}) {
    const startDate = new Date(Date.now() - days * 86_400_000);
    const vId = new mongoose.Types.ObjectId(vehicleId);

    // ── Trip aggregation (same intent as original, idleTime removed) ──────────
    const [tripStats] = await Trip.aggregate([
      {
        $match: {
          vehicleId: vId,
          isCompleted: true,
          startTime: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: '$vehicleId',
          totalDistance: { $sum: '$totalDistance' },
          totalTrips: { $sum: 1 },
          maxSpeed: { $max: '$maxSpeed' },
          avgSpeed: { $avg: '$avgSpeed' },
          totalDuration: { $sum: '$duration' },  // minutes
        },
      },
    ]);

    // ── Engine / idle hours from RawGpsLog or DailySummary cache ─────────────
    let engineHours = 0;
    let idleHours = 0;
    let rawDistance = 0;

    if (days <= 31) {
      // Direct RawGpsLog computation for short windows (accurate)
      const raw = await computeDailyFromRaw(vId, startDate, new Date());
      engineHours = raw.engineHours;
      idleHours = raw.idleHours;
      rawDistance = raw.totalDistance;
    } else {
      // Aggregate from pre-computed DailySummary (fast, approximate)
      const summaries = await DailySummary.find({
        vehicleId: vId,
        date: { $gte: utcDayStart(startDate) },
      }).select('engineHours idleHours totalDistance').lean();

      engineHours = summaries.reduce((s, d) => s + (d.engineHours ?? 0), 0);
      idleHours = summaries.reduce((s, d) => s + (d.idleHours ?? 0), 0);
      rawDistance = summaries.reduce((s, d) => s + (d.totalDistance ?? 0), 0);
    }

    // Prefer Trip-based distance (more accurate per-segment tracking)
    // but fall back to raw haversine when there are no completed trips
    const finalDistance = (tripStats?.totalDistance ?? 0) > 0
      ? tripStats.totalDistance
      : rawDistance;

    return {
      totalDistance: parseFloat(finalDistance).toFixed(2),
      totalTrips: tripStats?.totalTrips ?? 0,
      avgSpeed: parseFloat(tripStats?.avgSpeed ?? 0).toFixed(1),
      maxSpeed: parseFloat(tripStats?.maxSpeed ?? 0).toFixed(1),
      movingTime: Math.round(tripStats?.totalDuration ?? 0),  // minutes
      engineHours: parseFloat(engineHours).toFixed(2),
      idleHours: parseFloat(idleHours).toFixed(2),
      period: { days },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Methods below are NEW (not in the original AnalyticsService)
  // ─────────────────────────────────────────────────────────────────────────────

  // ── getDailyAnalytics ───────────────────────────────────────────────────────
  /**
   * Single-day stats for one vehicle.
   * Fast path: DailySummary cache for past days.
   * Slow path: live RawGpsLog computation for today.
   */
  static async getDailyAnalytics(vehicleId, date) {
    const from = utcDayStart(date);
    const to = utcDayEnd(date);
    const vId = new mongoose.Types.ObjectId(vehicleId);

    if (!isToday(date)) {
      const cached = await DailySummary.findOne({ vehicleId: vId, date: from }).lean();
      if (cached) {
        return {
          vehicleId,
          date: from.toISOString().split('T')[0],
          totalDistance: cached.totalDistance,
          engineHours: cached.engineHours,
          runningHours: cached.runningHours,
          idleHours: cached.idleHours,
          maxSpeed: cached.maxSpeed,
          avgSpeed: cached.avgSpeed,
          tripCount: cached.tripCount,
          rawPointCount: cached.rawPointCount,
          fromCache: true,
        };
      }
    }

    const stats = await computeDailyFromRaw(vId, from, to);
    const tripCount = await Trip.countDocuments({
      vehicleId: vId,
      isCompleted: true,
      startTime: { $gte: from, $lte: to },
    });

    return {
      vehicleId,
      date: from.toISOString().split('T')[0],
      tripCount,
      fromCache: false,
      ...stats,
    };
  }

  // ── getDateRangeAnalytics ───────────────────────────────────────────────────
  /**
   * Array of daily summaries over a date range (max 90 days).
   */
  static async getDateRangeAnalytics(vehicleId, startDate, endDate) {
    const from = utcDayStart(startDate);
    const to = utcDayEnd(endDate);
    const vId = new mongoose.Types.ObjectId(vehicleId);
    const todayTs = utcDayStart(new Date()).getTime();

    const cached = await DailySummary.find({
      vehicleId: vId,
      date: { $gte: from, $lt: utcDayStart(new Date()) },
    }).lean();

    const cachedMap = new Map(
      cached.map(s => [s.date.toISOString().split('T')[0], s])
    );

    const days = [];
    const cursor = new Date(from);

    while (cursor <= to) {
      const key = cursor.toISOString().split('T')[0];
      const isPartial = cursor.getTime() >= todayTs;

      if (!isPartial && cachedMap.has(key)) {
        days.push({ date: key, ...cachedMap.get(key), fromCache: true });
      } else {
        const dayEnd = new Date(cursor.getTime() + 86_400_000 - 1);
        const stats = await computeDailyFromRaw(vId, cursor, dayEnd);
        days.push({ date: key, ...stats, fromCache: false });
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return days;
  }

  // ── getTrips ────────────────────────────────────────────────────────────────
  /** Paginated trip list for a vehicle. */
  static async getTrips(vehicleId, { startDate, endDate, limit = 50, page = 1 } = {}) {
    const vId = new mongoose.Types.ObjectId(vehicleId);
    const filter = { vehicleId: vId, isCompleted: true };

    if (startDate || endDate) {
      filter.startTime = {};
      if (startDate) filter.startTime.$gte = utcDayStart(startDate);
      if (endDate) filter.startTime.$lte = utcDayEnd(endDate);
    }

    const skip = (page - 1) * limit;
    const total = await Trip.countDocuments(filter);
    const trips = await Trip.find(filter)
      .sort({ startTime: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return {
      total,
      page,
      pageSize: limit,
      trips: trips.map(t => ({
        id: t._id,
        vehicleId: t.vehicleId,
        imei: t.imei,
        startTime: t.startTime,
        endTime: t.endTime,
        duration: t.duration,
        totalDistance: t.totalDistance,
        avgSpeed: t.avgSpeed,
        maxSpeed: t.maxSpeed,
        startLocation: t.startLocation,
        endLocation: t.endLocation,
      })),
    };
  }

  // ── getPlayback ─────────────────────────────────────────────────────────────
  /** Ordered GPS points for map replay on one day. */
  static async getPlayback(vehicleId, date, maxPoints = 500) {
    const from = utcDayStart(date);
    const to = utcDayEnd(date);
    const vId = new mongoose.Types.ObjectId(vehicleId);

    const total = await RawGpsLog.countDocuments({
      vehicleId: vId,
      gpsTimestamp: { $gte: from, $lte: to },
      isDuplicate: false,
    });

    if (total === 0) return { vehicleId, date, total: 0, points: [] };

    const points = await RawGpsLog.find({
      vehicleId: vId,
      gpsTimestamp: { $gte: from, $lte: to },
      isDuplicate: false,
    })
      .sort({ gpsTimestamp: 1 })
      .select('latitude longitude speed heading ignition status gpsTimestamp source')
      .lean();

    // Uniform downsample — always keep first and last
    const skip = total > maxPoints ? Math.floor(total / maxPoints) : 1;
    const sampled = skip > 1
      ? points.filter((_, i) => i % skip === 0 || i === points.length - 1)
      : points;

    return {
      vehicleId,
      date,
      total,
      sampled: sampled.length,
      points: sampled.map(p => ({
        lat: p.latitude,
        lng: p.longitude,
        speed: p.speed,
        heading: p.heading,
        ignition: p.ignition,
        status: p.status,
        timestamp: p.gpsTimestamp,
        source: p.source,
      })),
    };
  }

  // ── getLiveStats ────────────────────────────────────────────────────────────
  /** Current-day running stats — always live from RawGpsLog, never cached. */
  static async getLiveStats(vehicleId) {
    return AnalyticsService.getDailyAnalytics(
      vehicleId,
      new Date().toISOString().split('T')[0]
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
//
// Default export is the class (preserves existing usage:
//   const AnalyticsService = require('./analytics.service')
//   AnalyticsService.getFleetSummary()
//
// Named exports satisfy the cron job and analytics routes which
// import by destructuring:
//   const { computeDailyFromRaw, utcDayStart } = require('./analytics.service')
// ─────────────────────────────────────────────────────────────────────────────
module.exports = AnalyticsService;

// Named utility exports (these are plain functions, not class methods,
// so attaching them here does NOT cause recursion).
module.exports.computeDailyFromRaw = computeDailyFromRaw;
module.exports.utcDayStart = utcDayStart;
module.exports.utcDayEnd = utcDayEnd;
// module.exports.getDailyAnalytics     = (...a) => AnalyticsService.getDailyAnalytics(...a);
// module.exports.getDateRangeAnalytics = (...a) => AnalyticsService.getDateRangeAnalytics(...a);
// module.exports.getTrips              = (...a) => AnalyticsService.getTrips(...a);
// module.exports.getPlayback           = (...a) => AnalyticsService.getPlayback(...a);
// module.exports.getLiveStats          = (...a) => AnalyticsService.getLiveStats(...a);
// module.exports.getFleetSummary       = (...a) => AnalyticsService.getFleetSummary(...a);