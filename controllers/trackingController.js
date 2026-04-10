const axios = require('axios');

exports.getVehicleLocation = async (req, res) => {
  try {
    const { traccarId } = req.params; // this is IMEI

    const config = {
      auth: {
        username: process.env.TRACCAR_USER,
        password: process.env.TRACCAR_PASSWORD
      }
    };

    // ✅ Step 1: Get all devices
    const devicesRes = await axios.get(
      `${process.env.TRACCAR_URL}/api/devices`,
      config
    );

    // ✅ Find device by IMEI (uniqueId)
    const device = devicesRes.data.find(
      d => d.uniqueId === traccarId
    );

    if (!device) {
      return res.status(404).json({ message: "Device not found in Traccar" });
    }

    // ✅ Step 2: Get positions using device.id
    const posRes = await axios.get(
      `${process.env.TRACCAR_URL}/api/positions?deviceId=${device.id}`,
      config
    );

    if (!posRes.data || posRes.data.length === 0) {
      return res.status(404).json({ message: "No GPS data found" });
    }

    const latest = posRes.data[posRes.data.length - 1];

    res.json({
      lat: latest.latitude,
      lng: latest.longitude,
      speed: Math.round(latest.speed * 1.852),
      address: latest.address,
      deviceTime: latest.deviceTime
    });

  } catch (error) {
    console.error("Traccar ERROR:", error.response?.data || error.message);

    res.status(500).json({
      message: "Traccar connection failed",
      error: error.response?.data || error.message
    });
  }
};