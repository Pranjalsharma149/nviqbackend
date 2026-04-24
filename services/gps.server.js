'use strict';

/**
 * gps.server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * TCP server that accepts direct connections from GPS hardware devices.
 * Supports GT06 protocol — used by PRIME09 and VL149 (and most Chinese trackers).
 *
 * Devices connect here when NOT going through WanWay/IOP GPS platform.
 * Configure each device via SMS:
 *   SERVER,0,[YOUR_PUBLIC_IP],5001,0#
 *   APN,[YOUR_APN]#
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * INSTALL DEPENDENCY:
 *   npm install gt06
 */

const net     = require('net');
const Gt06    = require('gt06');
const Vehicle = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const GPSEngine    = require('../controllers/geofenceController');
const logger  = require('../utils/logger');

// ── GCJ-02 → WGS-84 converter (same as data.processor.js) ────────────────────
// Direct TCP devices also send GCJ-02 coordinates.
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

// ── Shared State ──────────────────────────────────────────────────────────────
const imeiCache = new Map();   // vehicle doc cache (5 min TTL)
const lastPos   = new Map();   // jitter filter

// ── Vehicle resolver (cached) ─────────────────────────────────────────────────
async function resolveVehicle(imei) {
  const now = Date.now();
  const hit = imeiCache.get(imei);
  if (hit && now - hit.ts < 5 * 60 * 1000) return hit.doc;

  const doc = await Vehicle.findOne({ imei })
    .select('_id imei name status insideGeofences')
    .lean();
  if (doc) imeiCache.set(imei, { doc, ts: now });
  return doc;
}

// ── Jitter filter (skip duplicate pings within 5s) ────────────────────────────
function isDuplicate(imei, lat, lng) {
  const p = lastPos.get(imei);
  if (!p) return false;
  const ageSec = (Date.now() - p.ts) / 1000;
  return ageSec < 5 &&
    Math.abs(lat - p.lat) < 0.000009 &&
    Math.abs(lng - p.lng) < 0.000009;
}

// ── Core position processor ───────────────────────────────────────────────────
async function processPosition({ imei, lat, lng, speed, heading, timestamp }) {
  // Reject invalid / 0,0 coordinates
  if (!lat || !lng || (Math.abs(lat) < 0.1 && Math.abs(lng) < 0.1)) return;
  if (isDuplicate(imei, lat, lng)) return;

  lastPos.set(imei, { lat, lng, ts: Date.now() });

  const vehicle = await resolveVehicle(imei);
  if (!vehicle) {
    logger.warn('⚠️ [TCP] Unknown IMEI: %s — not in DB', imei);
    return;
  }

  const status = speed > 5 ? 'moving' : 'idle';
  const ts     = timestamp || new Date();

  const updated = await Vehicle.findByIdAndUpdate(
    vehicle._id,
    {
      $set: {
        latitude:  lat,
        longitude: lng,
        speed:     Math.round(speed),
        heading,
        status,
        isOnline:  true,
        isLive:    true,
        lastUpdate: ts,
        lastOnlineAt: ts,
        lastKnownLocation: {
          latitude:  lat,
          longitude: lng,
          speed:     Math.round(speed),
          heading,
          timestamp: ts,
        },
      },
    },
    { new: true, lean: true }
  );

  logger.info('📍 [TCP] %s | lat=%s lng=%s speed=%s', imei, lat.toFixed(6), lng.toFixed(6), speed);

  // Emit real-time update to Flutter via Socket.IO
  if (global.io) {
    global.io.emit('vehicleMovement', {
      id:          updated._id.toString(),
      imei:        updated.imei,
      lat,
      lng,
      speed:       updated.speed,
      status,
      heading,
      isOnline:    true,
      lastUpdate:  ts,
    });
  }

  // Non-blocking: save ping + check geofences
  setImmediate(async () => {
    try {
      if (speed > 0) {
        await LocationPing.create({
          vehicleId: updated._id,
          latitude:  lat,
          longitude: lng,
          speed:     updated.speed,
          heading,
          timestamp: ts,
        });
      }
      await GPSEngine.checkGeofences(updated);
    } catch (err) {
      logger.error('❌ [TCP] Post-process error: %s', err.message);
    }
  });
}

