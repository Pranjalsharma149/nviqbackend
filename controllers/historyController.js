'use strict';

const mongoose = require('mongoose');
const History = require('../models/History');
const Vehicle = require('../models/Vehicle');
const Trip = require('../models/Trip');
const LocationPing = require('../models/LocationPing');
const { computeDailyFromRaw, utcDayStart, utcDayEnd } = require('../services/analytics.service');
const logger = require('../utils/logger');

// ── Timezone Helper (IST = UTC+5:30) ──────────────────────────────────────────
function getIstDayBounds(dateStr) {
  // dateStr is 'YYYY-MM-DD' representing the day in IST timezone
  const [year, month, day] = dateStr.split('-').map(Number);

  // Start of day in IST: year-month-day 00:00:00
  // Subtract 5 hours and 30 minutes to get the equivalent UTC Date
  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  start.setUTCMinutes(start.getUTCMinutes() - 330);

  // End of day in IST: year-month-day 23:59:59.999
  const end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  end.setUTCMinutes(end.getUTCMinutes() - 330);

  return { start, end };
}

function formatToIstDate(date) {
  if (!date) return '';
  const d = new Date(date);
  const istDate = new Date(d.getTime() + 5.5 * 3600000);
  return istDate.toISOString().split('T')[0];
}

function formatToIstTime(date) {
  if (!date) return '';
  const d = new Date(date);
  const options = {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  };
  return new Intl.DateTimeFormat('en-US', options).format(d);
}

// Helper: Resolve a human-readable address from LocationPing
async function resolveAddressForTime(vehicleId, time, coords) {
  const windowMs = 5 * 60 * 1000; // 5-minute search window
  const ping = await LocationPing.findOne({
    vehicleId: vehicleId.toString(),
    gpsTime: {
      $gte: new Date(time.getTime() - windowMs),
      $lte: new Date(time.getTime() + windowMs)
    },
    address: { $ne: null, $ne: '' }
  }).lean();

  if (ping && ping.address) {
    return ping.address;
  }

  // Fallback: Resolve and cache address live if it was not previously saved
  if (coords && coords.latitude != null && coords.longitude != null) {
    try {
      const { getAddressForCoords } = require('../utils/addressFetch');
      const resolvedAddress = await getAddressForCoords(coords.latitude, coords.longitude, vehicleId);
      if (resolvedAddress && resolvedAddress !== 'Unknown Location' && !resolvedAddress.includes(',')) {
        // Cache it in the nearest LocationPing document for future queries
        const nearestPing = await LocationPing.findOne({
          vehicleId: vehicleId.toString(),
          gpsTime: {
            $gte: new Date(time.getTime() - windowMs),
            $lte: new Date(time.getTime() + windowMs)
          }
        });
        if (nearestPing) {
          nearestPing.address = resolvedAddress;
          await nearestPing.save();
        }
        return resolvedAddress;
      }
      if (resolvedAddress) return resolvedAddress;
    } catch (e) {
      logger.debug('⚠️ [historyController] Fallback reverse-geocode failed: %s', e.message);
    }
  }

  return coords ? `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}` : 'Unknown Location';
}

// Helper: De-duplicate trips that start within 60 seconds of each other
function deduplicateTrips(trips) {
  if (!trips || trips.length === 0) return [];

  // Sort by startTime ascending
  const sorted = [...trips].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  const unique = [];
  for (const t of sorted) {
    if (unique.length === 0) {
      unique.push(t);
      continue;
    }

    const last = unique[unique.length - 1];
    const diffMs = Math.abs(new Date(t.startTime).getTime() - new Date(last.startTime).getTime());

    // If they start within 60 seconds, they are duplicates
    if (diffMs <= 60000) {
      // Merge duration, distance, and maxSpeed by taking the maximums
      last.duration = Math.max(last.duration || 0, t.duration || 0);
      last.totalDistance = Math.max(last.totalDistance || 0, t.totalDistance || 0);
      last.maxSpeed = Math.max(last.maxSpeed || 0, t.maxSpeed || 0);
      if (t.endTime && (!last.endTime || new Date(t.endTime) > new Date(last.endTime))) {
        last.endTime = t.endTime;
        last.endLocation = t.endLocation;
      }
    } else {
      unique.push(t);
    }
  }

  return unique;
}

