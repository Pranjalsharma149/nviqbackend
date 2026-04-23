'use strict';

const geolib       = require('geolib');
const Alert        = require('../models/Alert');
const Trip         = require('../models/Trip');
const Geofence      = require('../models/Geofence');

class GPSEngine {
  /**
   * Main Entry Point called by the Data Processor
   */
  static async processUpdate(vehicle, newData) {
    try {
      // 1. Calculate Distance (Delta)
      const distM = geolib.getDistance(
        { latitude: vehicle.latitude, longitude: vehicle.longitude },
        { latitude: newData.latitude, longitude: newData.longitude }
      );

      // 2. Trip State Logic
      // We pass the vehicle object so it can accumulate distance in memory before the final bulk save
      await this._handleTripState(vehicle, newData, distM);

      // 3. Geofence Logic
      await this._checkGeofences(vehicle, newData);

      // 4. Critical Alerts (Overspeed, SOS, etc)
      if (newData.speed > 80) { // Example threshold
        await this._createAlert(vehicle, newData, 'overspeed', `High Speed Detected: ${newData.speed} km/h`);
      }

    } catch (e) {
      console.error(`🚀 Engine Error [${vehicle.imei}]:`, e.message);
    }
  }

  static async _handleTripState(vehicle, newData, distM) {
    const isMoving = newData.speed > 5;
    const distKm = distM / 1000;

    // Increment today's analytics in the vehicle object
    if (isMoving) {
      vehicle.analytics.todayDistance = (vehicle.analytics.todayDistance || 0) + distKm;
    }

    // TRIP START: Transition from static to moving
    if (vehicle.status !== 'moving' && isMoving) {
      await Trip.create({
        vehicleId: vehicle._id,
        imei: vehicle.imei,
        startTime: new Date(),
        startLocation: { latitude: newData.latitude, longitude: newData.longitude },
        isCompleted: false
      });
    }

    // TRIP UPDATE: If trip is ongoing, update the distance and max speed
    if (isMoving) {
      await Trip.updateOne(
        { vehicleId: vehicle._id, isCompleted: false },
        { 
          $inc: { totalDistance: distKm },
          $max: { maxSpeed: newData.speed },
          $set: { endTime: new Date() } // Keep the end time fresh
        }
      );
    }
  }

  static async _checkGeofences(vehicle, newData) {
    // 💡 Performance Tip: For 20k devices, you should cache 'fences' in a global variable 
    // and refresh it every 5 minutes rather than querying the DB on every GPS ping.
    const fences = await Geofence.find({ isActive: true }).lean();

    const currentInsideIds = (vehicle.insideGeofences || []).map(id => id.toString());
    const newInsideIds = [];

    for (const fence of fences) {
      // Optimization: Check if fence applies to this vehicle or is global
      const isAssigned = !fence.vehicleIds || fence.vehicleIds.length === 0 || 
                         fence.vehicleIds.some(id => id.toString() === vehicle._id.toString());
      
      if (!isAssigned) continue;

      const isInside = this._isPointInFence(newData.latitude, newData.longitude, fence);
      const fenceId = fence._id.toString();

      if (isInside) {
        newInsideIds.push(fence._id);
        if (!currentInsideIds.includes(fenceId)) {
          await this._createAlert(vehicle, newData, 'geofenceEnter', `Entered Geofence: ${fence.name}`);
        }
      } else if (currentInsideIds.includes(fenceId)) {
        await this._createAlert(vehicle, newData, 'geofenceExit', `Exited Geofence: ${fence.name}`);
      }
    }

    // Update vehicle state - the Data Processor will save this via bulkWrite
    vehicle.insideGeofences = newInsideIds;
  }

  static _isPointInFence(lat, lng, fence) {
    if (fence.geometry.type === 'Circle') {
      return geolib.getDistance(
        { latitude: lat, longitude: lng },
        { latitude: fence.geometry.center.latitude, longitude: fence.geometry.center.longitude }
      ) <= fence.geometry.radius;
    }
    // Polygon check
    return geolib.isPointInPolygon(
      { latitude: lat, longitude: lng },
      fence.geometry.coordinates.map(c => ({ latitude: c[0], longitude: c[1] }))
    );
  }

  static async _createAlert(vehicle, data, type, title) {
    const alert = await Alert.create({
      vehicleId: vehicle._id,
      imei: vehicle.imei,
      type,
      title,
      latitude: data.latitude,
      longitude: data.longitude,
      speed: data.speed,
      timestamp: new Date(),
      priority: (type === 'sos' || type === 'powerCut') ? 'critical' : 'high'
    });

    // Real-time Push to Flutter via Socket.io
    if (global.io) {
      global.io.emit('newAlert', alert);
      global.io.to(vehicle._id.toString()).emit('vehicleAlert', alert);
    }
  }
}

module.exports = GPSEngine;