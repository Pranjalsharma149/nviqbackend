'use strict';

/**
 * services/gps.server.js  (updated)
 *
 * TCP server for GT06 hardware devices.
 * ALL position data is now forwarded to processIncomingData() in
 * data.processor.js — the single unified pipeline.
 *
 * Changes vs original:
 *   - Removed direct Vehicle/LocationPing writes (processor handles them)
 *   - Removed duplicate gcj02ToWgs84 (processor handles conversion)
 *   - processPosition() now calls processIncomingData() with source='tcp'
 *   - GPS coordinates are still converted here so the raw WGS-84 lat/lng
 *     is available for the duplicate guard in processPosition.
 *     The processor receives needsGcjConversion=false so it won't re-convert.
 */

const net    = require('net');
const Gt06   = require('gt06');
const logger = require('../utils/logger');
const GPSEngine = require('../controllers/geofenceController');
const { processIncomingData } = require('./data.processor');

// ── GCJ-02 → WGS-84 ──────────────────────────────────────────────────────────
// Kept here so we can do the duplicate jitter check with real-world coordinates
// BEFORE handing off to the processor.
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

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_SPEED_KMH = 250;
const INDIA_BOUNDS  = { minLat: 6.0, maxLat: 37.6, minLng: 68.0, maxLng: 97.5 };

function isValidCoordinate(lat, lng) {
  if (!isFinite(lat) || !isFinite(lng)) return false;
  if (Math.abs(lat) < 0.1 && Math.abs(lng) < 0.1) return false;
  if (lat < INDIA_BOUNDS.minLat || lat > INDIA_BOUNDS.maxLat) return false;
  if (lng < INDIA_BOUNDS.minLng || lng > INDIA_BOUNDS.maxLng) return false;
  return true;
}

// ── processPosition ───────────────────────────────────────────────────────────
// Thin validation wrapper; hands off to data.processor.js
async function processPosition({ imei, lat, lng, speed, heading, gpsTimestamp, satellites, accuracy }) {
  // Basic sanity checks before hitting the DB pipeline
  if (!isValidCoordinate(lat, lng)) {
    logger.warn('⚠️ [TCP] Invalid coords for IMEI=%s: lat=%s lng=%s', imei, lat, lng);
    return;
  }
  if (speed > MAX_SPEED_KMH) {
    logger.warn('⚠️ [TCP] Impossible speed for IMEI=%s: %s km/h', imei, speed);
    return;
  }

  // Hand off to unified processor.
  // Coordinates are already WGS-84 (converted above in handleGt06Message).
  // needsGcjConversion is false → processor skips the GCJ conversion step.
  await processIncomingData(
    {
      imei,
      latitude:      lat,
      longitude:     lng,
      speed:         parseFloat(speed ?? 0),
      heading:       parseFloat(heading ?? 0),
      satellites:    parseInt(satellites ?? 0, 10),
      accuracy:      parseFloat(accuracy  ?? 0),
      gpsTimestamp,   // ISO string or null
      ignition:      null,   // GT06 doesn't always report ignition
    },
    'tcp'
  );

  // Non-blocking geofence check (uses updated vehicle doc from DB)
  setImmediate(async () => {
    try {
      const Vehicle = require('../models/Vehicle');
      const updated = await Vehicle.findOne({ imei }).lean();
      if (updated) await GPSEngine.checkGeofences(updated);
    } catch (err) {
      logger.error('❌ [TCP] Geofence check error: %s', err.message);
    }
  });
}

