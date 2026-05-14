'use strict';

/**
 * MULTITRACK VTS POLLER SERVICE (UPDATED)
 *
 * Fetches live vehicle positions from MultiTrackVTS API every 60 seconds.
 * Normalizes data into the SAME format as wanway.poller.js and forwards
 * to both:
 *   1. saveRawBatch() in rawGps.service.js  → RawGpsLog (audit trail)
 *   2. processBulkUpdates() in data.processor.js → vehicle updates + socket emit
 *
 * ⚠️  wanway.poller.js is NOT touched. Both run in parallel.
 * ⚠️  Minimum poll interval is 60s (MultiTrackVTS platform enforces this).
 *
 * Identity note:
 *   MultiTrackVTS identifies vehicles by `vehicleNumber` (chassis number),
 *   NOT by IMEI. We store the chassis number as the `imei` field in devices.js
 *   so it flows through data.processor.js without any schema changes.
 */

const axios  = require('axios');
const https  = require('https');
const logger = require('../utils/logger');
const { processBulkUpdates }   = require('./data.processor');
const { saveRawBatch }         = require('./rawGps.service');  // ← NEW
const { getMultitrackDevices } = require('../config/devices');

// ── Configuration ─────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:      'https://app1.multitrackvts.com:8087',
  token:        process.env.MULTITRACK_TOKEN,

  // ⚠️  Do NOT go below 60000 — MultiTrackVTS enforces 1 min minimum
  pollInterval: parseInt(process.env.MULTITRACK_POLL_INTERVAL || '60000', 10),
  timeout:      15000,

  maxConsecutiveErrors: 5,
  backoffDelay:         5 * 60 * 1000, // 5 minutes
};

// Reusable HTTPS agent (accepts self-signed certs on MultiTrackVTS server)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ── State ─────────────────────────────────────────────────────────────────────
let isPolling         = false;
let pollingInterval   = null;
let consecutiveErrors = 0;