// ── TCP Server ────────────────────────────────────────────────────────────────
const startGpsServer = (port) => {
  const server = net.createServer((socket) => {
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.info('🛰️ [TCP] Device connected from %s', remoteAddr);

    // Each socket gets its own GT06 parser instance
    const parser = new Gt06();
    let   deviceImei = null;

    socket.on('data', (data) => {
      try {
        parser.parse(data);
      } catch (err) {
        logger.warn('⚠️ [TCP] Parse error from %s: %s', remoteAddr, err.message);
        return;
      }

      // Send ACK if device expects a response (login, heartbeat, etc.)
      if (parser.expectsResponse) {
        try {
          socket.write(parser.responseMsg);
        } catch (e) {
          logger.warn('⚠️ [TCP] Failed to send ACK: %s', e.message);
        }
      }

      // Process each message in the buffer
      for (const msg of parser.msgBuffer) {
        try {
          handleGt06Message(msg, socket, remoteAddr, (imei) => {
            deviceImei = imei;
          });
        } catch (err) {
          logger.error('❌ [TCP] Message handler error: %s', err.message);
        }
      }

      parser.clearMsgBuffer();
    });

    socket.on('close', () => {
      logger.info('🔌 [TCP] Device disconnected: %s (IMEI: %s)',
        remoteAddr, deviceImei || 'unknown');

      // Mark device offline when TCP connection drops
      if (deviceImei) {
        Vehicle.findOneAndUpdate(
          { imei: deviceImei },
          { $set: { isOnline: false, isLive: false, status: 'offline' } }
        ).catch(() => {});
      }
    });

    socket.on('error', (err) => {
      logger.error('❌ [TCP] Socket error (%s): %s', remoteAddr, err.message);
    });

    // Keep connection alive
    socket.setKeepAlive(true, 30000);
    socket.setTimeout(120000); // 2 min timeout — device should heartbeat every 60s
    socket.on('timeout', () => {
      logger.warn('⏰ [TCP] Socket timeout: %s', remoteAddr);
      socket.destroy();
    });
  });

  server.on('error', (err) => {
    logger.error('❌ [TCP] Server error: %s', err.message);
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info('📡 GPS TCP Receiver online on port %d', port);
  });

  return server;
};

// ── GT06 Message Handler ──────────────────────────────────────────────────────
function handleGt06Message(msg, socket, remoteAddr, onImei) {
  const type = msg.type || msg.msgType;

  switch (type) {

    // ── Login packet — device sends IMEI to identify itself ─────────────────
    case 'login':
    case 'LOGIN': {
      const imei = msg.imei || msg.deviceId;
      if (imei) {
        onImei(String(imei));
        logger.info('🔑 [TCP] Login from IMEI: %s (%s)', imei, remoteAddr);
      }
      break;
    }

    // ── GPS location packet ───────────────────────────────────────────────────
    case 'gps':
    case 'GPS':
    case 'location':
    case 'LOCATION': {
      const imei = msg.imei || msg.deviceId;
      if (!imei) break;

      const rawLat = msg.latitude  ?? msg.lat;
      const rawLng = msg.longitude ?? msg.lng;

      if (rawLat == null || rawLng == null) break;

      // Convert GCJ-02 → WGS-84
      const { lat, lng } = gcj02ToWgs84(parseFloat(rawLng), parseFloat(rawLat));

      const speed   = msg.speed   ?? 0;
      const heading = msg.course  ?? msg.heading ?? 0;
      const gpsTime = msg.gpsTime ?? msg.dateTime ?? msg.timestamp;
      const timestamp = gpsTime ? new Date(gpsTime) : new Date();

      processPosition({
        imei: String(imei),
        lat,
        lng,
        speed:   parseFloat(speed),
        heading: parseFloat(heading),
        timestamp,
      }).catch(err => logger.error('❌ [TCP] processPosition error: %s', err.message));

      break;
    }

    // ── Heartbeat — keep-alive, no position data ──────────────────────────────
    case 'heartbeat':
    case 'HEARTBEAT': {
      const imei = msg.imei || msg.deviceId;
      if (imei) {
        logger.info('💓 [TCP] Heartbeat from IMEI: %s', imei);
        // Update lastUpdate so device stays "online"
        Vehicle.findOneAndUpdate(
          { imei: String(imei) },
          { $set: { isOnline: true, isLive: true, lastUpdate: new Date() } }
        ).catch(() => {});
      }
      break;
    }

    // ── Alarm packet ──────────────────────────────────────────────────────────
    case 'alarm':
    case 'ALARM': {
      const imei = msg.imei || msg.deviceId;
      logger.warn('🚨 [TCP] Alarm from IMEI: %s | type: %s', imei, msg.alarmType || 'unknown');
      // Position data is often included in alarm packets too
      if (msg.latitude && msg.longitude) {
        const { lat, lng } = gcj02ToWgs84(
          parseFloat(msg.longitude),
          parseFloat(msg.latitude)
        );
        processPosition({
          imei:      String(imei),
          lat, lng,
          speed:     parseFloat(msg.speed   ?? 0),
          heading:   parseFloat(msg.course  ?? 0),
          timestamp: new Date(),
        }).catch(() => {});
      }
      break;
    }

    default:
      // Log unknown message types to help debug new device variants
      logger.debug('📦 [TCP] Unknown message type: %s | data: %j', type, msg);
      break;
  }
}

module.exports = {
  startGpsServer,
  processPosition,
};