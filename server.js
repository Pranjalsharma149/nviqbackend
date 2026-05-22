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
const logger     = require('./utils/logger');

// ── Import all pollers ────────────────────────────────────────────────────────
const wanwayPoller      = require('./services/wanway.poller');
const fourGApiPoller    = require('./services/4g-api.poller');      // 4G API
const multitrackPoller  = require('./services/multitrack.poller');
const dailySummaryJob   = require('./cron/dailySummary.job');

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
  // 1. Database
  await connectDB();

  // 2. Seed (dev only)
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
    bufferSize: 1e6,
  });
  global.io = io;

  // ── Middleware ──────────────────────────────────────────────────────────────
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 2000, standardHeaders: true }));

  // ── KEEP-ALIVE ENDPOINT (for EasyCron/Cron-job.org) ──────────────────────────
  // Prevents Render from sleeping - call every 10 minutes via EasyCron
  app.get('/api/keep-alive', (req, res) => {
    logger.info('🔄 Keep-alive ping received - backend stays awake');
    res.json({
      status: 'ok',
      message: 'Backend is awake and ready',
      timestamp: new Date().toISOString(),
      pollers: {
        wanway: wanwayPoller.isPolling(),
        '4g-api': fourGApiPoller.isPolling(),
        multitrack: multitrackPoller.isPolling ? multitrackPoller.isPolling() : false,
      },
    });
  });

  // ── DEBUG/DIAGNOSTIC ENDPOINT ────────────────────────────────────────────────
  // Test endpoint: GET /api/debug/diagnose
  const { runDiagnostics } = require('./services/diagnostic');
  app.get('/api/debug/diagnose', async (req, res) => {
    try {
      logger.info('🔍 Starting diagnostics...');
      const result = await runDiagnostics();
      res.json(result);
    } catch (err) {
      logger.error('❌ Diagnostic error: %s', err.message);
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });

  // ── POLLER STATUS ENDPOINT ───────────────────────────────────────────────────
  // Check all pollers: GET /api/debug/pollers
  app.get('/api/debug/pollers', (req, res) => {
    res.json({
      timestamp: new Date().toISOString(),
      backend_status: 'online',
      pollers: {
        wanway: {
          name: 'WanWay IOP GPS',
          enabled: !!process.env.WANWAY_APPID,
          running: wanwayPoller.isPolling(),
          interval_ms: parseInt(process.env.WANWAY_POLL_INTERVAL || '30000', 10),
        },
        '4g-api': {
          name: '4G Vehicle Wise API',
          enabled: process.env['4G_API_ENABLED'] === 'true',
          running: fourGApiPoller.isPolling(),
          interval_ms: parseInt(process.env['4G_API_POLL_INTERVAL'] || '60000', 10),
          server: process.env['4G_API_BASE_URL'],
          company: process.env['4G_API_COMPANY_NAME'] || 'Telematics',
        },
        multitrack: {
          name: 'MultiTrack VTS',
          enabled: !!process.env.MULTITRACK_TOKEN,
          running: multitrackPoller.isPolling ? multitrackPoller.isPolling() : false,
          interval_ms: parseInt(process.env.MULTITRACK_POLL_INTERVAL || '60000', 10),
        },
      },
      database: {
        mongodb: 'Connected',
        status: 'Ready',
      },
    });
  });

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use('/api/auth',           require('./routes/auth.routes'));
  app.use('/api/vehicles',       require('./routes/vehicles.routes'));
  app.use('/api/tracking',       require('./routes/tracking.routes'));
  app.use('/api/alerts',         require('./routes/alerts.routes'));
  app.use('/api/notifications',  require('./routes/notifications.routes'));
  app.use('/api/analytics',      require('./routes/analytics.routes'));
  app.use('/api/support',        require('./routes/support.routes'));
  app.use('/api/geofences',      require('./routes/geofence.routes'));
  app.use('/api/trips',          require('./routes/trip.routes'));
  app.use('/api/referral',       require('./routes/referral.routes'));
  app.use('/api/sync',           require('./routes/sync.routes'));
  app.use('/api/web',            require('./routes/inquiry.routes'));
  app.use('/api/onboarding',     require('./routes/onboarding.routes'));


  // ── Socket events ───────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    logger.info('🔌 User connected: %s', socket.id);
    socket.on('join_fleet', (fleetId) => {
      socket.join(fleetId);
      logger.info('User %s joined fleet: %s', socket.id, fleetId);
    });
    socket.on('disconnect', () => logger.info('❌ User disconnected: %s', socket.id));
  });

  // ── Background services ─────────────────────────────────────────────────────

  // A. TCP GPS Server (GT06 hardware)
  const GPS_PORT = parseInt(process.env.GPS_TCP_PORT ?? '5002', 10);
  require('./services/gps.server').startGpsServer(GPS_PORT);

  // B. WanWay IOP GPS Poller
  wanwayPoller.start();

  // C. 4G API Poller (NEW - Production Ready)
  fourGApiPoller.start();

  // D. MultiTrack VTS Poller
  if (process.env.MULTITRACK_TOKEN) {
    multitrackPoller.start();
  } else {
    logger.warn('⚠️  MULTITRACK_TOKEN not set — MultiTrackVTS poller skipped');
  }

  // E. Nightly daily-summary cron (00:05 UTC)
  dailySummaryJob.start();

  // ── HTTP server ─────────────────────────────────────────────────────────────
  const PORT = parseInt(process.env.PORT ?? '5000', 10);
  server.listen(PORT, '0.0.0.0', () => {
    logger.info('🚀 NVIQ Fleet Server online on port %d', PORT);
    logger.info('📋 Active Data Sources:');
    logger.info('   ✅ WanWay IOP GPS (30s interval)');
    logger.info('   ✅ 4G Vehicle Wise API (60s interval)');
    logger.info('   ✅ MultiTrack VTS (60s interval)');
    logger.info('   ✅ TCP GPS Server (Port 5001)');
    logger.info('📊 Endpoints: /api/keep-alive, /api/debug/pollers, /api/debug/diagnose');
  });
}

boot().catch(err => {
  logger.error('❌ Boot Sequence Failed: %s', err.stack);
  process.exit(1);
});

