'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger'); // Assuming you use the logger from server.js

const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 2000;
const IS_PROD       = process.env.NODE_ENV === 'production';

/**
 * Advanced MongoDB Configuration
 * Optimized for high-concurrency (20k devices)
 */
const OPTS = {
  maxPoolSize:             100,  // Allows up to 100 concurrent socket connections
  minPoolSize:             10,   // Keeps 10 connections "warm" at all times
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS:          45000,
  heartbeatFrequencyMS:     10000,
  family:                   4,    // Force IPv4 to avoid common Atlas DNS resolution lag
  autoIndex:                !IS_PROD, // Performance: Disable index auto-build in production
  retryWrites:              true,
};

/**
 * Validate and retrieve URI
 */
function getURI() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error(
      '❌ CONFIG ERROR: MONGO_URI is not set in .env'
    );
  }
  return uri;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Global Connection Listeners
 */
function registerEvents() {
  const c = mongoose.connection;
  
  // Prevent duplicate listeners on re-run
  if (c.listenerCount('connected') > 0) return;

  c.on('connected',    () => console.log(`✅ MongoDB connected → ${c.host}/${c.name}`));
  c.on('disconnected', () => console.warn('⚠️ MongoDB disconnected — reconnecting…'));
  c.on('reconnected',  () => console.log('🔄 MongoDB reconnected'));
  c.on('error',        e  => console.error('❌ MongoDB error:', e.message));
}

/**
 * Graceful Shutdown Handling
 */
function registerShutdown() {
  if (registerShutdown._done) return;
  registerShutdown._done = true;

  const handleShutdown = async (signal) => {
    console.log(`\n${signal} received. Closing MongoDB connection...`);
    try {
      await mongoose.connection.close(false);
      console.log('MongoDB connection closed gracefully.');
      process.exit(0);
    } catch (err) {
      console.error('Error during MongoDB shutdown:', err.message);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT',  () => handleShutdown('SIGINT'));
}

/**
 * Main Database Connection Logic with Exponential Backoff
 */
const connectDB = async () => {
  const uri = getURI();
  registerEvents();
  registerShutdown();

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      if (i === 1) {
        console.log('⏳ Connecting to MongoDB…');
      } else {
        console.log(`⏳ Connection Retry ${i}/${MAX_RETRIES}…`);
      }

      await mongoose.connect(uri, OPTS);
      
      // Verification of Pool Config
      console.log(`🚀 MongoDB ready (Pool Size: ${OPTS.minPoolSize}-${OPTS.maxPoolSize})`);
      return;

    } catch (e) {
      console.error(`❌ Attempt ${i}/${MAX_RETRIES} failed: ${e.message}`);
      
      if (i === MAX_RETRIES) {
        console.error('❌ Critical: All MongoDB connection retries failed. Exiting.');
        process.exit(1);
      }

      // Exponential Backoff: 2s, 4s, 8s, 16s...
      const delay = BASE_DELAY_MS * Math.pow(2, i - 1);
      console.log(`   Retrying in ${delay / 1000} seconds…`);
      await sleep(delay);
    }
  }
};

module.exports = connectDB;