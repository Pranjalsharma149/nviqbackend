// backend/controllers/TripPlaybackController.js
// ═════════════════════════════════════════════════════════════════════════════
// Trip Playback Controller
// Handles playback-specific endpoints for trip data visualization
// ═════════════════════════════════════════════════════════════════════════════

'use strict';

const logger = require('../utils/logger');
const LocationPing = require('../models/LocationPing');
const Vehicle = require('../models/Vehicle');
const Trip = require('../models/Trip');

// ── GCJ-02 → WGS-84 Converter ─────────────────────────────────────────────────
function gcj02ToWgs84(gcjLng, gcjLat) {
  const a  = 6378245.0;
  const ee = 0.00669342162296594323;

  function transformLat(lng, lat) {
    let r = -100 + 2*lng + 3*lat + 0.2*lat*lat + 0.1*lng*lat + 0.2*Math.sqrt(Math.abs(lng));
    r += (20*Math.sin(6*lng*Math.PI) + 20*Math.sin(2*lng*Math.PI)) * 2/3;
    r += (20*Math.sin(lat*Math.PI)   + 40*Math.sin(lat/3*Math.PI)) * 2/3;
    r += (160*Math.sin(lat/12*Math.PI) + 320*Math.sin(lat*Math.PI/30)) * 2/3;
    return r;
  }

  function transformLng(lng, lat) {
    let r = 300 + lng + 2*lat + 0.1*lng*lng + 0.1*lng*lat + 0.1*Math.sqrt(Math.abs(lng));
    r += (20*Math.sin(6*lng*Math.PI) + 20*Math.sin(2*lng*Math.PI)) * 2/3;
    r += (20*Math.sin(lng*Math.PI)   + 40*Math.sin(lng/3*Math.PI)) * 2/3;
    r += (150*Math.sin(lng/12*Math.PI) + 300*Math.sin(lng/30*Math.PI)) * 2/3;
    return r;
  }

  const dLat      = transformLat(gcjLng - 105, gcjLat - 35);
  const dLng      = transformLng(gcjLng - 105, gcjLat - 35);
  const radLat    = gcjLat / 180 * Math.PI;
  let   magic     = Math.sin(radLat);
  magic           = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  return {
    lat: gcjLat - (dLat * 180) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI),
    lng: gcjLng - (dLng * 180) / (a / sqrtMagic * Math.cos(radLat) * Math.PI),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// CONTROLLERS
// ═════════════════════════════════════════════════════════════════════════════

module.exports = {

  // ── GET /api/trips/points - All trip points for a date ────────────────────
  async tripPoints(req, res) {
    try {
      const { vehicleId, date } = req.query;
      
      if (!vehicleId || !date) {
        return res.status(400).json({
          code: 1,
          message: 'vehicleId and date required',
        });
      }

      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const pings = await LocationPing.find({
        vehicleId,
        timestamp: {
          $gte: startOfDay,
          $lte: endOfDay,
        },
      })
      .sort({ timestamp: 1 })
      .lean()
      .limit(10000);

      if (pings.length === 0) {
        logger.warn('No trip points for vehicleId=%s date=%s', vehicleId, date);
        return res.json({
          code: 0,
          data: [],
          message: 'No trip data',
        });
      }

      // Format for Flutter playback
      const points = pings.map(p => ({
        id:        p._id?.toString(),
        lat:       p.latitude,
        lng:       p.longitude,
        latitude:  p.latitude,
        longitude: p.longitude,
        speed:     p.speed || 0,
        heading:   p.heading || 0,
        altitude:  p.altitude,
        satellites: p.satellites,
        accuracy:  p.accuracy,
        timestamp: p.timestamp.toISOString(),
        serverTime: p.timestamp.toISOString(),
      }));

      logger.info('✅ Fetched %d trip points for %s on %s', points.length, vehicleId, date);

      res.json({
        code: 0,
        data: points,
        metadata: {
          count: points.length,
          startTime: points[0]?.timestamp,
          endTime: points[points.length - 1]?.timestamp,
        },
      });

    } catch (err) {
      logger.error('❌ tripPoints error: %s', err.message);
      res.status(500).json({
        code: 2,
        message: 'Server error',
        error: err.message,
      });
    }
  },

  // ── GET /api/trips/playback - Sampled points for smooth animation ─────────
  async playbackData(req, res) {
    try {
      const { vehicleId, date, interval = 5 } = req.query;
      
      if (!vehicleId || !date) {
        return res.status(400).json({
          code: 1,
          message: 'vehicleId and date required',
        });
      }

      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      
      const samplingInterval = parseInt(interval) || 5;

      const allPings = await LocationPing.find({
        vehicleId,
        timestamp: {
          $gte: startOfDay,
          $lte: endOfDay,
        },
      })
      .sort({ timestamp: 1 })
      .lean()
      .limit(50000);

      if (allPings.length === 0) {
        return res.json({
          code: 0,
          data: [],
        });
      }

      // Sample points based on interval
      const sampledPoints = [];
      let lastTime = null;

      for (const ping of allPings) {
        if (!lastTime || (ping.timestamp - lastTime) / 1000 >= samplingInterval) {
          sampledPoints.push({
            id:        ping._id?.toString(),
            lat:       ping.latitude,
            lng:       ping.longitude,
            latitude:  ping.latitude,
            longitude: ping.longitude,
            speed:     ping.speed || 0,
            heading:   ping.heading || 0,
            altitude:  ping.altitude,
            satellites: ping.satellites,
            timestamp: ping.timestamp.toISOString(),
          });
          lastTime = ping.timestamp;
        }
      }

      logger.info('✅ Sampled %d from %d points (interval=%ds)', sampledPoints.length, allPings.length, samplingInterval);

      res.json({
        code: 0,
        data: sampledPoints,
        metadata: {
          originalCount: allPings.length,
          sampledCount: sampledPoints.length,
          samplingInterval,
        },
      });

    } catch (err) {
      logger.error('❌ playbackData error: %s', err.message);
      res.status(500).json({
        code: 2,
        message: 'Server error',
      });
    }
  },

  // ── GET /api/trips/summary - Trip metrics ─────────────────────────────────
  async tripSummary(req, res) {
    try {
      const { vehicleId, date } = req.query;
      
      if (!vehicleId || !date) {
        return res.status(400).json({
          code: 1,
          message: 'vehicleId and date required',
        });
      }

      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const trip = await Trip.findOne({
        vehicleId,
        startTime: {
          $gte: startOfDay,
          $lte: endOfDay,
        },
      }).lean();

      if (!trip) {
        return res.json({
          code: 0,
          data: null,
          message: 'No trip found',
        });
      }

      res.json({
        code: 0,
        data: {
          tripId:       trip._id?.toString(),
          vehicleId:    trip.vehicleId?.toString(),
          startTime:    trip.startTime,
          endTime:      trip.endTime,
          duration:     trip.duration,
          totalDistance: trip.totalDistance,
          maxSpeed:     trip.maxSpeed,
          avgSpeed:     trip.avgSpeed,
          isCompleted:  trip.isCompleted,
        },
      });

    } catch (err) {
      logger.error('❌ tripSummary error: %s', err.message);
      res.status(500).json({
        code: 2,
        message: 'Server error',
      });
    }
  },

  // ── GET /api/trips/dates - Trip dates in a month ──────────────────────────
  async tripDates(req, res) {
    try {
      const { vehicleId, year, month } = req.query;
      
      if (!vehicleId || !year || !month) {
        return res.status(400).json({
          code: 1,
          message: 'vehicleId, year, month required',
        });
      }

      const y = parseInt(year);
      const m = parseInt(month);
      
      const startOfMonth = new Date(y, m - 1, 1);
      const endOfMonth = new Date(y, m, 0, 23, 59, 59);

      const dates = await LocationPing.aggregate([
        {
          $match: {
            vehicleId: vehicleId,
            timestamp: {
              $gte: startOfMonth,
              $lte: endOfMonth,
            },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$timestamp',
              },
            },
          },
        },
        {
          $sort: { _id: 1 },
        },
      ]);

      const tripDates = dates.map(d => new Date(d._id).toISOString());

      logger.info('✅ Found %d trip dates for vehicleId=%s in %d-%d', tripDates.length, vehicleId, y, m);

      res.json({
        code: 0,
        data: tripDates,
      });

    } catch (err) {
      logger.error('❌ tripDates error: %s', err.message);
      res.status(500).json({
        code: 2,
        message: 'Server error',
      });
    }
  },

  // ── GET /api/trips/events - Speed/braking events ──────────────────────────
  async tripEvents(req, res) {
    try {
      const { vehicleId, date, type } = req.query;
      
      if (!vehicleId || !date) {
        return res.status(400).json({
          code: 1,
          message: 'vehicleId and date required',
        });
      }

      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const query = {
        vehicleId,
        timestamp: {
          $gte: startOfDay,
          $lte: endOfDay,
        },
      };

      if (type) {
        query.type = type;
      }

      // Would fetch from Events collection
      // For now, return empty array
      const events = [];

      res.json({
        code: 0,
        data: events,
      });

    } catch (err) {
      logger.error('❌ tripEvents error: %s', err.message);
      res.status(500).json({
        code: 2,
        message: 'Server error',
      });
    }
  },

  // ── GET /api/gps/records - Raw Wanway GPS records ──────────────────────────
  async gpsRecords(req, res) {
    try {
      const { vehicleId, imei, startTime, endTime } = req.query;
      
      if (!vehicleId && !imei) {
        return res.status(400).json({
          code: 1,
          message: 'vehicleId or imei required',
        });
      }

      const query = {};
      
      if (vehicleId) {
        query.vehicleId = vehicleId;
      } else if (imei) {
        query.imei = imei;
      }

      if (startTime && endTime) {
        query.timestamp = {
          $gte: new Date(startTime),
          $lte: new Date(endTime),
        };
      }

      const records = await LocationPing.find(query)
        .sort({ timestamp: 1 })
        .lean()
        .limit(10000);

      res.json({
        code: 0,
        data: records,
        count: records.length,
      });

    } catch (err) {
      logger.error('❌ gpsRecords error: %s', err.message);
      res.status(500).json({
        code: 2,
        message: 'Server error',
      });
    }
  },

};