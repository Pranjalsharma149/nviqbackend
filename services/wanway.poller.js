'use strict';

/**
 * WANWAY IOP GPS POLLER SERVICE — v2.1
 *
 * FIXES vs v2.0:
 *   FIX-IGN-1: normalizeDevices() now extracts ignition from ALL known
 *              IOPGPS field names. The /api/device/status response uses
 *              'accStatus' (integer 0/1), not 'acc' or 'ignition'.
 *              Previous code: acc: d.acc ?? d.ignition ?? null → always null
 *              Fixed: checks accStatus, acc, ignition, io, io1, din1, etc.
 *
 *   FIX-IGN-2: gpsTime field from IOPGPS is Unix epoch in SECONDS.
 *              'locTime' is the alternative field name in some API versions.
 *              Both are now handled.
 *
 *   FIX-ODO:   odometer from IOPGPS is in km (not metres). No conversion needed.
 *              Field names checked: mileage, totalMileage, odometer, odo.
 *
 *   FIX-SAT:   Satellite count field in IOPGPS is 'satellites' or 'gpsNum'.
 *
 *   FIX-VOLT:  External voltage from IOPGPS is in tenths of a volt (e.g. 125 = 12.5V).
 *              extVoltage is divided by 10. If field is 'voltage' it's already in V.
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

    // expiresIn is in SECONDS — multiply by 1000 for ms, subtract 5min buffer
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

// ── Fetch Device Data from Wanway/IOPGPS API ──────────────────────────────────
async function fetchDeviceData() {
  try {
    const token    = await getAccessToken();
    const imeiList = getIopIMEIs();

    if (!imeiList || imeiList.length === 0) {
      logger.warn('⚠️  No IOP devices configured in config/devices.js');
      return [];
    }

    logger.info('📡 Fetching IOP GPS data for %d devices...', imeiList.length);

    // Strategy 1: Device status endpoint (returns accStatus field for ignition)
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
        // Log the RAW first device so we can see all field names
        if (response.data.data.length > 0) {
          logger.info(
            '🔍 [IOPGPS] RAW device fields: %s',
            Object.keys(response.data.data[0]).join(', ')
          );
          logger.info(
            '🔍 [IOPGPS] RAW ignition-related: accStatus=%s acc=%s ignition=%s io=%s',
            response.data.data[0].accStatus,
            response.data.data[0].acc,
            response.data.data[0].ignition,
            response.data.data[0].io
          );
        }
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

// ─────────────────────────────────────────────────────────────────────────────
// FIX-IGN-1: Parse ignition from ALL known IOPGPS field names
//
// IOPGPS /api/device/status returns ignition as:
//   accStatus  — integer: 1=ON, 0=OFF  ← PRIMARY field for IOPGPS
//   acc        — integer or boolean
//   ignition   — boolean (some API versions)
//   io         — bitmask (bit 0 = ACC/ignition)
//   io1        — direct ACC input
//   din1       — digital input 1 (ACC on Wanway GT06 protocol)
//
// Returns: true | false | null
//   null = field not present (treat as unknown, use speed-based inference)
// ─────────────────────────────────────────────────────────────────────────────
function parseIgnition(d) {
  // Priority 1: accStatus (primary IOPGPS field)
  if (d.accStatus !== undefined && d.accStatus !== null) {
    return Number(d.accStatus) === 1;
  }

  // Priority 2: acc (Wanway protocol field)
  if (d.acc !== undefined && d.acc !== null) {
    if (typeof d.acc === 'boolean') return d.acc;
    if (typeof d.acc === 'number')  return d.acc === 1;
    if (typeof d.acc === 'string')  return d.acc === '1' || d.acc.toLowerCase() === 'on';
  }

  // Priority 3: ignition
  if (d.ignition !== undefined && d.ignition !== null) {
    if (typeof d.ignition === 'boolean') return d.ignition;
    if (typeof d.ignition === 'number')  return d.ignition === 1;
    if (typeof d.ignition === 'string')  return d.ignition === '1' || d.ignition.toLowerCase() === 'on';
  }

  // Priority 4: io bitmask (bit 0 = ACC)
  if (d.io !== undefined && d.io !== null) {
    return (Number(d.io) & 1) === 1;
  }

  // Priority 5: io1 or din1 (direct digital input)
  const din = d.io1 ?? d.din1 ?? d.DIN1 ?? d.IO1;
  if (din !== undefined && din !== null) {
    return Number(din) === 1;
  }

  // Priority 6: engineStatus / engine
  if (d.engineStatus !== undefined && d.engineStatus !== null) {
    return Number(d.engineStatus) === 1;
  }

  // Not found — return null so processor can infer from speed
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeDevices — map IOPGPS raw API fields to data.processor.js schema
//
// This is the ONLY place raw IOPGPS field names are translated.
// data.processor.js receives the normalized format and never sees raw fields.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeDevices(rawDevices) {
  return rawDevices.map(d => {
    const ignition = parseIgnition(d);

    // Voltage: extVoltage is in tenths of a volt (125 → 12.5V)
    //          voltage field (if present) is already in volts
    let voltage = null;
    if (d.extVoltage != null) {
      voltage = d.extVoltage > 100 ? d.extVoltage / 10 : d.extVoltage;
    } else if (d.voltage != null) {
      voltage = Number(d.voltage);
    } else if (d.power != null) {
      voltage = d.power > 100 ? d.power / 10 : Number(d.power);
    }

    // Odometer: IOPGPS sends in km already (mileage field)
    const odometer = d.mileage ?? d.totalMileage ?? d.odometer ?? d.odo ?? null;

    return {
      // Identity
      imei: String(d.imei || d.imeino || d.deviceId || d.device_id || ''),

      // Coordinates — WGS-84 (IOPGPS converts GCJ-02 server-side)
      lat: d.lat  ?? d.latitude  ?? null,
      lng: d.lng  ?? d.longitude ?? null,

      // Motion
      speed:  parseFloat(d.speed  ?? 0),
      course: parseFloat(d.course ?? d.heading ?? d.direction ?? 0),

      // Timestamps — Unix epoch in SECONDS from IOPGPS
      gpsTime:    d.gpsTime    ?? d.locTime   ?? d.gps_time  ?? null,
      signalTime: d.signalTime ?? d.loginTime ?? d.sign_time ?? null,

      // GPS quality
      altitude:   parseFloat(d.altitude   ?? 0),
      satellites: parseInt(d.satellites   ?? d.gpsNum ?? d.satelliteNum ?? 0, 10),
      accuracy:   parseFloat(d.accuracy   ?? d.hdop   ?? 0),

      // Electrical
      extVoltage: voltage,
      odometer:   odometer != null ? parseFloat(odometer) : null,

      // FIX-IGN-1: Ignition — now properly parsed from accStatus/acc/io/etc.
      acc: ignition,

      // Address if IOPGPS provided it
      address: d.address ?? d.location ?? d.positionDesc ?? null,
    };
  });
}

// ── Single poll cycle ─────────────────────────────────────────────────────────
async function doPoll() {
  try {
    const rawDevices = await fetchDeviceData();
    if (rawDevices.length === 0) return;

    const normalized = normalizeDevices(rawDevices);

    // Log ignition state after normalization for debugging
    for (const dev of normalized) {
      logger.info(
        '🔌 [IOPGPS Normalized] IMEI=%s lat=%s lng=%s spd=%s ign=%s volt=%s sats=%s',
        dev.imei,
        dev.lat,
        dev.lng,
        dev.speed,
        dev.acc,         // null means unknown
        dev.extVoltage,
        dev.satellites
      );
    }

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

  await doPoll();
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