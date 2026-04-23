'use strict';

const Vehicle = require('../models/Vehicle');
const Alert = require('../models/Alert');
const Trip = require('../models/Trip'); // Using Trip model for distance instead of raw pings

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/fleet/summary
// ─────────────────────────────────────────────────────────────────────────────
exports.getFleetSummary = async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7');
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Parallel counts for the dashboard
    const [counts, alertCount, tripStats] = await Promise.all([
      // Optimized: Get all status counts in one aggregation
      Vehicle.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            moving: { $sum: { $cond: [{ $eq: ['$status', 'moving'] }, 1, 0] } },
            idle: { $sum: { $cond: [{ $eq: ['$status', 'static'] }, 1, 0] } }, // WanWay uses 'static'
            offline: { $sum: { $cond: [{ $eq: ['$isOnline', false] }, 1, 0] } }
          }
        }
      ]),
      Alert.countDocuments({ timestamp: { $gte: startDate } }),
      // CRITICAL: Calculate distance from Trip summaries, NOT raw pings
      Trip.aggregate([
        { $match: { startTime: { $gte: startDate }, isCompleted: true } },
        {
          $group: {
            _id: null,
            totalDistance: { $sum: '$totalDistance' },
            avgSpeed: { $avg: '$avgSpeed' }
          }
        }
      ])
    ]);

    const stats = counts[0] || { total: 0, moving: 0, idle: 0, offline: 0 };
    const distanceData = tripStats[0] || { totalDistance: 0, avgSpeed: 0 };

    res.json({
      success: true,
      data: {
        total: stats.total,
        moving: stats.moving,
        idle: stats.idle,
        offline: stats.offline,
        totalDistance: distanceData.totalDistance.toFixed(2),
        avgSpeed: distanceData.avgSpeed.toFixed(1),
        alerts: alertCount,
        period: { days, start: startDate.toISOString(), end: new Date().toISOString() },
      },
    });
  } catch (error) {
    console.error('Analytics Error:', error.message);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/vehicles/:id (Individual Vehicle)
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleAnalytics = async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7');
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Fetch summaries from the Trip model instead of calculating from raw pings
    const [vehicle, tripSummary, alerts] = await Promise.all([
      Vehicle.findById(req.params.id).lean(),
      Trip.aggregate([
        { $match: { vehicleId: req.params.id, startTime: { $gte: startDate } } },
        {
          $group: {
            _id: null,
            totalDist: { $sum: '$totalDistance' },
            maxSpeed: { $max: '$maxSpeed' },
            avgSpeed: { $avg: '$avgSpeed' },
            tripCount: { $sum: 1 }
          }
        }
      ]),
      Alert.countDocuments({ vehicleId: req.params.id, timestamp: { $gte: startDate } })
    ]);

    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });

    const stats = tripSummary[0] || { totalDist: 0, maxSpeed: 0, avgSpeed: 0, tripCount: 0 };

    res.json({
      success: true,
      data: {
        totalDistance: stats.totalDist.toFixed(2),
        totalTrips: stats.tripCount,
        avgSpeed: stats.avgSpeed.toFixed(1),
        maxSpeed: stats.maxSpeed.toFixed(1),
        alerts: alerts,
        vehicle: { id: vehicle._id, name: vehicle.name, vehicleReg: vehicle.vehicleReg }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/fleet/trends (Distance per day for the fleet)
// ─────────────────────────────────────────────────────────────────────────────
exports.getFleetTrends = async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7');
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const trends = await Trip.aggregate([
      { $match: { startTime: { $gte: startDate }, isCompleted: true } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$startTime" } },
          distance: { $sum: "$totalDistance" },
          trips: { $sum: 1 }
        }
      },
      { $sort: { "_id": 1 } }
    ]);

    res.json({ success: true, data: trends });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};