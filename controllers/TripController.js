'use strict';

const Trip    = require('../models/Trip');
const Vehicle = require('../models/Vehicle');

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns { start, end } Date boundaries for a given period string */
function getPeriodRange(period) {
  const now   = new Date();
  const start = new Date();

  switch (period) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'yesterday':
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      now.setDate(now.getDate() - 1);
      now.setHours(23, 59, 59, 999);
      break;
    case 'week':
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      break;
    case 'month':
      start.setMonth(start.getMonth() - 1);
      start.setHours(0, 0, 0, 0);
      break;
    case '3months':
      start.setMonth(start.getMonth() - 3);
      start.setHours(0, 0, 0, 0);
      break;
    default:
      // fallback: today
      start.setHours(0, 0, 0, 0);
  }

  return { start, end: now };
}

// ─────────────────────────────────────────────────────────────────────────────
//  CREATE TRIP
//  POST /api/trips
// ─────────────────────────────────────────────────────────────────────────────
exports.createTrip = async (req, res) => {
  try {
    const {
      vehicleId,
      imei,
      startLocation,   // { latitude, longitude, address }
      fuelStart,
    } = req.body;

    if (!vehicleId) {
      return res.status(400).json({ success: false, message: 'vehicleId is required' });
    }

    // Check vehicle exists
    const vehicle = await Vehicle.findById(vehicleId).lean();
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    // Close any accidentally open trips for same vehicle first
    await Trip.updateMany(
      { vehicleId, isCompleted: false },
      { $set: { isCompleted: true, endTime: new Date() } }
    );

    const trip = await Trip.create({
      vehicleId,
      imei:          imei ?? vehicle.imei ?? null,
      startTime:     new Date(),
      startLocation: startLocation ?? null,
      fuelStart:     fuelStart     ?? null,
      isCompleted:   false,
    });

    return res.status(201).json({ success: true, data: trip });
  } catch (err) {
    console.error('[tripController.createTrip]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  END TRIP
//  PUT /api/trips/:id/end
// ─────────────────────────────────────────────────────────────────────────────
exports.endTrip = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      endLocation,    // { latitude, longitude, address }
      totalDistance,  // km  — pass from your live-tracking accumulated value
      avgSpeed,
      maxSpeed,
      idleTime,       // minutes
      fuelEnd,
      alertCount,
    } = req.body;

    const trip = await Trip.findById(id);
    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }
    if (trip.isCompleted) {
      return res.status(400).json({ success: false, message: 'Trip already completed' });
    }

    const endTime    = new Date();
    const durationMs = endTime - trip.startTime;
    const duration   = Math.round(durationMs / 60000); // minutes

    const fuelConsumed =
      fuelEnd != null && trip.fuelStart != null
        ? Math.max(0, trip.fuelStart - fuelEnd)
        : 0;

    trip.endTime       = endTime;
    trip.duration      = duration;
    trip.endLocation   = endLocation   ?? null;
    trip.totalDistance = totalDistance ?? trip.totalDistance;
    trip.avgSpeed      = avgSpeed      ?? trip.avgSpeed;
    trip.maxSpeed      = maxSpeed      ?? trip.maxSpeed;
    trip.idleTime      = idleTime      ?? trip.idleTime;
    trip.fuelEnd       = fuelEnd       ?? null;
    trip.fuelConsumed  = fuelConsumed;
    trip.alertCount    = alertCount    ?? trip.alertCount;
    trip.isCompleted   = true;

    await trip.save();

    return res.status(200).json({ success: true, data: trip });
  } catch (err) {
    console.error('[tripController.endTrip]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  LIST TRIPS (with period filter)
//  GET /api/trips?period=today|yesterday|week|month|3months&vehicleId=xxx&page=1&limit=20
// ─────────────────────────────────────────────────────────────────────────────
exports.listTrips = async (req, res) => {
  try {
    const {
      period     = 'today',
      vehicleId,
      page       = 1,
      limit      = 20,
      completed,          // 'true' | 'false' | undefined = all
    } = req.query;

    const { start, end } = getPeriodRange(period);

    const filter = {
      startTime: { $gte: start, $lte: end },
    };

    if (vehicleId)          filter.vehicleId   = vehicleId;
    if (completed === 'true')  filter.isCompleted = true;
    if (completed === 'false') filter.isCompleted = false;

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Trip.countDocuments(filter);

    const trips = await Trip.find(filter)
      .sort({ startTime: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('vehicleId', 'registrationNumber vehicleType name imei')
      .lean({ virtuals: true });

    return res.status(200).json({
      success: true,
      data: {
        trips,
        pagination: {
          total,
          page:       Number(page),
          limit:      Number(limit),
          totalPages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (err) {
    console.error('[tripController.listTrips]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  SINGLE TRIP DETAIL
//  GET /api/trips/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getTrip = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id)
      .populate('vehicleId', 'registrationNumber vehicleType name imei')
      .lean({ virtuals: true });

    if (!trip) {
      return res.status(404).json({ success: false, message: 'Trip not found' });
    }

    return res.status(200).json({ success: true, data: trip });
  } catch (err) {
    console.error('[tripController.getTrip]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  ANALYTICS SUMMARY
//  GET /api/trips/analytics/summary?period=today|week|3months&vehicleId=xxx
//
//  Returns aggregated stats for the Analytics Hub screen.
// ─────────────────────────────────────────────────────────────────────────────
exports.analyticsSummary = async (req, res) => {
  try {
    const { period = 'today', vehicleId } = req.query;
    const { start, end } = getPeriodRange(period);

    const matchStage = {
      startTime:   { $gte: start, $lte: end },
      isCompleted: true,
    };
    if (vehicleId) matchStage.vehicleId = new require('mongoose').Types.ObjectId(vehicleId);

    const [result] = await Trip.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:              null,
          totalTrips:       { $sum: 1 },
          totalDistanceKm:  { $sum: '$totalDistance' },
          totalDurationMin: { $sum: '$duration' },
          totalIdleMin:     { $sum: '$idleTime' },
          totalFuel:        { $sum: '$fuelConsumed' },
          totalAlerts:      { $sum: '$alertCount' },
          avgSpeed:         { $avg: '$avgSpeed' },
          maxSpeed:         { $max: '$maxSpeed' },
        },
      },
      {
        $project: {
          _id:              0,
          totalTrips:       1,
          totalDistanceKm:  { $round: ['$totalDistanceKm',  1] },
          totalDurationMin: 1,
          totalIdleMin:     1,
          totalFuel:        { $round: ['$totalFuel',  2] },
          totalAlerts:      1,
          avgSpeed:         { $round: ['$avgSpeed',   1] },
          maxSpeed:         { $round: ['$maxSpeed',   1] },
          // fuel efficiency: L per 100 km
          fuelEfficiency: {
            $cond: [
              { $gt: ['$totalDistanceKm', 0] },
              { $round: [{ $multiply: [{ $divide: ['$totalFuel', '$totalDistanceKm'] }, 100] }, 2] },
              0,
            ],
          },
        },
      },
    ]);

    // Also count active (in-progress) trips for this vehicle
    const activeFilter = { isCompleted: false };
    if (vehicleId) activeFilter.vehicleId = vehicleId;
    const activeTrips = await Trip.countDocuments(activeFilter);

    return res.status(200).json({
      success: true,
      data: {
        period,
        ...(result ?? {
          totalTrips:       0,
          totalDistanceKm:  0,
          totalDurationMin: 0,
          totalIdleMin:     0,
          totalFuel:        0,
          totalAlerts:      0,
          avgSpeed:         0,
          maxSpeed:         0,
          fuelEfficiency:   0,
        }),
        activeTrips,
      },
    });
  } catch (err) {
    console.error('[tripController.analyticsSummary]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  PER-VEHICLE BREAKDOWN
//  GET /api/trips/analytics/vehicles?period=today|week|3months
//
//  Useful for the fleet overview table in Analytics Hub.
// ─────────────────────────────────────────────────────────────────────────────
exports.vehicleBreakdown = async (req, res) => {
  try {
    const { period = 'today' } = req.query;
    const { start, end }       = getPeriodRange(period);

    const rows = await Trip.aggregate([
      {
        $match: {
          startTime:   { $gte: start, $lte: end },
          isCompleted: true,
        },
      },
      {
        $group: {
          _id:             '$vehicleId',
          trips:           { $sum: 1 },
          totalDistanceKm: { $sum: '$totalDistance' },
          totalDurationMin:{ $sum: '$duration' },
          maxSpeed:        { $max: '$maxSpeed' },
          avgSpeed:        { $avg: '$avgSpeed' },
          totalAlerts:     { $sum: '$alertCount' },
          fuelConsumed:    { $sum: '$fuelConsumed' },
        },
      },
      {
        $lookup: {
          from:         'vehicles',
          localField:   '_id',
          foreignField: '_id',
          as:           'vehicle',
        },
      },
      { $unwind: { path: '$vehicle', preserveNullAndEmpty: true } },
      {
        $project: {
          vehicleId:        '$_id',
          vehicleName:      { $ifNull: ['$vehicle.name', '$vehicle.registrationNumber', 'Unknown'] },
          vehicleType:      '$vehicle.vehicleType',
          trips:            1,
          totalDistanceKm:  { $round: ['$totalDistanceKm',  1] },
          totalDurationMin: 1,
          maxSpeed:         { $round: ['$maxSpeed', 1] },
          avgSpeed:         { $round: ['$avgSpeed', 1] },
          totalAlerts:      1,
          fuelConsumed:     { $round: ['$fuelConsumed', 2] },
          _id:              0,
        },
      },
      { $sort: { totalDistanceKm: -1 } },
    ]);

    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    console.error('[tripController.vehicleBreakdown]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};