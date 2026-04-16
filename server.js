// server.js
'use strict';

require('dotenv').config();

const express     = require('express');
const http        = require('http');
const socketIo    = require('socket.io');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const connectDB   = require('./config/db');
const seedDevices = require('./scripts/seedDevices');

// ── Firebase Admin ─────────────────────────────────────────────────────────────
// Reads from your .env: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
    } else if (process.env.FIREBASE_PRIVATE_KEY) {
      credential = admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      });
    } else {
      throw new Error('No Firebase credentials in .env');
    }
    admin.initializeApp({ credential });
    console.log('🔥 Firebase Admin initialized');
  }
} catch (e) {
  console.warn('⚠️  Firebase not configured:', e.message);
}

async function boot() {
  await connectDB();
  await seedDevices();

  const app    = express();
  const server = http.createServer(app);

  const io = socketIo(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingInterval: 25000,
    pingTimeout:  60000,
    transports:   ['websocket', 'polling'],
  });
  global.io            = io;
  global.vehicleStates = {};

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(morgan('dev'));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { success: false, message: 'Too many requests' },
  }));
  app.use((req, _res, next) => { req.io = io; next(); });

  app.use('/api/auth',      require('./routes/auth.routes'));
  app.use('/api/vehicles',  require('./routes/vehicles.routes'));
  app.use('/api/tracking',  require('./routes/tracking.routes'));
  app.use('/api/alerts',    require('./routes/alerts.routes'));
  app.use('/api/analytics', require('./routes/analytics.routes'));
  app.use('/api/geofences', require('./routes/geofence.routes'));

  app.get('/api/health', (_req, res) => {
    const mongoose = require('mongoose');
    res.json({
      success:   true,
      status:    'ok',
      db:        mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      uptime:    Math.floor(process.uptime()),
      devices:   Object.keys(global.vehicleStates),
      timestamp: new Date().toISOString(),
    });
  });

  app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('❌ Error:', err.message);
    res.status(err.status || 500).json({ success: false, message: err.message });
  });

  io.on('connection', socket => {
    console.log(`🔌 Flutter connected: ${socket.id}`);

    // Send all vehicles immediately — map populates without waiting for HTTP
    ;(async () => {
      try {
        const Vehicle  = require('./models/Vehicle');
        const vehicles = await Vehicle.find({}).sort({ lastUpdate: -1 }).lean();
        socket.emit('initialData', vehicles.map(_fmt));
        console.log(`📦 Sent ${vehicles.length} vehicles → ${socket.id}`);
      } catch (e) { console.error('initialData error:', e.message); }
    })();

    socket.on('requestInitialData', async () => {
      try {
        const Vehicle  = require('./models/Vehicle');
        const vehicles = await Vehicle.find({}).sort({ lastUpdate: -1 }).lean();
        socket.emit('initialData', vehicles.map(_fmt));
      } catch (e) { console.error('requestInitialData error:', e.message); }
    });

    socket.on('disconnect', r => console.log(`❌ Flutter disconnected: ${socket.id} (${r})`));
  });

  const GPS_PORT = parseInt(process.env.GPS_TCP_PORT || '5001', 10);
  require('./services/gps.server').startGpsServer(GPS_PORT);

  const PORT = parseInt(process.env.PORT || '5000', 10);
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n════════════════════════════════════════');
    console.log('🚀  NVIQ Backend — RUNNING');
    console.log('════════════════════════════════════════');
    console.log(`   API  →  http://localhost:${PORT}`);
    console.log(`   GPS  →  tcp://0.0.0.0:${GPS_PORT}`);
    console.log(`   IMEI →  356218606576971`);
    console.log('════════════════════════════════════════\n');
  });
}

function _fmt(v) {
  return {
    id:           v._id.toString(),
    name:         v.name,
    vehicleReg:   v.vehicleReg,
    type:         v.type,
    lat:          v.latitude,
    lng:          v.longitude,
    speed:        Number(v.speed)        || 0,
    heading:      Number(v.heading)      || 0,
    fuel:         Number(v.fuel)         || 0,
    batteryLevel: Number(v.batteryLevel) || 0,
    status:       v.status   || 'idle',
    isLive:       v.isLive   || false,
    isOnline:     v.isOnline || false,
    gpsSignal:    v.gpsSignal ?? true,
    gps:          v.gpsSignal ?? true,
    driverName:   v.pocName    || null,
    driverPhone:  v.pocContact || null,
    location:     v.location   || null,
    timestamp:    v.lastUpdate,
    imei:         v.imei || null,
  };
}

boot().catch(err => { console.error('❌ Boot failed:', err.message); process.exit(1); });