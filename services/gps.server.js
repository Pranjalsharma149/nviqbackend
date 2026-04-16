// services/gps.server.js
// PT06/GT06 GPS tracker
// ✅ FIX 1: imeiCache invalidated at START of processPosition (was serving stale Delhi coords)
// ✅ FIX 2: isDuplicate only blocks if BOTH time < 3s AND position unchanged (was blocking all retransmits)
// ✅ FIX 3: verbose logging retained so you can see every packet
'use strict';

const net          = require('net');
const Vehicle      = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const GPSEngine    = require('./gps.engine');
const devices      = require('../config/devices');

// ── IMEI → Vehicle cache (5-min TTL) ─────────────────────────────────────────
const imeiCache = new Map();

async function resolveVehicle(imei) {
  const hit = imeiCache.get(imei);
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.doc;

  let doc = await Vehicle.findOne({ $or: [{ imei }, { vehicleReg: imei }] }).lean();

  if (!doc) {
    const cfg = devices.getByIMEI(imei);
    if (cfg) {
      try {
        doc = (await Vehicle.create({
          imei:        cfg.imei,
          vehicleReg:  cfg.vehicleReg.toUpperCase(),
          name:        cfg.name,
          type:        cfg.type     || 'car',
          protocol:    cfg.protocol || 'GT06',
          pocName:     cfg.pocName    || '',
          pocContact:  cfg.pocContact || '',
          latitude:    28.6139,
          longitude:   77.2090,
          speed: 0, heading: 0, fuel: 100, batteryLevel: 100,
          gpsSignal: false, status: 'offline',
          isLive: false, isOnline: false,
          lastUpdate: new Date(),
        })).toObject();
        console.log(`✅ Auto-created vehicle: ${cfg.name} (IMEI: ${imei})`);
      } catch (_) {
        doc = await Vehicle.findOne({
          $or: [{ imei }, { vehicleReg: cfg.vehicleReg.toUpperCase() }]
        }).lean();
      }
    } else {
      console.warn(`⚠️  Unknown IMEI: ${imei}`);
      console.warn(`   → Add it to config/devices.js to enable tracking`);
      return null;
    }
  }

  if (doc) imeiCache.set(imei, { doc, ts: Date.now() });
  return doc;
}

// ── Dedup: only block if BOTH within 3s AND position truly unchanged ──────────
// ✅ FIX 2: removed the early `if (ageSec < 3) return true` that blocked ALL
//    packets arriving quickly, including first real GPS fix after login ACK.
//    Now we only block if the device is reporting the exact same spot again.
const lastPos = new Map();
function isDuplicate(imei, lat, lng) {
  const p = lastPos.get(imei);
  if (!p) return false;
  const ageSec = (Date.now() - p.ts) / 1000;
  const sameLat = Math.abs(lat - p.lat) < 0.000009; // ~1 m
  const sameLng = Math.abs(lng - p.lng) < 0.000009;
  // Block ONLY when: recent AND identical position
  return ageSec < 3 && sameLat && sameLng;
}

