// controllers/analyticsController.js
'use strict';

const Vehicle      = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const Alert        = require('../models/Alert');
const geolib       = require('geolib');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/fleet/summary
// ─────────────────────────────────────────────────────────────────────────────
exports.getFleetSummary = async (req, res) => {
  try {
    const days      = parseInt(req.query.days || '7');
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // All counts in one parallel batch — single round trip
    const [total, live, moving, idle, offline, alertCount] = await Promise.all([
      Vehicle.countDocuments(),
      Vehicle.countDocuments({ isLive: true }),
      Vehicle.countDocuments({ status: 'moving' }),
      Vehicle.countDocuments({ status: 'idle' }),
      Vehicle.countDocuments({ isOnline: false }),
      Alert.countDocuments({ timestamp: { $gte: startDate } }),
    ]);

    // Distance: use MongoDB aggregation — single query instead of N+1 loop
    const distResult = await LocationPing.aggregate([
      { $match: { timestamp: { $gte: startDate } } },
      { $group: { _id: '$vehicleId', pings: { $push: { lat: '$latitude', lng: '$longitude' } } } },
    ]);

    let totalDistanceKm = 0;
    for (const doc of distResult) {
      for (let i = 1; i < doc.pings.length; i++) {
        totalDistanceKm += geolib.getDistance(
          { latitude: doc.pings[i - 1].lat, longitude: doc.pings[i - 1].lng },
          { latitude: doc.pings[i].lat,     longitude: doc.pings[i].lng     }
        ) / 1000;
      }
    }

    // Avg speed from moving vehicles only
    const speedAgg = await Vehicle.aggregate([
      { $match: { status: 'moving', speed: { $gt: 0 } } },
      { $group: { _id: null, avg: { $avg: '$speed' } } },
    ]);
    const avgSpeed = speedAgg[0]?.avg?.toFixed(1) ?? 0;

    const uptime = total > 0 ? (((live + moving) / total) * 100).toFixed(1) : 0;

    res.json({
      success: true,
      data: {
        total, live, moving, idle, offline,
        totalDistance: totalDistanceKm.toFixed(2),
        avgSpeed: parseFloat(avgSpeed),
        uptime:   parseFloat(uptime),
        alerts:   alertCount,
        period:   { days, start: startDate.toISOString(), end: new Date().toISOString() },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/vehicles/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getVehicleAnalytics = async (req, res) => {
  try {
    const days      = parseInt(req.query.days || '7');
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const vehicle = await Vehicle.findById(req.params.id).lean();
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });

    const [pings, alerts] = await Promise.all([
      LocationPing.find({ vehicleId: req.params.id, timestamp: { $gte: startDate } }).sort({ timestamp: 1 }).lean(),
      Alert.find({ vehicleId: req.params.id, timestamp: { $gte: startDate } }).lean(),
    ]);

    if (pings.length < 2) {
      return res.json({ success: true, data: {
        totalDistance: 0, totalTrips: 0, avgSpeed: 0, maxSpeed: 0,
        movingTime: 0, idleTime: 0, alerts: alerts.length,
        stops: [], period: { start: startDate.toISOString(), end: new Date().toISOString() },
        vehicle: { id: vehicle._id.toString(), name: vehicle.name, vehicleReg: vehicle.vehicleReg },
      }});
    }

    let totalDistance = 0, totalSpeed = 0, speedCount = 0, maxSpeed = 0;
    let movingTime = 0, idleTime = 0;
    const stops = [];

    for (let i = 1; i < pings.length; i++) {
      const prev = pings[i - 1], curr = pings[i];
      totalDistance += geolib.getDistance(
        { latitude: prev.latitude, longitude: prev.longitude },
        { latitude: curr.latitude, longitude: curr.longitude }
      );
      if (curr.speed > 0) { totalSpeed += curr.speed; speedCount++; }
      if (curr.speed > maxSpeed) maxSpeed = curr.speed;

      const timeDiffMin = (curr.timestamp - prev.timestamp) / (1000 * 60);
      if (curr.speed > 5) movingTime += timeDiffMin;
      else {
        idleTime += timeDiffMin;
        if (timeDiffMin > 5) {
          const nearby = stops.some(s =>
            geolib.getDistance({ latitude: s.latitude, longitude: s.longitude }, { latitude: curr.latitude, longitude: curr.longitude }) < 50
          );
          if (!nearby) stops.push({ latitude: curr.latitude, longitude: curr.longitude, duration: timeDiffMin, startTime: prev.timestamp });
        }
      }
    }

    res.json({
      success: true,
      data: {
        totalDistance: (totalDistance / 1000).toFixed(2),
        totalTrips:    0,
        avgSpeed:      speedCount > 0 ? (totalSpeed / speedCount).toFixed(1) : 0,
        maxSpeed:      maxSpeed.toFixed(1),
        movingTime:    movingTime.toFixed(0),
        idleTime:      idleTime.toFixed(0),
        alerts:        alerts.length,
        stops:         stops.slice(0, 20),
        period: {
          start: pings[0].timestamp.toISOString(),
          end:   pings[pings.length - 1].timestamp.toISOString(),
        },
        vehicle: { id: vehicle._id.toString(), name: vehicle.name, vehicleReg: vehicle.vehicleReg },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};