const axios = require('axios');
const Vehicle = require('../models/Vehicle');
const Alert = require('../models/Alert');

const initBridge = (app) => {
  console.log("🛰️ API Bridge Active");

  setInterval(async () => {
    try {
      // ✅ 1. Fetch LIVE GPS data (IMPORTANT CHANGE)
      const response = await axios.get(`${process.env.TRACCAR_URL}/api/positions`, {
        auth: { 
          username: process.env.TRACCAR_USER, 
          password: process.env.TRACCAR_PASSWORD 
        }
      });

      const io = app.get('io');

      // ✅ Loop through real-time positions
      for (const position of response.data) {

        const speedKmh = Math.round(position.speed * 1.852); // knots → km/h

        // ✅ 2. Update vehicle using deviceId
        const vehicle = await Vehicle.findOneAndUpdate(
          { traccarDeviceId: position.deviceId },
          { 
            status: position.attributes?.ignition ? "online" : "offline",
            lastUpdate: position.fixTime,
            latitude: position.latitude,
            longitude: position.longitude,
            speed: speedKmh
          },
          { returnDocument: 'after' }
        );

        if (vehicle) {

          // ✅ 3. REAL-TIME SOCKET UPDATE
          io.emit('v_update', {
            id: vehicle._id,
            traccarId: vehicle.traccarDeviceId,
            lat: position.latitude,
            lng: position.longitude,
            speed: speedKmh,
            status: vehicle.status
          });

          // ✅ 4. OVERSPEED ALERT (FIXED)
          if (speedKmh > 60) {

            const alertExists = await Alert.findOne({ 
              vehicle: vehicle._id, 
              isRead: false, 
              type: 'Overspeed' 
            });

            if (!alertExists) {
              const newAlert = await Alert.create({
                vehicle: vehicle._id,
                type: 'Overspeed',
                message: `${vehicle.name} exceeded speed limit!`,
                severity: 'high'
              });

              io.emit('new_alert', newAlert);
              console.log(`⚠️ Overspeed Alert: ${vehicle.name}`);
            }
          }
        }
      }

    } catch (error) {
      console.error("❌ Traccar Sync Error:", error.message);
    }

  }, 10000);
};

module.exports = { initBridge };