// ── TCP Server ────────────────────────────────────────────────────────────────
const startGpsServer = (port) => {
  const server = net.createServer((socket) => {
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.info('🛰️ [TCP] Device connected from %s', remoteAddr);

    const parser   = new Gt06();
    let deviceImei = null;

    socket.on('data', (data) => {
      try {
        parser.parse(data);
      } catch (err) {
        logger.warn('⚠️ [TCP] Parse error from %s: %s', remoteAddr, err.message);
        return;
      }

      if (parser.expectsResponse) {
        try { socket.write(parser.responseMsg); } catch (_) {}
      }

      for (const msg of parser.msgBuffer) {
        try {
          handleGt06Message(msg, socket, remoteAddr, (imei) => { deviceImei = imei; });
        } catch (err) {
          logger.error('❌ [TCP] Message handler error: %s', err.message);
        }
      }

      parser.clearMsgBuffer();
    });

    socket.on('close', () => {
      logger.info('🔌 [TCP] Disconnected: %s (IMEI: %s)', remoteAddr, deviceImei ?? 'unknown');
      if (deviceImei) {
        const Vehicle = require('../models/Vehicle');
        Vehicle.findOneAndUpdate(
          { imei: deviceImei },
          { $set: { isOnline: false, isLive: false, status: 'offline' } }
        ).catch(() => {});
      }
    });

    socket.on('error', (err) =>
      logger.error('❌ [TCP] Socket error (%s): %s', remoteAddr, err.message)
    );

    socket.setKeepAlive(true, 30000);
    socket.setTimeout(120000);
    socket.on('timeout', () => { logger.warn('⏰ [TCP] Timeout: %s', remoteAddr); socket.destroy(); });
  });

  server.on('error', (err) => logger.error('❌ [TCP] Server error: %s', err.message));

  server.listen(port, '0.0.0.0', () =>
    logger.info('📡 GPS TCP Receiver online on port %d', port)
  );

  return server;
};

// ── GT06 Message Handler ──────────────────────────────────────────────────────
function handleGt06Message(msg, socket, remoteAddr, onImei) {
  const type = (msg.type || msg.msgType || '').toLowerCase();

  switch (type) {
    case 'login': {
      const imei = msg.imei || msg.deviceId;
      if (imei) {
        onImei(String(imei));
        logger.info('🔑 [TCP] Login IMEI=%s (%s)', imei, remoteAddr);
      }
      break;
    }

    case 'gps':
    case 'location': {
      const imei  = msg.imei || msg.deviceId;
      const rawLat = msg.latitude  ?? msg.lat;
      const rawLng = msg.longitude ?? msg.lng;

      if (!imei || rawLat == null || rawLng == null) break;

      // Convert GCJ-02 → WGS-84 HERE so processPosition gets real coordinates
      // const { lat, lng } = gcj02ToWgs84(parseFloat(rawLng), parseFloat(rawLat));
      const lat = parseFloat(rawLat);
      const lng = parseFloat(rawLng);
      const gpsTimestamp  = msg.gpsTime ?? msg.dateTime ?? msg.timestamp ?? null;

      processPosition({
        imei:         String(imei),
        lat, lng,
        speed:        parseFloat(msg.speed  ?? 0),
        heading:      parseFloat(msg.course ?? msg.heading ?? 0),
        satellites:   parseInt(msg.satellites ?? msg.sats ?? 0, 10),
        accuracy:     parseFloat(msg.accuracy ?? msg.hdop  ?? 0),
        gpsTimestamp,
      }).catch(err => logger.error('❌ [TCP] processPosition error: %s', err.message));
      break;
    }

    case 'heartbeat': {
      const imei = msg.imei || msg.deviceId;
      if (imei) {
        logger.info('💓 [TCP] Heartbeat IMEI=%s', imei);
        const Vehicle = require('../models/Vehicle');
        Vehicle.findOneAndUpdate(
          { imei: String(imei) },
          { $set: { isOnline: true, isLive: true, lastUpdate: new Date() } }
        ).catch(() => {});
      }
      break;
    }

    case 'alarm': {
      const imei  = msg.imei || msg.deviceId;
      logger.warn('🚨 [TCP] Alarm IMEI=%s type=%s', imei, msg.alarmType ?? 'unknown');
      if (msg.latitude && msg.longitude && imei) {
        // const { lat, lng } = gcj02ToWgs84(parseFloat(msg.longitude), parseFloat(msg.latitude));
        const lat = parseFloat(msg.latitude);
        const lng = parseFloat(msg.longitude);
        processPosition({
          imei: String(imei), lat, lng,
          speed: parseFloat(msg.speed ?? 0),
          heading: parseFloat(msg.course ?? 0),
          gpsTimestamp: msg.gpsTime ?? msg.dateTime ?? null,
        }).catch(() => {});
      }
      break;
    }

    default:
      logger.debug('📦 [TCP] Unknown msg type=%s | %j', type, msg);
  }
}

module.exports = { startGpsServer, processPosition };