// ── Core: process GPS position from PT06 ─────────────────────────────────────
async function processPosition({ imei, lat, lng, speed, heading, altitude = 0, gpsSignal = true, timestamp }) {
  // Reject clearly invalid coordinates (0,0 = no GPS fix yet)
  if (!lat || !lng || (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001)) {
    console.log(`📍 [${imei}] GPS not fixed yet (lat:${lat}, lng:${lng}) — waiting`);
    return;
  }

  if (isDuplicate(imei, lat, lng)) {
    console.log(`📍 [${imei}] Duplicate position skipped`);
    return;
  }
  lastPos.set(imei, { lat, lng, ts: Date.now() });

  console.log(`📍 GPS UPDATE [${imei}] lat:${lat.toFixed(6)} lng:${lng.toFixed(6)} speed:${speed.toFixed(1)}km/h signal:${gpsSignal}`);

  // ✅ FIX 1: Invalidate cache BEFORE resolving so we never use a stale
  //    Delhi-defaulted doc that was written at vehicle creation time.
  //    Without this, resolveVehicle() could return a 5-minute-old record
  //    whose lat/lng is still 28.6139, 77.2090 (the creation default).
  imeiCache.delete(imei);

  const vehicle = await resolveVehicle(imei);
  if (!vehicle) return;

  const status = speed > 2 ? 'moving' : 'idle';

  // Always save location even with poor GPS signal
  const updated = await Vehicle.findByIdAndUpdate(
    vehicle._id,
    {
      $set: {
        latitude:   lat,
        longitude:  lng,
        altitude,
        speed,
        heading,
        gpsSignal,
        status,
        isLive:     true,
        isOnline:   true,
        lastUpdate: timestamp,
      },
    },
    { new: true }
  );

  if (!updated) {
    console.error(`❌ Vehicle update failed for ${imei}`);
    return;
  }

  // Refresh cache with the freshly-updated document
  imeiCache.set(imei, { doc: updated.toObject(), ts: Date.now() });

  // In-memory state for zero-latency reads
  if (!global.vehicleStates) global.vehicleStates = {};
  global.vehicleStates[imei] = { lat, lng, speed, heading, status, lastUpdate: timestamp };

  // Emit to ALL Flutter clients — this moves the map marker
  if (global.io) {
    const payload = {
      id:           updated._id.toString(),
      vehicleId:    updated._id.toString(),
      vehicleReg:   updated.vehicleReg,
      name:         updated.name,
      type:         updated.type,
      // Send BOTH field-name variants so any Flutter _norm() mapping works
      lat,
      lng,
      latitude:     lat,
      longitude:    lng,
      speed,
      heading,
      altitude,
      status,
      isLive:       true,
      isOnline:     true,
      gpsSignal,
      gps:          gpsSignal,
      fuel:         updated.fuel,
      batteryLevel: updated.batteryLevel,
      driverName:   updated.pocName,
      driverPhone:  updated.pocContact,
      timestamp:    timestamp.toISOString(),
      lastUpdate:   timestamp.toISOString(),
    };
    global.io.emit('vehicleMovement', payload);
    console.log(`📡 Emitted vehicleMovement → ${global.io.engine.clientsCount} Flutter client(s) | lat:${lat.toFixed(6)} lng:${lng.toFixed(6)}`);
  } else {
    console.warn('⚠️  Socket.IO not ready — vehicleMovement not emitted');
  }

  // Save ping to DB (fire-and-forget)
  LocationPing.create({
    vehicleId:    updated._id,
    latitude:     lat,
    longitude:    lng,
    altitude,
    speed,
    heading,
    gpsSignal,
    status,
    fuel:         updated.fuel,
    batteryLevel: updated.batteryLevel,
    timestamp,
  }).catch(e => console.error('Ping save error:', e.message));

  // Run alert engine (fire-and-forget)
  GPSEngine.processUpdate(updated).catch(e => console.error('Engine error:', e.message));
}

// ── GT06 binary parsers ───────────────────────────────────────────────────────

function parseIMEI(buf, isShort) {
  const o = isShort ? 4 : 5;
  if (buf.length < o + 8) return null;
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += buf[o + i].toString(16).padStart(2, '0');
  }
  // GT06 IMEI is BCD encoded in 8 bytes = 16 hex chars, drop leading zero
  return s.replace(/^0/, '').slice(0, 15);
}

function parseLocation(buf, isShort) {
  // Short packet layout after header(2) + length(1) + protocol(1):
  // [YY MM DD HH MM SS] GPS_INFO LAT(4) LNG(4) SPEED COURSE(2) ...
  const o = isShort ? 4 : 5;
  if (buf.length < o + 19) return null;

  try {
    // Parse timestamp
    const ts = new Date(Date.UTC(
      2000 + buf[o],      // year
      buf[o + 1] - 1,     // month (0-indexed)
      buf[o + 2],         // day
      buf[o + 3],         // hour
      buf[o + 4],         // minute
      buf[o + 5]          // second
    ));

    // GPS info byte
    const info  = buf[o + 6];
    const sats  = (info >> 4) & 0x0F;   // upper 4 bits = satellite count
    const gpsOk = (info & 0x01) === 1;  // bit 0 = GPS positioned

    // Coordinates: stored as (degrees + minutes/60) * 30000
    // Formula: rawValue / 30000 / 60 = decimal degrees
    const latRaw = buf.readUInt32BE(o + 7);
    const lngRaw = buf.readUInt32BE(o + 11);
    const lat    = latRaw / 30000.0 / 60.0;
    const lng    = lngRaw / 30000.0 / 60.0;

    // Speed in knots → km/h
    const speed = buf[o + 15] * 1.852;

    // Course/flags word
    const course  = buf.readUInt16BE(o + 16);
    const heading = course & 0x03FF;    // lower 10 bits = heading degrees

    // Hemisphere flags (bits 10 and 11 of course word)
    const isNorth = (course >> 10) & 1; // 1 = North, 0 = South
    const isEast  = (course >> 11) & 1; // 1 = East,  0 = West

    const finalLat = isNorth ? lat : -lat;
    const finalLng = isEast  ? lng : -lng;

    console.log(`   Sats: ${sats}, Fix: ${gpsOk}, Lat: ${finalLat.toFixed(6)}, Lng: ${finalLng.toFixed(6)}, Speed: ${speed.toFixed(1)} km/h`);

    return {
      lat:       finalLat,
      lng:       finalLng,
      speed,
      heading,
      gpsSignal: gpsOk,
      timestamp: ts,
    };
  } catch (e) {
    console.error('parseLocation error:', e.message);
    return null;
  }
}

