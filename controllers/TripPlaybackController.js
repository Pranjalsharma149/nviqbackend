'use strict';

/**
 * TripPlaybackController
 *
 * FIXES applied vs previous version:
 *
 *  FIX-A  tripSummary now returns todayDistanceKm, totalDistanceKm, engineHours
 *         so Flutter's fetchMileageReport() gets the fields it reads via
 *         report.todayDistanceKm / report.totalDistanceKm / report.engineHours.
 *         Values are aggregated from LocationPing records for the requested day.
 *
 *  FIX-B  gpsRecords time-range filter uses gpsTime (matches LocationPing
 *         schema field) not timestamp.
 *
 *  FIX-C  tripDates aggregation groups on gpsTime, not timestamp.
 *
 *  FIX-D  playbackData + tripPoints both sort / filter on gpsTime.
 *
 *  FIX-E  tripEvents stub derives overspeed events from LocationPing so it
 *         works without a separate Event model.
 *
 * LocationPing schema fields expected (models/LocationPing.js):
 *   vehicleId, imei, latitude, longitude, speed, heading, altitude,
 *   accuracy, satellites, batteryVoltage, ignitionOn,
 *   gpsTime (Date, indexed),  deviceTime (Date),
 *   address, serverOdometerKm, todayDistance, engineHours, source
 */

const Trip         = require('../models/Trip');
const LocationPing = require('../models/LocationPing');

const TAG = '[TripPlaybackCtrl]';

// ── Post-turn zig-zag outlier filter ─────────────────────────────────────────
// Removes GPS drift artefacts by checking whether visiting a point creates a
// detour more than 2.5× the direct distance between its neighbors. Points that
// pass the quality/bearing checks in data.processor may still form a small kink
// on screen — this removes the last visible residue.

function _distKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
               Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _filterZigZag(points) {
  if (points.length < 3) return points;

  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const curr = points[i];
    const next = points[i + 1];

    const dPC = _distKm(prev.lat, prev.lng, curr.lat, curr.lng);
    const dCN = _distKm(curr.lat, curr.lng, next.lat, next.lng);
    const dPN = _distKm(prev.lat, prev.lng, next.lat, next.lng);

    // Skip point if it creates a detour > 2.5× the direct prev→next path.
    // Minimum direct distance of 5 m prevents false positives on slow/stopped vehicles.
    if (dPN > 0.005 && (dPC + dCN) > dPN * 2.5) continue;

    out.push(curr);
  }
  out.push(points[points.length - 1]);
  return out;
}

