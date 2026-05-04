'use strict';

/**
 * WANWAY IOP GPS POLLER SERVICE
 * 
 * Fetches device positions from Wanway/IOPGPS API every 30 seconds.
 * All data is forwarded to processBulkUpdates() in data.processor.js
 * so ALL validation, conversion, and DB writes happen in ONE place.
 */

const axios  = require('axios');
const crypto = require('crypto');
const { getIopIMEIs } = require('../config/devices');
const logger = require('../utils/logger');
const { processBulkUpdates } = require('./data.processor');

// ── Configuration ─────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:              process.env.WANWAY_API_BASE || 'https://open.iopgps.com',
  appId:                process.env.WANWAY_APPID,
  secret:               process.env.WANWAY_SECRET,
  pollInterval:         parseInt(process.env.WANWAY_POLL_INTERVAL || '30000', 10),
  timeout:              15000,
  maxConsecutiveErrors: 5,
  backoffDelay:         5 * 60 * 1000,
};

// ── State ─────────────────────────────────────────────────────────────────────
let accessToken       = null;
let tokenExpiry       = 0;
let isPolling         = false;
let consecutiveErrors = 0;
let pollingInterval   = null;

// ── Utilities ─────────────────────────────────────────────────────────────────
function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function validateConfig() {
  if (!CONFIG.appId || !CONFIG.secret) {
    logger.error('❌ Missing WANWAY_APPID or WANWAY_SECRET in .env');
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Token Management ──────────────────────────────────────────────────────────
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken;
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = md5(md5(CONFIG.secret) + timestamp);

    logger.info('🔑 Generating IOP GPS API token...');

    const response = await axios.post(
      `${CONFIG.baseUrl}/api/auth`,
      { appid: CONFIG.appId, time: timestamp, signature },
      { headers: { 'Content-Type': 'application/json' }, timeout: CONFIG.timeout }
    );

    if (response.data?.code !== 0) {
      throw new Error(`Auth failed: ${response.data?.message || 'Unknown error'}`);
    }

    accessToken = response.data.accessToken;

    // FIX: Wanway sends expiresIn in SECONDS not milliseconds.
    // Original code: Date.now() + (expiresIn || 7200000)
    // If expiresIn=7200 (seconds), that's only 7.2 seconds from now — always expired.
    // Fix: multiply by 1000 to convert seconds → ms, subtract 5min buffer.
    const expiresInMs = (response.data.expiresIn || 7200) * 1000;
    tokenExpiry = Date.now() + expiresInMs - (5 * 60 * 1000);

    logger.info(
      '✅ Token acquired, expires: %s (in %d min)',
      new Date(tokenExpiry).toISOString(),
      Math.round(expiresInMs / 60000)
    );

    consecutiveErrors = 0;
    return accessToken;

  } catch (error) {
    logger.error('❌ Token generation failed: %s', error.message);
    consecutiveErrors++;
    throw error;
  }
}