// Pre-built ACK buffers
const ACK = {
  loginS:    Buffer.from([0x78, 0x78, 0x05, 0x01, 0x00, 0x01, 0xD9, 0xDC, 0x0D, 0x0A]),
  loginL:    Buffer.from([0x79, 0x79, 0x00, 0x05, 0x01, 0x00, 0x01, 0xD9, 0xDC, 0x0D, 0x0A]),
  heartbeat: Buffer.from([0x78, 0x78, 0x05, 0x13, 0x00, 0x01, 0x94, 0x8E, 0x0D, 0x0A]),
  location:  Buffer.from([0x78, 0x78, 0x05, 0x12, 0x00, 0x01, 0xC1, 0xAA, 0x0D, 0x0A]),
};

// ── NMEA text fallback (some PT06 variants) ───────────────────────────────────
function handleNMEA(raw, imei) {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('$GPRMC') && !line.startsWith('$GNRMC')) continue;
    const p = line.split(',');
    if (p[2] !== 'A') continue; // A = active fix

    const toDec = (v, d) => {
      const n   = parseFloat(v);
      const deg = Math.floor(n / 100);
      const dec = deg + (n - deg * 100) / 60;
      return (d === 'S' || d === 'W') ? -dec : dec;
    };

    const lat   = toDec(p[3], p[4]);
    const lng   = toDec(p[5], p[6]);
    const speed = parseFloat(p[7] || 0) * 1.852; // knots → km/h

    console.log(`📍 NMEA [${imei}] lat:${lat.toFixed(6)} lng:${lng.toFixed(6)}`);
    processPosition({ imei, lat, lng, speed, heading: parseFloat(p[8] || 0), gpsSignal: true, timestamp: new Date() })
      .catch(e => console.error('NMEA process error:', e.message));
    break;
  }
}