// ── Helper: Generate History Document Live ────────────────────────────────────
async function generateHistoryDoc(vehicleId, imei, dateInput) {
  const dateStr = typeof dateInput === 'string'
    ? dateInput
    : dateInput.toISOString().split('T')[0];

  const { start, end } = getIstDayBounds(dateStr);
  const calendarDate = new Date(`${dateStr}T00:00:00.000Z`);

  // 1. Compute stats from raw GPS logs
  const stats = await computeDailyFromRaw(vehicleId, start, end);

  // 2. Fetch completed or active trips for this day
  const trips = await Trip.find({
    vehicleId,
    startTime: { $gte: start, $lte: end }
  }).sort({ startTime: 1 }).lean();

  // De-duplicate trips
  const uniqueTrips = deduplicateTrips(trips);

  // Calculate running_time in minutes as the sum of de-duplicated trip durations
  let runningTimeMins = 0;
  for (const t of uniqueTrips) {
    runningTimeMins += t.duration || 0;
  }

  // Fallback to engineHours in minutes if no trips recorded
  if (runningTimeMins === 0) {
    runningTimeMins = Math.round(stats.engineHours * 60);
  }

  // 3. Format trips to match the requested format
  const formattedTrips = await Promise.all(uniqueTrips.map(async t => {
    const durationMin = t.duration || 0;
    const distKm = t.totalDistance || 0;
    const maxSp = t.maxSpeed || 0;
    const avgSp = t.avgSpeed || 0;

    let formattedDuration = `${durationMin} mins`;
    if (durationMin >= 60) {
      formattedDuration = `${Math.floor(durationMin / 60)}h ${Math.round(durationMin % 60)}m`;
    }

    // Resolve addresses using LocationPing entries
    const tripStart = await resolveAddressForTime(vehicleId, t.startTime, t.startLocation);
    const tripEnd = t.isCompleted
      ? await resolveAddressForTime(vehicleId, t.endTime || new Date(), t.endLocation)
      : 'Active Now';

    // Count stops during this trip window
    const pings = await LocationPing.find({
      vehicleId: vehicleId.toString(),
      gpsTime: { $gte: t.startTime, $lte: t.endTime || new Date() }
    }).sort({ gpsTime: 1 }).select('speed').lean();

    let stops = 0;
    let isStoppedState = false;
    for (const p of pings) {
      const isStopped = (p.speed || 0) <= 5;
      if (isStopped && !isStoppedState) {
        stops++;
        isStoppedState = true;
      } else if (!isStopped) {
        isStoppedState = false;
      }
    }

    return {
      date: formatToIstDate(t.startTime),
      startTime: formatToIstTime(t.startTime),
      endTime: t.isCompleted ? formatToIstTime(t.endTime) : 'Active Now',
      tripStart,
      tripEnd,
      duration: formattedDuration,
      distance: `${distKm.toFixed(2)} km`,
      max_speed: `${maxSp.toFixed(1)} km/h`,
      avg_speed: `${avgSp.toFixed(1)} km/h`,
      stops,
      latlong: {
        lat: t.startLocation?.latitude?.toString() || '0.0',
        long: t.startLocation?.longitude?.toString() || '0.0'
      }
    };
  }));

  return {
    vehicleId,
    imei: imei || null,
    date: calendarDate,
    distance: stats.totalDistance,
    running_time: runningTimeMins,
    max_speed: stats.maxSpeed,
    totalstops: stats.todayStops,
    trips: formattedTrips
  };
}

// ── Helper: Get History Records for a Range of Vehicles ───────────────────────
async function getHistoryForVehicles(vehicleIds, startStr, endStr) {
  const todayStartStr = new Date(Date.now() + 5.5 * 3600000).toISOString().split('T')[0];

  // Pre-fetch all cached records for all target vehicles in the date range
  const cachedStart = new Date(`${startStr}T00:00:00.000Z`);
  const cachedEnd = new Date(`${endStr}T23:59:59.999Z`);

  const cachedRecords = await History.find({
    vehicleId: { $in: vehicleIds },
    date: { $gte: cachedStart, $lte: cachedEnd }
  }).lean();

  const cachedMap = new Map();
  for (const r of cachedRecords) {
    const key = `${r.vehicleId.toString()}_${r.date.toISOString().split('T')[0]}`;
    cachedMap.set(key, r);
  }

  const allRecords = [];

  for (const vId of vehicleIds) {
    const vehicle = await Vehicle.findById(vId).select('imei name').lean();
    if (!vehicle) continue;

    let current = new Date(`${startStr}T00:00:00.000Z`);
    const finalDate = new Date(`${endStr}T00:00:00.000Z`);

    while (current <= finalDate) {
      const dateStr = current.toISOString().split('T')[0];
      const key = `${vId.toString()}_${dateStr}`;
      const isToday = dateStr === todayStartStr;

      let record = cachedMap.get(key);

      if (!record || isToday) {
        // Compute live
        record = await generateHistoryDoc(vId, vehicle.imei, dateStr);

        // Cache it if it's in the past and has data
        if (!isToday && record.distance > 0) {
          try {
            await History.findOneAndUpdate(
              { vehicleId: vId, date: current },
              { $set: record },
              { upsert: true, new: true }
            );
          } catch (e) {
            logger.warn(`Failed to cache history for vehicle ${vId} on ${dateStr}: ${e.message}`);
          }
        }
      }

      allRecords.push(record);
      current.setUTCDate(current.getUTCDate() + 1);
    }
  }

  return allRecords;
}

