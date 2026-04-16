const Vehicle = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const geolib = require('geolib');

class AnalyticsService {
  static async getFleetSummary({ days = 7 } = {}) {
    const endDate = new Date();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const [total, live, moving, idle, offline] = await Promise.all([
      Vehicle.countDocuments(),
      Vehicle.countDocuments({ isLive: true }),
      Vehicle.countDocuments({ status: 'moving' }),
      Vehicle.countDocuments({ status: 'idle' }),
      Vehicle.countDocuments({ isOnline: false })
    ]);
    
    // Sample-based calculation for performance
    const sampleVehicles = await Vehicle.find({ isOnline: true }).limit(50);
    let totalDistance = 0, totalSpeed = 0, speedCount = 0;
    
    for (const v of sampleVehicles) {
      const pings = await LocationPing.find({
        vehicleId: v._id, timestamp: { $gte: startDate }
      }).sort({ timestamp: 1 }).limit(100);
      
      if (pings.length >= 2) {
        for (let i = 1; i < pings.length; i++) {
          totalDistance += geolib.getDistance(
            { latitude: pings[i-1].latitude, longitude: pings[i-1].longitude },
            { latitude: pings[i].latitude, longitude: pings[i].longitude }
          );
        }
      }
      if (v.speed > 0) { totalSpeed += v.speed; speedCount++; }
    }
    
    const uptime = total > 0 ? ((live + moving) / total * 100).toFixed(1) : 0;
    
    return {
      totalDistance: (totalDistance / 1000).toFixed(2),
      totalTrips: 0,
      avgSpeed: speedCount > 0 ? (totalSpeed / speedCount).toFixed(1) : 0,
      uptime: parseFloat(uptime),
      movingCount: moving, idleCount: idle, offlineCount: offline,
      lastUpdated: new Date().toISOString(),
    };
  }
  
  static async getVehicleAnalytics(vehicleId, { days = 7 } = {}) {
    const endDate = new Date();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const vehicle = await Vehicle.findById(vehicleId);
    if (!vehicle) throw new Error('Vehicle not found');
    
    const pings = await LocationPing.find({
      vehicleId, timestamp: { $gte: startDate, $lte: endDate }
    }).sort({ timestamp: 1 });
    
    if (pings.length < 2) {
      return {
        totalDistance: 0, totalTrips: 0, avgSpeed: 0, maxSpeed: 0,
        movingTime: 0, idleTime: 0, stops: [],
        period: { start: startDate, end: endDate }
      };
    }
    
    let totalDistance = 0, totalSpeed = 0, speedCount = 0, maxSpeed = 0;
    let movingTime = 0, idleTime = 0;
    
    for (let i = 1; i < pings.length; i++) {
      const prev = pings[i-1], curr = pings[i];
      totalDistance += geolib.getDistance(
        { latitude: prev.latitude, longitude: prev.longitude },
        { latitude: curr.latitude, longitude: curr.longitude }
      );
      if (curr.speed > 0) { totalSpeed += curr.speed; speedCount++; }
      if (curr.speed > maxSpeed) maxSpeed = curr.speed;
      
      const timeDiffMin = (curr.timestamp - prev.timestamp) / (1000 * 60);
      if (curr.speed > 5) movingTime += timeDiffMin;
      else idleTime += timeDiffMin;
    }
    
    return {
      totalDistance: (totalDistance / 1000).toFixed(2),
      totalTrips: 0,
      avgSpeed: speedCount > 0 ? (totalSpeed / speedCount).toFixed(1) : 0,
      maxSpeed: maxSpeed.toFixed(1),
      movingTime: movingTime.toFixed(0),
      idleTime: idleTime.toFixed(0),
      stops: [],
      period: { start: pings[0].timestamp, end: pings[pings.length - 1].timestamp },
      vehicle: { id: vehicle.id, name: vehicle.name, vehicleReg: vehicle.vehicleReg }
    };
  }
}

module.exports = AnalyticsService;