// ── TCP connection handler ────────────────────────────────────────────────────
function handleConnection(socket) {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`\n📡 GPS device connected: ${remote}`);

  let buf  = Buffer.alloc(0);
  let imei = null;

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);

    // Detect NMEA text protocol
    const str = buf.toString('ascii');
    if (str.includes('$GPRMC') || str.includes('$GNRMC')) {
      if (imei) handleNMEA(str, imei);
      buf = Buffer.alloc(0);
      return;
    }

    // GT06 binary protocol packet loop
    // Handles TCP fragmentation (packets can arrive split across chunks)
    while (buf.length >= 4) {
      const isShort = buf[0] === 0x78 && buf[1] === 0x78;
      const isLong  = buf[0] === 0x79 && buf[1] === 0x79;

      if (!isShort && !isLong) {
        buf = buf.slice(1); // skip unknown byte
        continue;
      }

      const pktLen   = isShort ? buf[2] : (buf[2] << 8 | buf[3]);
      const totalLen = isShort ? pktLen + 5 : pktLen + 6;

      if (buf.length < totalLen) break; // wait for more data

      const pkt     = buf.slice(0, totalLen);
      buf           = buf.slice(totalLen);
      const msgType = isShort ? pkt[3] : pkt[4];

      console.log(`   Packet: type=0x${msgType.toString(16).padStart(2, '0')} len=${totalLen} from ${imei || remote}`);

      switch (msgType) {

        // ── Login (0x01) — first packet, contains IMEI ──────────────────────
        case 0x01: {
          imei = parseIMEI(pkt, isShort);
          if (!imei) {
            console.error('❌ Could not parse IMEI from login packet');
            break;
          }
          console.log(`✅ GT06 LOGIN: IMEI ${imei} from ${remote}`);
          socket.write(isShort ? ACK.loginS : ACK.loginL);

          if (global.io) {
            global.io.emit('deviceOnline', { imei, protocol: 'GT06' });
          }

          resolveVehicle(imei).then(v => {
            if (!v) return;
            Vehicle.findByIdAndUpdate(v._id, {
              $set: { isOnline: true, isLive: true }
            }).catch(() => {});
            console.log(`   Vehicle found: "${v.name}" (${v.vehicleReg})`);
          }).catch(() => {});
          break;
        }

        // ── Location (0x12) — GPS position ──────────────────────────────────
        case 0x12: {
          if (!imei) {
            console.warn('⚠️  Location packet before login — ignoring');
            socket.write(ACK.location);
            break;
          }
          const loc = parseLocation(pkt, isShort);
          if (loc) {
            processPosition({ imei, ...loc })
              .catch(e => console.error(`processPosition error (${imei}):`, e.message));
          } else {
            console.warn(`⚠️  Could not parse location packet from ${imei}`);
          }
          socket.write(ACK.location);
          break;
        }

        // ── Heartbeat (0x13) — keep-alive ────────────────────────────────────
        case 0x13: {
          socket.write(ACK.heartbeat);
          if (imei) {
            Vehicle.findOneAndUpdate(
              { $or: [{ imei }, { vehicleReg: imei }] },
              { $set: { isOnline: true, isLive: true, lastUpdate: new Date() } }
            ).catch(() => {});
          }
          break;
        }

        // ── Alarm (0x26) ──────────────────────────────────────────────────────
        case 0x26: {
          if (!imei) break;
          const alarmByte = isShort ? pkt[4] : pkt[5];
          const alarmType = alarmByte === 0x01 ? 'powerCut'
                          : alarmByte === 0x09 ? 'harshBraking'
                          : 'unauthorizedMovement';
          console.log(`🚨 Alarm from ${imei}: ${alarmType}`);

          resolveVehicle(imei).then(async v => {
            if (!v) return;
            const Alert = require('../models/Alert');
            const a = await Alert.create({
              vehicleId:  v._id,
              vehicleReg: v.vehicleReg,
              title:      `🚨 ${alarmType}`,
              message:    `${v.name} triggered alarm: ${alarmType}`,
              type:       alarmType,
              priority:   'critical',
              latitude:   v.latitude,
              longitude:  v.longitude,
              timestamp:  new Date(),
            });
            if (global.io) {
              global.io.emit('newAlert', { ...a.toObject(), id: a._id.toString() });
            }
          }).catch(() => {});
          break;
        }

        default:
          console.log(`   Unknown packet type: 0x${msgType.toString(16)}`);
          break;
      }
    }
  });

  socket.on('close', () => {
    console.log(`📴 GPS disconnected: ${imei || remote}`);
    if (!imei) return;

    if (global.io) {
      global.io.emit('deviceOffline', { imei });
    }

    Vehicle.findOneAndUpdate(
      { $or: [{ imei }, { vehicleReg: imei }] },
      { $set: { isLive: false, isOnline: false, status: 'offline' } }
    ).catch(() => {});

    imeiCache.delete(imei);
  });

  socket.on('error', e => {
    if (e.code !== 'ECONNRESET') {
      console.warn(`GPS socket error (${imei || remote}): ${e.message}`);
    }
  });

  // Kill idle connections after 2 minutes
  socket.setTimeout(120_000);
  socket.on('timeout', () => {
    console.warn(`⏰ GPS connection timeout: ${imei || remote}`);
    socket.destroy();
  });
}

// ── Start TCP server ──────────────────────────────────────────────────────────
function startGpsServer(port) {
  const server = net.createServer({ allowHalfOpen: false }, handleConnection);
  server.maxConnections = 2000;

  server.on('error', e => console.error('GPS TCP server error:', e.message));

  server.listen(port, '0.0.0.0', () => {
    console.log(`🛰  GPS TCP server on port ${port}`);
    console.log(`   Protocol: GT06 (PT06 2G/3G/4G)`);
    console.log(`   Registered IMEIs: ${devices.getAllIMEIs().join(', ')}`);
  });

  return server;
}

module.exports = { startGpsServer, processPosition };