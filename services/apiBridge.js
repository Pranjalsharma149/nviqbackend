const axios = require('axios');
const Vehicle = require('../models/Vehicle');

const syncTraccarData = async (app) => {
  try {
    const io = app.get('io');
    
    // 1. Fetch from Traccar API (Summary of all devices)
    // Traccar uses Basic Auth (email/password)
    const response = await axios.get(`${process.env.TRACCAR_URL}/api/devices`, {
      auth: {
        username: process.env.TRACCAR_USER,
        password: process.env.TRACCAR_PASSWORD
      }
    });

    const devices = response.data;

    for (const device of devices) {
      // 2. Fetch the latest position for this specific device
      const posResponse = await axios.get(`${process.env.TRACCAR_URL}/api/positions?deviceId=${device.id}`, {
        auth: {
          username: process.env.TRACCAR_USER,
          password: process.env.TRACCAR_PASSWORD
        }
      });

      if (posResponse.data.length > 0) {
        const position = posResponse.data[0];

        // 3. Map Traccar fields to NVIQ Model
        const updateData = {
          latitude: position.latitude,
          longitude: position.longitude,
          speed: (position.speed * 1.852), // Convert Knots to KM/H
          heading: position.course,
          status: device.status === 'online' ? 'moving' : 'offline',
          lastUpdate: new Date(position.deviceTime),
          batteryLevel: position.attributes.batteryLevel || 100
        };

        // 4. Update MongoDB (Link via Unique IMEI)
        const vehicle = await Vehicle.findOneAndUpdate(
          { imei: device.uniqueId }, 
          updateData,
          { new: true }
        );

        // 5. Emit to Flutter Map via Socket.io
        if (vehicle && io) {
          io.emit('vehicleUpdate', {
            id: vehicle._id,
            imei: vehicle.imei,
            lat: vehicle.latitude,
            lng: vehicle.longitude,
            speed: vehicle.speed,
            status: vehicle.status
          });
        }
      }
    }
    console.log(`✅ Traccar Sync: Processed ${devices.length} devices.`);
  } catch (error) {
    console.error('❌ Traccar Bridge Error:', error.message);
  }
};

const initBridge = (app) => {
  // Sync every 30 seconds (adjust based on your hardware frequency)
  setInterval(() => syncTraccarData(app), 30000);
};

module.exports = { initBridge };