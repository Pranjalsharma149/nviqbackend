'use strict';

const net = require('net');
const Vehicle = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const GPSEngine = require('../controllers/geofenceController'); 
const logger = require('../utils/logger');

// ── Shared State Management ──────────────────────────────────────────────────
const imeiCache = new Map();
const lastPos = new Map();

/**
 * Optimized Vehicle Resolver
 */
async function resolveVehicle(imei) {
  const now = Date.now();
  const hit = imeiCache.get(imei);
  if (hit && now - hit.ts < 5 * 60 * 1000) return hit.doc;

  const doc = await Vehicle.findOne({ imei }).select('_id imei name status insideGeofences').lean();
  if (doc) imeiCache.set(imei, { doc, ts: now });
  return doc;
}

/**
 * Jitter Filter
 */
function isDuplicate(imei, lat, lng) {
  const p = lastPos.get(imei);
  if (!p) return false;
  const ageSec = (Date.now() - p.ts) / 1000;
  const sameLat = Math.abs(lat - p.lat) < 0.000009;
  const sameLng = Math.abs(lng - p.lng) < 0.000009;
  return ageSec < 5 && sameLat && sameLng;
}

/**
 * Logic to process coordinates
 */
async function processPosition({ imei, lat, lng, speed, heading, timestamp }) {
  if (!lat || !lng || (Math.abs(lat) < 0.1 && Math.abs(lng) < 0.1)) return;
  if (isDuplicate(imei, lat, lng)) return;

  lastPos.set(imei, { lat, lng, ts: Date.now() });

  const vehicle = await resolveVehicle(imei);
  if (!vehicle) return;

  const status = speed > 5 ? 'moving' : 'static';

  const updated = await Vehicle.findByIdAndUpdate(
    vehicle._id,
    {
      $set: {
        latitude: lat,
        longitude: lng,
        speed: Math.round(speed),
        heading,
        status,
        isOnline: true,
        lastUpdate: timestamp || new Date(),
      },
    },
    { new: true, lean: true }
  );

  if (global.io) {
    global.io.emit('vMove', {
      id: updated._id,
      lat, lng,
      speed: updated.speed,
      status
    });
  }

  setImmediate(async () => {
    try {
      await LocationPing.create({
        vehicleId: updated._id,
        latitude: lat, longitude: lng,
        speed: updated.speed,
        status,
        timestamp: updated.lastUpdate
      });
      await GPSEngine.checkGeofences(updated);
    } catch (err) {
      logger.error(`Post-Process Error: ${err.message}`);
    }
  });
}

/**
 * TCP SERVER DEFINITION
 */
const startGpsServer = (port) => {
  const server = net.createServer((socket) => {
    logger.info('🛰️ GPS Hardware Connected');

    socket.on('data', (data) => {
      // Protocol parsing logic goes here
    });

    socket.on('error', (err) => logger.error('📡 Socket Error: %s', err.message));
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info('📡 GPS TCP Receiver online on port %d', port);
  });
};

// ✅ THE FIX: Export the function so server.js can see it
module.exports = { 
  startGpsServer, 
  processPosition 
};