// ── Fetch Device Data from Wanway API ─────────────────────────────────────────
// Returns raw API response array — NO processing done here.
// All normalization happens in data.processor.js
async function fetchDeviceData() {
  try {
    const token    = await getAccessToken();
    const imeiList = getIopIMEIs();

    if (!imeiList || imeiList.length === 0) {
      logger.warn('⚠️  No IOP devices configured in config/devices.js');
      return [];
    }

    logger.info('📡 Fetching IOP GPS data for %d devices...', imeiList.length);

    // Strategy 1: Device status endpoint
    try {
      const response = await axios.get(
        `${CONFIG.baseUrl}/api/device/status`,
        {
          params:  { accessToken: token },
          headers: { 'Content-Type': 'application/json' },
          timeout: CONFIG.timeout,
        }
      );

      if (
        response.data?.code === 0 &&
        Array.isArray(response.data.data) &&
        response.data.data.length > 0
      ) {
        logger.info('✅ Strategy 1 success: %d devices', response.data.data.length);
        consecutiveErrors = 0;
        return response.data.data;
      }
    } catch (e) {
      logger.warn('⚠️  Strategy 1 failed: %s', e.message);
    }

    // Strategy 2: Vehicle location endpoint
    try {
      const response = await axios.get(
        `${CONFIG.baseUrl}/api/vehicle/location`,
        {
          params:  { accessToken: token },
          headers: { 'Content-Type': 'application/json' },
          timeout: CONFIG.timeout,
        }
      );

      if (
        response.data?.code === 0 &&
        response.data?.data?.list?.length > 0
      ) {
        logger.info('✅ Strategy 2 success: %d vehicles', response.data.data.list.length);
        consecutiveErrors = 0;
        return response.data.data.list;
      }
    } catch (e) {
      logger.warn('⚠️  Strategy 2 failed: %s', e.message);
    }

    // Strategy 3: Per-IMEI device location
    const results = [];
    for (const imei of imeiList) {
      try {
        const response = await axios.get(
          `${CONFIG.baseUrl}/api/device/location`,
          {
            params:  { accessToken: token, imei },
            headers: { 'Content-Type': 'application/json' },
            timeout: CONFIG.timeout,
          }
        );
        if (response.data?.code === 0 && response.data?.data) {
          results.push(response.data.data);
        }
      } catch (err) {
        logger.warn('⚠️  Strategy 3 failed for IMEI %s: %s', imei, err.message);
      }
    }

    if (results.length > 0) {
      logger.info('✅ Strategy 3 success: %d devices', results.length);
      consecutiveErrors = 0;
      return results;
    }

    logger.warn('⚠️  All API strategies failed — devices may be offline');
    consecutiveErrors++;
    return [];

  } catch (error) {
    consecutiveErrors++;
    logger.error('❌ fetchDeviceData error: %s', error.message);

    if (consecutiveErrors >= CONFIG.maxConsecutiveErrors) {
      logger.warn('⚠️  Too many errors — backing off for 5 minutes');
      await sleep(CONFIG.backoffDelay);
      consecutiveErrors = 0;
    }

    return [];
  }
}

// ── Normalize raw Wanway API response into processBulkUpdates format ──────────
// This is the ONLY transformation done in the poller.
// Field mapping: Wanway API field names → data.processor.js expected names.
function normalizeDevices(rawDevices) {
  return rawDevices.map(d => ({
    // Identity
    imei: String(d.imei || d.imeino || d.deviceId || ''),

    // Coordinates — raw GCJ-02, conversion done in data.processor.js
    lat: d.lat  ?? d.latitude  ?? null,
    lng: d.lng  ?? d.longitude ?? null,

    // Motion
    speed:   parseFloat(d.speed   ?? 0),
    course:  parseFloat(d.course  ?? d.heading ?? 0),

    // Timestamps — data.processor.js handles staleness validation
    // gpsTime from Wanway is Unix epoch in SECONDS
    gpsTime:    d.gpsTime    ?? d.locTime   ?? null,
    signalTime: d.signalTime ?? d.loginTime ?? null,

    // Vehicle info
    altitude:   d.altitude   ?? 0,
    satellites: d.satellites ?? d.gpsNum ?? 0,
    accuracy:   d.accuracy   ?? d.hdop   ?? 0,
    extVoltage: d.extVoltage ?? d.voltage ?? null,
    odometer:   d.odometer   ?? d.mileage ?? null,

    // Ignition / ACC
    acc: d.acc ?? d.ignition ?? null,

    // Address if Wanway provided it
    address: d.address ?? d.location ?? null,
  }));
}

// ── Single poll cycle ─────────────────────────────────────────────────────────
async function doPoll() {
  try {
    const rawDevices = await fetchDeviceData();
    if (rawDevices.length === 0) return;

    // Normalize field names then hand off to data.processor.js
    // which handles: GCJ02→WGS84, GPS age check, spike detection,
    // DB write, socket emit, location ping, trip detection.
    const normalized = normalizeDevices(rawDevices);
    await processBulkUpdates(normalized);

  } catch (err) {
    logger.error('❌ Poll cycle error: %s', err.message);
  }
}

// ── Polling Loop ──────────────────────────────────────────────────────────────
async function startPolling() {
  if (isPolling) {
    logger.warn('⚠️  Poller already running');
    return;
  }

  if (!validateConfig()) {
    logger.error('❌ Configuration validation failed — poller not started');
    return;
  }

  isPolling = true;
  logger.info(
    '🚀 Wanway IOP GPS Poller started (Interval: %dms)',
    CONFIG.pollInterval
  );

  // Run immediately on start
  await doPoll();

  // Then on interval
  pollingInterval = setInterval(doPoll, CONFIG.pollInterval);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  isPolling = false;
  logger.info('⏹️  Wanway IOP GPS Poller stopped');
}

module.exports = {
  start:     startPolling,
  stop:      stopPolling,
  isPolling: () => isPolling,
};