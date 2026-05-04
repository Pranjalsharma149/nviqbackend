'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const seedDevices = require('./scripts/seedDevices');
const logger = require('./utils/logger');
const wanwayPoller = require('./services/wanway.poller');

// ── Firebase Admin ─────────────────────────────────────────────────────────────
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON 
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
      : {
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        };

    if (!serviceAccount.projectId) throw new Error('Missing Firebase Config');
    
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    logger.info('🔥 Firebase Admin initialized');
  }
} catch (e) {
  logger.warn('⚠️ Firebase not configured: %s', e.message);
}

async function boot() {
  // 1. Database Connection
  await connectDB();
  
  // 2. Seed devices in Dev only
  if (process.env.NODE_ENV !== 'production') {
    await seedDevices();
  }

  const app = express();
  const server = http.createServer(app);

  // 3. Socket.IO
  const io = socketIo(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket'], 
    pingInterval: 10000,
    pingTimeout: 5000,
    bufferSize: 1e6 
  });
  
  global.io = io;

  // ── Middleware ──────────────────────────────────────────────────────────────
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
  app.use(express.json({ limit: '2mb' }));

  app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2000,
    standardHeaders: true,
  }));

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use('/api/auth',      require('./routes/auth.routes'));
  app.use('/api/vehicles',  require('./routes/vehicles.routes'));
  app.use('/api/tracking',  require('./routes/tracking.routes'));
  app.use('/api/alerts',    require('./routes/alerts.routes'));
  app.use('/api/analytics', require('./routes/analytics.routes'));
  app.use('/api/support',   require('./routes/support.routes'));
  app.use('/api/geofences', require('./routes/geofence.routes'));

  // ✅ NEW: Trip routes (history + analytics hub)
  app.use('/api/trips',     require('./routes/trip.routes'));

  // ── Socket Connection Logic ─────────────────────────────────────────────────
  io.on('connection', (socket) => {
    logger.info('🔌 User connected: %s', socket.id);

    socket.on('join_fleet', (fleetId) => {
      socket.join(fleetId);
      logger.info('User %s monitoring fleet: %s', socket.id, fleetId);
    });

    socket.on('disconnect', () => logger.info('❌ User disconnected: %s', socket.id));
  });

  // ── Background Services ─────────────────────────────────────────────────────

  // A. TCP GPS Server (GT06/Hardware devices)
  const GPS_PORT = process.env.GPS_TCP_PORT || 5001;
  require('./services/gps.server').startGpsServer(GPS_PORT);

  // B. WanWay Cloud Poller
  wanwayPoller.start();

  // ── Launch HTTP Server ──────────────────────────────────────────────────────
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, '0.0.0.0', () => {
    logger.info('🚀 NVIQ Fleet Server online on port %d', PORT);
  });
}

boot().catch(err => {
  logger.error('❌ Boot Sequence Failed: %s', err.stack);
  process.exit(1);
});