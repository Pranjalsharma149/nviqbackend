'use strict';

const Vehicle = require('../models/Vehicle');
const Trip = require('../models/Trip');
const mongoose = require('mongoose');

class AnalyticsService {
  /**
   * Fleet Summary: Fast O(N) single-pass aggregation
   */
  static async getFleetSummary() {
    const results = await Vehicle.aggregate([
      {
        $facet: {
          statusCounts: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                moving: { $sum: { $cond: [{ $eq: ["$status", "moving"] }, 1, 0] } },
                static: { $sum: { $cond: [{ $eq: ["$status", "static"] }, 1, 0] } },
                offline: { $sum: { $cond: [{ $eq: ["$isOnline", false] }, 1, 0] } }
              }
            }
          ],
          telemetryStats: [
            {
              $group: {
                _id: null,
                totalDistanceToday: { $sum: "$analytics.todayDistance" },
                avgSpeed: { $avg: "$speed" }
              }
            }
          ]
        }
      }
    ]);

    const stats = results[0].statusCounts[0] || { total: 0, moving: 0, static: 0, offline: 0 };
    const data = results[0].telemetryStats[0] || { totalDistanceToday: 0, avgSpeed: 0 };

    return {
      totalDistance: data.totalDistanceToday.toFixed(2),
      avgSpeed: data.avgSpeed.toFixed(1),
      uptime: stats.total > 0 ? (((stats.moving + stats.static) / stats.total) * 100).toFixed(1) : 0,
      movingCount: stats.moving,
      idleCount: stats.static,
      offlineCount: stats.offline,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Vehicle Analytics: Aggregates Trip data for historical reporting
   */
  static async getVehicleAnalytics(vehicleId, { days = 7 } = {}) {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const stats = await Trip.aggregate([
      { 
        $match: { 
          vehicleId: new mongoose.Types.ObjectId(vehicleId), 
          startTime: { $gte: startDate } 
        } 
      },
      {
        $group: {
          _id: "$vehicleId",
          totalDistance: { $sum: "$totalDistance" },
          totalTrips: { $sum: 1 },
          maxSpeed: { $max: "$maxSpeed" },
          avgSpeed: { $avg: "$avgSpeed" },
          totalDuration: { $sum: "$duration" },
          idleTime: { $sum: "$idleTime" }
        }
      }
    ]);

    if (!stats.length) {
      return { totalDistance: "0.00", totalTrips: 0, avgSpeed: "0.0", maxSpeed: "0.0", movingTime: 0, idleTime: 0 };
    }

    const s = stats[0];
    return {
      totalDistance: s.totalDistance.toFixed(2),
      totalTrips: s.totalTrips,
      avgSpeed: s.avgSpeed.toFixed(1),
      maxSpeed: s.maxSpeed.toFixed(1),
      movingTime: Math.round(s.totalDuration),
      idleTime: Math.round(s.idleTime),
      period: { days }
    };
  }
}

module.exports = AnalyticsService;