// ── Utilities ─────────────────────────────────────────────────────────────────
function validateConfig() {
  if (!CONFIG.token) {
    logger.error('❌ [MultiTrack] Missing MULTITRACK_TOKEN in .env');
    return false;
  }

  const devices = getMultitrackDevices();
  if (!devices || devices.length === 0) {
    logger.warn('⚠️  [MultiTrack] No MULTITRACK devices found in config/devices.js');
  } else {
    logger.info(
      '📋 [MultiTrack] %d registered device(s): %s',
      devices.length,
      devices.map(d => `${d.vehicleReg} (chassis: ${d.imei})`).join(', ')
    );
  }

  return true;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Fetch Positions from MultiTrackVTS ────────────────────────────────────────
async function fetchPositions() {
  try {
    logger.info('📡 [MultiTrack] Fetching live positions...');

    const response = await axios.get(`${CONFIG.baseUrl}/positionsByToken`, {
      params:     { token: CONFIG.token },
      timeout:    CONFIG.timeout,
      httpsAgent,
    });

    if (!Array.isArray(response.data)) {
      logger.warn('⚠️  [MultiTrack] Unexpected response format: %j', response.data);
      consecutiveErrors++;
      return [];
    }

    logger.info('✅ [MultiTrack] Received %d vehicle(s) from platform', response.data.length);
    
    // 🔍 DEBUG: Log raw API response for each vehicle
    response.data.forEach(vehicle => {
      logger.info('🔍 [MultiTrack] RAW API RESPONSE: vehicleNumber=%s | lat=%s | long=%s | power=%s | ignition=%s',
        vehicle.vehicleNumber,
        vehicle.lat,
        vehicle.long,
        vehicle.power,
        vehicle.ignition
      );
    });
    
    consecutiveErrors = 0;
    return response.data;

  } catch (error) {
    consecutiveErrors++;
    logger.error(
      '❌ [MultiTrack] Fetch error (%d/%d): %s',
      consecutiveErrors, CONFIG.maxConsecutiveErrors, error.message
    );

    if (consecutiveErrors >= CONFIG.maxConsecutiveErrors) {
      logger.warn('⚠️  [MultiTrack] Too many errors — backing off for 5 minutes');
      await sleep(CONFIG.backoffDelay);
      consecutiveErrors = 0;
    }

    return [];
  }
}

// ── Filter: only process vehicles registered in devices.js ───────────────────
// MultiTrackVTS returns ALL vehicles under the account token.
// We filter to only the chassis numbers we have registered.
function filterKnownVehicles(rawDevices) {
  const registeredDevices = getMultitrackDevices();
  const knownChassis = new Set(
    registeredDevices.map(d => String(d.imei).toUpperCase())
  );

  const known   = [];
  const unknown = [];

  rawDevices.forEach(v => {
    const chassis = String(v.vehicleNumber || '').toUpperCase();
    if (knownChassis.has(chassis)) {
      known.push(v);
    } else {
      unknown.push(v.vehicleNumber);
    }
  });

  if (unknown.length > 0) {
    logger.debug(
      '⏭️  [MultiTrack] Skipping unregistered vehicles: %s',
      unknown.join(', ')
    );
  }

  logger.info(
    '✅ [MultiTrack] Processing %d/%d known vehicle(s)',
    known.length, rawDevices.length
  );

  return known;
}

// ── Normalize MultiTrackVTS response → common schema ───────────────────────────
//
// MultiTrackVTS field   →   processor.js expected field
// ─────────────────────────────────────────────────────────
// vehicleNumber         →   imei       (chassis no. = unique device ID)
// lat                   →   lat
// long                  →   lng
// speed                 →   speed
// direction             →   course
// last_updated (ISO)    →   gpsTime    (converted → Unix seconds)
// ignition (bool)       →   acc        (1 = on, 0 = off)
// power (float, volts)  →   extVoltage
// odometer1 (float, km) →   odometer
//
function normalizeDevices(rawDevices) {
  return rawDevices.map(d => {
    // ISO timestamp → Unix epoch seconds (same format Wanway uses)
    let gpsTime = null;
    if (d.last_updated) {
      gpsTime = Math.floor(new Date(d.last_updated).getTime() / 1000);
    }

    return {
      // Identity — chassis number stored as imei key in devices.js
      imei: String(d.vehicleNumber || ''),

      // Coordinates — MultiTrackVTS is WGS84 (no GCJ02→WGS84 conversion needed)
      lat: d.lat  ?? null,
      lng: d.long ?? null,  // MultiTrack uses "long" not "lng"

      // Motion
      speed:  parseFloat(d.speed     ?? 0),
      course: parseFloat(d.direction ?? 0),

      // Timestamps
      gpsTime:    gpsTime,
      signalTime: gpsTime,  // MultiTrack provides only one timestamp

      // Hardware info (not provided by MultiTrackVTS)
      altitude:   0,
      satellites: 0,
      accuracy:   0,

      // Power / fuel
      extVoltage: d.power     ?? null,  // e.g. 12.5V
      odometer:   d.odometer1 ?? null,  // km

      // Ignition: bool → 0/1 (same convention as Wanway)
      acc: d.ignition ? 1 : 0,

      // Address: not provided, processor will reverse-geocode if configured
      address: null,

      // Informational only — not used by data.processor.js
      _source: 'multitrack',
      _charge: d.charge ?? null,  // AIS 140 battery charging flag
    };
  });
}

// ── Single poll cycle ─────────────────────────────────────────────────────────
async function doPoll() {
  try {
    // 1. Fetch all vehicles from MultiTrackVTS
    const rawDevices = await fetchPositions();
    if (rawDevices.length === 0) return;

    // 2. Keep only vehicles registered in devices.js
    const knownDevices = filterKnownVehicles(rawDevices);
    if (knownDevices.length === 0) {
      logger.warn('⚠️  [MultiTrack] No registered vehicles in API response this cycle');
      return;
    }

    // 3. Normalize to common schema
    const normalized = normalizeDevices(knownDevices);

    // 4. NEW: Persist raw GPS logs (non-blocking, doesn't block real-time updates)
    // This creates an audit trail and enables trip playback
    saveRawBatch(normalized, 'multitrack').catch(err => {
      logger.error('❌ [MultiTrack] Raw GPS batch save failed: %s', err.message);
    });

    // 5. Hand off to the processor for real-time updates
    //    → DB write, Socket.IO emit, trip detection, alerts all happen here
    await processBulkUpdates(normalized, 'multitrack');

  } catch (err) {
    logger.error('❌ [MultiTrack] Poll cycle error: %s', err.message);
  }
}

// ── Polling Loop ──────────────────────────────────────────────────────────────
async function startPolling() {
  if (isPolling) {
    logger.warn('⚠️  [MultiTrack] Poller already running');
    return;
  }

  if (!validateConfig()) {
    logger.error('❌ [MultiTrack] Config invalid — poller not started');
    return;
  }

  isPolling = true;
  logger.info(
    '🚀 [MultiTrack] VTS Poller started (Interval: %dms, Devices: %d)',
    CONFIG.pollInterval,
    getMultitrackDevices().length
  );

  // Run immediately on start, then repeat on interval
  await doPoll();
  pollingInterval = setInterval(doPoll, CONFIG.pollInterval);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  isPolling = false;
  logger.info('⏹️  [MultiTrack] Poller stopped');
}

module.exports = {
  start:     startPolling,
  stop:      stopPolling,
  isPolling: () => isPolling,
};