function dayBounds(dateStr) {
  const start = new Date(dateStr);
  start.setHours(0, 0, 0, 0);
  const end = new Date(dateStr);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function badRequest(res, msg) {
  return res.status(400).json({ code: 1, message: msg });
}

function serverError(res, err) {
  console.error(TAG, err.message);
  return res.status(500).json({ code: 2, message: 'Server error', error: err.message });
}

// ── GET /api/trips/points ─────────────────────────────────────────────────────
// Flutter: fetchTripHistory(vehicleId, date) → needs lat, lng, speed, heading, timestamp
exports.tripPoints = async (req, res) => {
  try {
    const { vehicleId, date } = req.query;
    if (!vehicleId || !date) return badRequest(res, 'vehicleId and date required');

    const { start, end } = dayBounds(date);

    const pings = await LocationPing
      .find({ vehicleId, gpsTime: { $gte: start, $lte: end } })
      .sort({ gpsTime: 1 })
      .limit(10000)
      .lean();

    if (!pings.length) {
      return res.json({ code: 0, data: [], message: 'No trip data for this date' });
    }

    const raw = pings.map(p => ({
      id:          p._id?.toString(),
      lat:         p.latitude,
      lng:         p.longitude,
      latitude:    p.latitude,
      longitude:   p.longitude,
      speed:       p.speed       ?? 0,
      heading:     p.heading     ?? 0,
      altitude:    p.altitude    ?? 0,
      accuracy:    p.accuracy    ?? 0,
      satellites:  p.satellites  ?? 0,
      ignitionOn:  p.ignitionOn  ?? false,
      timestamp:   p.gpsTime.toISOString(),
      deviceTime:  p.deviceTime?.toISOString() ?? p.gpsTime.toISOString(),
      address:     p.address     ?? null,
    }));

    const points = _filterZigZag(raw);

    console.log(`${TAG} tripPoints: ${points.length}/${raw.length} pts for ${vehicleId} on ${date}`);
    return res.json({
      code: 0,
      data: points,
      metadata: {
        count:        points.length,
        originalCount: raw.length,
        startTime:    points[0].timestamp,
        endTime:      points[points.length - 1].timestamp,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
};

// ── GET /api/trips/playback ───────────────────────────────────────────────────
// Sampled subset for smooth animation. interval= seconds between sampled points.
exports.playbackData = async (req, res) => {
  try {
    const { vehicleId, date, interval = 5 } = req.query;
    if (!vehicleId || !date) return badRequest(res, 'vehicleId and date required');

    const { start, end } = dayBounds(date);
    const stepSec = Math.max(1, parseInt(interval) || 5);

    const all = await LocationPing
      .find({ vehicleId, gpsTime: { $gte: start, $lte: end } })
      .sort({ gpsTime: 1 })
      .limit(50000)
      .lean();

    if (!all.length) return res.json({ code: 0, data: [] });

    const rawSampled = [];
    let lastMs = null;
    for (const p of all) {
      const ms = p.gpsTime.getTime();
      if (lastMs === null || (ms - lastMs) / 1000 >= stepSec) {
        rawSampled.push({
          id:        p._id?.toString(),
          lat:       p.latitude,
          lng:       p.longitude,
          latitude:  p.latitude,
          longitude: p.longitude,
          speed:     p.speed    ?? 0,
          heading:   p.heading  ?? 0,
          altitude:  p.altitude ?? 0,
          satellites: p.satellites ?? 0,
          ignitionOn: p.ignitionOn ?? false,
          timestamp: p.gpsTime.toISOString(),
        });
        lastMs = ms;
      }
    }

    const sampled = _filterZigZag(rawSampled);

    console.log(`${TAG} playbackData: sampled ${sampled.length}/${all.length} pts (interval=${stepSec}s)`);
    return res.json({
      code: 0,
      data: sampled,
      metadata: {
        originalCount:    all.length,
        sampledCount:     sampled.length,
        samplingInterval: stepSec,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
};

// ── GET /api/trips/summary ────────────────────────────────────────────────────
// FIX-A: Flutter's _fetchWanwayDataForVehicle reads:
//   report.todayDistanceKm, report.dailyDistance, report.distanceToday
//   report.totalDistanceKm, report.odometer, report.odometerKm
//   report.engineHours, report.totalEngineHours, report.runningHours
//
// These fields do NOT exist on the Trip model, so we aggregate from LocationPing.
// The last ping of the day carries the running daily totals persisted by
// PersistentSyncService.recordGPSFixWithOdometer().
exports.tripSummary = async (req, res) => {
  try {
    const { vehicleId, date } = req.query;
    if (!vehicleId || !date) return badRequest(res, 'vehicleId and date required');

    const { start, end } = dayBounds(date);

    const [agg] = await LocationPing.aggregate([
      { $match: { vehicleId, gpsTime: { $gte: start, $lte: end } } },
      { $sort:  { gpsTime: 1 } },
      {
        $group: {
          _id:             '$vehicleId',
          pingCount:       { $sum: 1 },
          maxSpeed:        { $max: '$speed' },
          avgSpeed:        { $avg: '$speed' },
          // Last ping has the most current running totals
          todayDistanceKm: { $last: '$todayDistance' },
          totalDistanceKm: { $last: '$serverOdometerKm' },
          engineHours:     { $last: '$engineHours' },
          firstPing:       { $first: '$gpsTime' },
          lastPing:        { $last:  '$gpsTime' },
        },
      },
    ]);

    // Also pull the Trip doc if one exists (provides duration, alertCount, etc.)
    const trip = await Trip.findOne({
      vehicleId,
      startTime: { $gte: start, $lte: end },
    }).sort({ startTime: -1 }).lean();

    const todayKm   = agg?.todayDistanceKm ?? trip?.totalDistance ?? 0;
    const totalKm   = agg?.totalDistanceKm ?? 0;
    const engineHrs = agg?.engineHours     ?? 0;
    const maxSpd    = Math.max(agg?.maxSpeed ?? 0, trip?.maxSpeed ?? 0);
    const avgSpd    = agg?.avgSpeed ?? trip?.avgSpeed ?? 0;

    const fmt1 = n => Number((n ?? 0).toFixed(1));
    const fmt2 = n => Number((n ?? 0).toFixed(2));

    console.log(`${TAG} tripSummary: ${vehicleId} ${date} — today=${fmt2(todayKm)}km total=${fmt2(totalKm)}km eng=${fmt2(engineHrs)}h`);

    return res.json({
      code: 0,
      data: {
        vehicleId,
        date,

        // Primary field names Flutter reads (live_tracking_screen.dart FIX-1,2,4)
        todayDistanceKm:  fmt2(todayKm),
        totalDistanceKm:  fmt2(totalKm),
        engineHours:      fmt2(engineHrs),

        // Fallback aliases checked by Flutter code
        dailyDistance:    fmt2(todayKm),
        distanceToday:    fmt2(todayKm),
        odometer:         fmt2(totalKm),
        odometerKm:       fmt2(totalKm),
        totalEngineHours: fmt2(engineHrs),
        runningHours:     fmt2(engineHrs),

        // Speed stats
        maxSpeed:  fmt1(maxSpd),
        avgSpeed:  fmt1(avgSpd),

        // Ping metadata
        pingCount: agg?.pingCount ?? 0,
        firstPing: agg?.firstPing ?? null,
        lastPing:  agg?.lastPing  ?? null,

        // Trip record extras
        tripId:      trip?._id?.toString() ?? null,
        duration:    trip?.duration        ?? null,
        idleTime:    trip?.idleTime        ?? null,
        alertCount:  trip?.alertCount      ?? null,
        isCompleted: trip?.isCompleted     ?? false,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
};

// ── GET /api/trips/dates ──────────────────────────────────────────────────────
// FIX-C: groups on gpsTime (correct field name)
exports.tripDates = async (req, res) => {
  try {
    const { vehicleId, year, month } = req.query;
    if (!vehicleId || !year || !month) {
      return badRequest(res, 'vehicleId, year, month required');
    }

    const y = parseInt(year);
    const m = parseInt(month);
    const startOfMonth = new Date(y, m - 1, 1);
    const endOfMonth   = new Date(y, m,     0, 23, 59, 59, 999);

    const rows = await LocationPing.aggregate([
      {
        $match: {
          vehicleId,
          gpsTime: { $gte: startOfMonth, $lte: endOfMonth },
        },
      },
      {
        $group: {
          _id:   { $dateToString: { format: '%Y-%m-%d', date: '$gpsTime' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const dates = rows.map(r => ({ date: r._id, count: r.count }));
    console.log(`${TAG} tripDates: ${dates.length} active days for ${vehicleId} ${y}-${m}`);
    return res.json({ code: 0, data: dates });
  } catch (err) {
    return serverError(res, err);
  }
};

// ── GET /api/trips/events ─────────────────────────────────────────────────────
// FIX-E: derives overspeed events from LocationPing — no separate model needed.
// Extend with harsh braking / other types when you add an Event collection.
exports.tripEvents = async (req, res) => {
  try {
    const { vehicleId, date, type } = req.query;
    if (!vehicleId || !date) return badRequest(res, 'vehicleId and date required');

    const { start, end } = dayBounds(date);
    const OVERSPEED_KMH = 80;

    if (type && type !== 'overspeed') {
      // Unknown type — return empty until a dedicated Event model exists
      return res.json({ code: 0, data: [] });
    }

    const pings = await LocationPing
      .find({
        vehicleId,
        gpsTime: { $gte: start, $lte: end },
        speed:   { $gt: OVERSPEED_KMH },
      })
      .sort({ gpsTime: 1 })
      .limit(500)
      .lean();

    const events = pings.map(p => ({
      type:      'overspeed',
      lat:       p.latitude,
      lng:       p.longitude,
      latitude:  p.latitude,
      longitude: p.longitude,
      speed:     p.speed,
      threshold: OVERSPEED_KMH,
      timestamp: p.gpsTime.toISOString(),
    }));

    console.log(`${TAG} tripEvents: ${events.length} overspeed events for ${vehicleId} on ${date}`);
    return res.json({ code: 0, data: events });
  } catch (err) {
    return serverError(res, err);
  }
};

// ── GET /api/trips/gps/records ────────────────────────────────────────────────
// FIX-B: time-range filter uses gpsTime, not timestamp
exports.gpsRecords = async (req, res) => {
  try {
    const { vehicleId, imei, startTime, endTime } = req.query;
    if (!vehicleId && !imei) return badRequest(res, 'vehicleId or imei required');

    const query = {};
    if (vehicleId) query.vehicleId = vehicleId;
    else           query.imei      = imei;

    if (startTime && endTime) {
      query.gpsTime = {
        $gte: new Date(startTime),
        $lte: new Date(endTime),
      };
    }

    const records = await LocationPing
      .find(query)
      .sort({ gpsTime: 1 })
      .limit(10000)
      .lean();

    console.log(`${TAG} gpsRecords: ${records.length} records returned`);
    return res.json({ code: 0, data: records, count: records.length });
  } catch (err) {
    return serverError(res, err);
  }
};