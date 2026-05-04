'use strict';

const net          = require('net');
const Gt06         = require('gt06');
const Vehicle      = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const GPSEngine    = require('../controllers/geofenceController');
const logger       = require('../utils/logger');

// ── GCJ-02 → WGS-84 converter ────────────────────────────────────────────────
function gcj02ToWgs84(gcjLng, gcjLat) {
  const a  = 6378245.0;
  const ee = 0.00669342162296594323;

  function transformLat(lng, lat) {
    let r = -100 + 2*lng + 3*lat + 0.2*lat*lat + 0.1*lng*lat
            + 0.2*Math.sqrt(Math.abs(lng));
    r += (20*Math.sin(6*lng*Math.PI) + 20*Math.sin(2*lng*Math.PI)) * 2/3;
    r += (20*Math.sin(lat*Math.PI)   + 40*Math.sin(lat/3*Math.PI)) * 2/3;
    r += (160*Math.sin(lat/12*Math.PI) + 320*Math.sin(lat*Math.PI/30)) * 2/3;
    return r;
  }

  function transformLng(lng, lat) {
    let r = 300 + lng + 2*lat + 0.1*lng*lng + 0.1*lng*lat
            + 0.1*Math.sqrt(Math.abs(lng));
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
    lat: gcjLat - (dLat * 180) / ((a*(1-ee))/(magic*sqrtMagic) * Math.PI),
    lng: gcjLng - (dLng * 180) / (a/sqrtMagic * Math.cos(radLat) * Math.PI),
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_GPS_AGE_MINUTES  = 10;   // Reject fixes older than 10 minutes
const MAX_SPEED_KMH        = 250;  // Reject impossible speeds
const INDIA_BOUNDS = {             // Rough India bounding box
  minLat: 6.0,  maxLat: 37.6,
  minLng: 68.0, maxLng: 97.5,
};

// ── Shared State ──────────────────────────────────────────────────────────────
const imeiCache = new Map();
const lastPos   = new Map();

// ── Vehicle resolver (cached 5 min) ──────────────────────────────────────────
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

// ── Jitter filter ─────────────────────────────────────────────────────────────
function isDuplicate(imei, lat, lng) {
  const p = lastPos.get(imei);
  if (!p) return false;
  const ageSec = (Date.now() - p.ts) / 1000;
  return ageSec < 5 &&
    Math.abs(lat - p.lat) < 0.000009 &&
    Math.abs(lng - p.lng) < 0.000009;
}

// ── Coordinate validator ──────────────────────────────────────────────────────
function isValidCoordinate(lat, lng) {
  if (!isFinite(lat) || !isFinite(lng))     return false;
  if (Math.abs(lat) < 0.1 && Math.abs(lng) < 0.1) return false; // null island
  if (lat < INDIA_BOUNDS.minLat || lat > INDIA_BOUNDS.maxLat)   return false;
  if (lng < INDIA_BOUNDS.minLng || lng > INDIA_BOUNDS.maxLng)   return false;
  return true;
}

// ── GPS age validator ─────────────────────────────────────────────────────────
function isGpsFresh(gpsTimestamp) {
  if (!gpsTimestamp) return false;
  const serverTime  = Date.now();
  const gpsTime     = new Date(gpsTimestamp).getTime();
  if (isNaN(gpsTime)) return false;

  const diffMinutes = Math.abs(serverTime - gpsTime) / 60000;
  return diffMinutes <= MAX_GPS_AGE_MINUTES;
}

// ── Core position processor ───────────────────────────────────────────────────
async function processPosition({
  imei,
  lat,
  lng,
  speed,
  heading,
  gpsTimestamp,    // The GPS device fix time
  satellites = 0,
  accuracy   = 0,
}) {
  const serverReceiptTime = new Date(); // Always use server time for freshness

  // ── Validate coordinates ───────────────────────────────────────────────────
  if (!isValidCoordinate(lat, lng)) {
    logger.warn('⚠️ [TCP] REJECTED invalid coords for %s: lat=%s lng=%s',
      imei, lat, lng);
    return;
  }

  // ── Validate GPS fix freshness ─────────────────────────────────────────────
  if (gpsTimestamp && !isGpsFresh(gpsTimestamp)) {
    const ageMin = Math.round(
      Math.abs(Date.now() - new Date(gpsTimestamp).getTime()) / 60000
    );
    logger.warn(
      '⚠️ [TCP] REJECTED stale GPS fix for %s: ' +
      'gpsTime=%s serverTime=%s age=%dmin',
      imei,
      new Date(gpsTimestamp).toISOString(),
      serverReceiptTime.toISOString(),
      ageMin
    );
    // Still mark device online (it connected) but don't update position
    await Vehicle.findOneAndUpdate(
      { imei },
      {
        $set: {
          isOnline:     true,
          isLive:       true,
          lastOnlineAt: serverReceiptTime,
          // DO NOT update latitude/longitude/lastUpdate
        },
      }
    ).catch(() => {});
    return;
  }

  // ── Validate speed ─────────────────────────────────────────────────────────
  if (speed > MAX_SPEED_KMH) {
    logger.warn('⚠️ [TCP] REJECTED impossible speed for %s: %s km/h', imei, speed);
    return;
  }

  // ── Duplicate check ────────────────────────────────────────────────────────
  if (isDuplicate(imei, lat, lng)) return;
  lastPos.set(imei, { lat, lng, ts: Date.now() });

  // ── Resolve vehicle ────────────────────────────────────────────────────────
  const vehicle = await resolveVehicle(imei);
  if (!vehicle) {
    logger.warn('⚠️ [TCP] Unknown IMEI: %s', imei);
    return;
  }

  const status = speed > 5 ? 'moving' : 'idle';

  // ── Update DB ──────────────────────────────────────────────────────────────
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

        // KEY FIX: Store BOTH times separately
        lastUpdate:    serverReceiptTime, // When SERVER received it
        gpsFixTime:    gpsTimestamp ? new Date(gpsTimestamp) : serverReceiptTime,
        lastOnlineAt:  serverReceiptTime,

        lastKnownLocation: {
          latitude:   lat,
          longitude:  lng,
          speed:      Math.round(speed),
          heading,
          timestamp:  gpsTimestamp ? new Date(gpsTimestamp) : serverReceiptTime,
          serverTime: serverReceiptTime,
        },
      },
    },
    { new: true, lean: true }
  );

  logger.info(
    '📍 [TCP] %s | lat=%s lng=%s speed=%s sats=%s gpsAge=%ds',
    imei,
    lat.toFixed(6),
    lng.toFixed(6),
    speed,
    satellites,
    gpsTimestamp
      ? Math.round((Date.now() - new Date(gpsTimestamp).getTime()) / 1000)
      : 0
  );

  // ── Emit to Flutter via Socket.IO ──────────────────────────────────────────
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
      satellites,
      accuracy,

      // KEY FIX: Send BOTH timestamps so Flutter can check freshness
      gpsTime:    gpsTimestamp
                    ? new Date(gpsTimestamp).toISOString()
                    : serverReceiptTime.toISOString(),
      deviceTime: serverReceiptTime.toISOString(), // Server receipt time
      lastUpdate: serverReceiptTime.toISOString(),
    });
  }

  // ── Non-blocking: save ping + geofence check ───────────────────────────────
  setImmediate(async () => {
    try {
      if (speed > 0) {
        await LocationPing.create({
          vehicleId:  updated._id,
          latitude:   lat,
          longitude:  lng,
          speed:      updated.speed,
          heading,
          timestamp:  gpsTimestamp ? new Date(gpsTimestamp) : serverReceiptTime,
          serverTime: serverReceiptTime,
          satellites,
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

    const parser = new Gt06();
    let deviceImei = null;

    socket.on('data', (data) => {
      try {
        parser.parse(data);
      } catch (err) {
        logger.warn('⚠️ [TCP] Parse error from %s: %s', remoteAddr, err.message);
        return;
      }

      if (parser.expectsResponse) {
        try {
          socket.write(parser.responseMsg);
        } catch (e) {
          logger.warn('⚠️ [TCP] ACK failed: %s', e.message);
        }
      }

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
      logger.info('🔌 [TCP] Disconnected: %s (IMEI: %s)',
        remoteAddr, deviceImei || 'unknown');
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

    socket.setKeepAlive(true, 30000);
    socket.setTimeout(120000);
    socket.on('timeout', () => {
      logger.warn('⏰ [TCP] Timeout: %s', remoteAddr);
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

    case 'login':
    case 'LOGIN': {
      const imei = msg.imei || msg.deviceId;
      if (imei) {
        onImei(String(imei));
        logger.info('🔑 [TCP] Login IMEI: %s (%s)', imei, remoteAddr);
      }
      break;
    }

    case 'gps':
    case 'GPS':
    case 'location':
    case 'LOCATION': {
      const imei = msg.imei || msg.deviceId;
      if (!imei) break;

      const rawLat = msg.latitude  ?? msg.lat;
      const rawLng = msg.longitude ?? msg.lng;
      if (rawLat == null || rawLng == null) break;

      const { lat, lng } = gcj02ToWgs84(parseFloat(rawLng), parseFloat(rawLat));

      // KEY FIX: Pass gpsTimestamp separately from server time
      const gpsTimestamp = msg.gpsTime ?? msg.dateTime ?? msg.timestamp ?? null;

      processPosition({
        imei:         String(imei),
        lat,
        lng,
        speed:        parseFloat(msg.speed  ?? 0),
        heading:      parseFloat(msg.course ?? msg.heading ?? 0),
        satellites:   parseInt(msg.satellites ?? msg.sats ?? 0, 10),
        accuracy:     parseFloat(msg.accuracy ?? msg.hdop ?? 0),
        gpsTimestamp, // GPS device fix time — may be stale
      }).catch(err =>
        logger.error('❌ [TCP] processPosition error: %s', err.message)
      );
      break;
    }

    case 'heartbeat':
    case 'HEARTBEAT': {
      const imei = msg.imei || msg.deviceId;
      if (imei) {
        logger.info('💓 [TCP] Heartbeat IMEI: %s', imei);
        Vehicle.findOneAndUpdate(
          { imei: String(imei) },
          { $set: { isOnline: true, isLive: true, lastUpdate: new Date() } }
        ).catch(() => {});
      }
      break;
    }

    case 'alarm':
    case 'ALARM': {
      const imei = msg.imei || msg.deviceId;
      logger.warn('🚨 [TCP] Alarm IMEI: %s type: %s',
        imei, msg.alarmType || 'unknown');
      if (msg.latitude && msg.longitude) {
        const { lat, lng } = gcj02ToWgs84(
          parseFloat(msg.longitude),
          parseFloat(msg.latitude)
        );
        const gpsTimestamp = msg.gpsTime ?? msg.dateTime ?? null;
        processPosition({
          imei:         String(imei),
          lat, lng,
          speed:        parseFloat(msg.speed  ?? 0),
          heading:      parseFloat(msg.course ?? 0),
          gpsTimestamp,
        }).catch(() => {});
      }
      break;
    }

    default:
      logger.debug('📦 [TCP] Unknown msg type: %s | %j', type, msg);
      break;
  }
}

module.exports = { startGpsServer, processPosition };