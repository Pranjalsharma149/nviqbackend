// config/db.js
'use strict';

const mongoose = require('mongoose');

const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 2000;
const IS_PROD       = process.env.NODE_ENV === 'production';

const OPTS = {
  maxPoolSize:              100,
  minPoolSize:              10,
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS:          45000,
  heartbeatFrequencyMS:     10000,
  family:                   4,          // force IPv4 — avoids Atlas IPv6 DNS issues
  autoIndex:                !IS_PROD,   // never rebuild indexes in production
  retryWrites:              true,
};

function getURI() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error(
      'MONGO_URI is not set in .env\n' +
      'Add: MONGO_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/nviq'
    );
  }
  return uri;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function registerEvents() {
  const c = mongoose.connection;
  if (c.listenerCount('connected') > 0) return;
  c.on('connected',    () => console.log(`✅ MongoDB connected → ${c.host}/${c.name}`));
  c.on('disconnected', () => console.warn('⚠️  MongoDB disconnected — reconnecting…'));
  c.on('reconnected',  () => console.log('🔄 MongoDB reconnected'));
  c.on('error',        e  => console.error('❌ MongoDB error:', e.message));
}

function registerShutdown() {
  if (registerShutdown._done) return;
  registerShutdown._done = true;
  const down = async sig => {
    console.log(`\n${sig} — closing MongoDB`);
    try { await mongoose.connection.close(false); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGTERM', () => down('SIGTERM'));
  process.on('SIGINT',  () => down('SIGINT'));
}

const connectDB = async () => {
  const uri = getURI();
  registerEvents();
  registerShutdown();

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      console.log(i === 1 ? '⏳ Connecting to MongoDB…' : `⏳ Retry ${i}/${MAX_RETRIES}…`);
      await mongoose.connect(uri, OPTS);
      console.log(`🚀 MongoDB ready (pool ${OPTS.minPoolSize}–${OPTS.maxPoolSize})`);
      return;
    } catch (e) {
      console.error(`❌ Attempt ${i}/${MAX_RETRIES}: ${e.message}`);
      if (i === MAX_RETRIES) { console.error('❌ All retries failed — exit'); process.exit(1); }
      const delay = BASE_DELAY_MS * Math.pow(2, i - 1);
      console.log(`   Retrying in ${delay / 1000}s…`);
      await sleep(delay);
    }
  }
};

module.exports = connectDB;