// ── Date Range Parser Helper (IST) ────────────────────────────────────────────
function parseDateRange(query) {
  const { period, date, startDate, endDate } = query;

  const nowIst = new Date(Date.now() + 5.5 * 3600000);
  const todayStr = nowIst.toISOString().split('T')[0];

  let startStr = todayStr;
  let endStr = todayStr;

  if (period === 'day') {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      startStr = date;
      endStr = date;
    }
  } else if (period === 'week') {
    const startIst = new Date(nowIst.getTime() - 7 * 24 * 60 * 60 * 1000);
    startStr = startIst.toISOString().split('T')[0];
    endStr = todayStr;
  } else if (period === 'month') {
    const startIst = new Date(nowIst.getTime() - 30 * 24 * 60 * 60 * 1000);
    startStr = startIst.toISOString().split('T')[0];
    endStr = todayStr;
  } else if (startDate && endDate) {
    startStr = startDate;
    endStr = endDate;
  } else {
    // Default to last 7 days (week)
    const startIst = new Date(nowIst.getTime() - 7 * 24 * 60 * 60 * 1000);
    startStr = startIst.toISOString().split('T')[0];
    endStr = todayStr;
  }

  return { startStr, endStr };
}

// ── Aggregator Helper ────────────────────────────────────────────────────────
function aggregateHistory(historyRecords) {
  let distance = 0;
  let running_time = 0;
  let max_speed = 0;
  let totalstops = 0;
  let trips = [];

  for (const record of historyRecords) {
    distance += record.distance || 0;
    running_time += record.running_time || 0;
    if ((record.max_speed || 0) > max_speed) {
      max_speed = record.max_speed;
    }
    totalstops += record.totalstops || 0;
    if (record.trips && Array.isArray(record.trips)) {
      trips = trips.concat(record.trips);
    }
  }

  return {
    distance: `${distance.toFixed(2)} km`,
    running_time: `${Math.floor(running_time / 60)}h ${Math.round(running_time % 60)}m`,
    max_speed: `${max_speed.toFixed(1)} km/h`,
    totalstops,
    trips
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history/vehicle/:id
// Get history for a single vehicle (scoped by date range)
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleHistory = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid vehicle ID' });
    }

    const vehicle = await Vehicle.findById(id);
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    // Role-based authorization & ownership check:
    // Admin can access all vehicles.
    // Regular users (fleet_manager, dispatcher, owner, etc.) can only access their own registered vehicles (by phone check).
    // if (req.user.role !== 'admin' && vehicle.phone !== req.user.phone) {
    //   return res.status(403).json({
    //     success: false,
    //     message: 'Access denied: You do not own this vehicle'
    //   });
    // }

    const { startStr, endStr } = parseDateRange(req.query);

    const historyRecords = await getHistoryForVehicles([id], startStr, endStr);
    const aggregated = aggregateHistory(historyRecords);

    return res.json({
      success: true,
      vehicleId: id,
      vehicleName: vehicle.name,
      period: req.query.period || 'custom',
      dateRange: { start: startStr, end: endStr },
      data: aggregated
    });
  } catch (error) {
    logger.error('[HistoryCtrl] getVehicleHistory error: %s', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history/vehicle/all
// Get combined history for all authorized vehicles
// ─────────────────────────────────────────────────────────────────────────────
exports.getAllVehiclesHistory = async (req, res) => {
  try {
    const { startStr, endStr } = parseDateRange(req.query);
    let vehicleIds = [];

    // Role check:
    // If Admin: fetches history of ALL vehicles in the entire Nviq system.
    // If Not Admin: fetches history ONLY for the vehicles owned by this user (matched by phone).
    if (req.user.role === 'admin') {
      logger.info('[HistoryCtrl] Admin querying history for all Nviq vehicles');
      const allVehicles = await Vehicle.find({}).select('_id').lean();
      vehicleIds = allVehicles.map(v => v._id);
    } else {
      logger.info('[HistoryCtrl] User %s querying history for their own vehicles', req.user.phone);
      const userVehicles = await Vehicle.find({ phone: req.user.phone }).select('_id').lean();
      vehicleIds = userVehicles.map(v => v._id);
    }

    if (vehicleIds.length === 0) {
      return res.json({
        success: true,
        scope: req.user.role === 'admin' ? 'all_nviq_admin' : 'my_fleet',
        dateRange: { start: startStr, end: endStr },
        data: { distance: '0.00 km', running_time: '0h 0m', max_speed: '0.0 km/h', totalstops: 0, trips: [] }
      });
    }

    const historyRecords = await getHistoryForVehicles(vehicleIds, startStr, endStr);
    const aggregated = aggregateHistory(historyRecords);

    return res.json({
      success: true,
      scope: req.user.role === 'admin' ? 'all_nviq_admin' : 'my_fleet',
      dateRange: { start: startStr, end: endStr },
      data: aggregated
    });
  } catch (error) {
    logger.error('[HistoryCtrl] getAllVehiclesHistory error: %s', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Export utility functions for seed/backfill scripts
module.exports.generateHistoryDoc = generateHistoryDoc;
module.exports.getHistoryForVehicles = getHistoryForVehicles;
