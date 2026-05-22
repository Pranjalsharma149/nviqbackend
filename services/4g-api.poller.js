'use strict';

/**
 * services/4g-api.poller.js - FINAL PRODUCTION VERSION
 * 
 * Polls 4G API (Vehicle Wise & Company Wise)
 * Based on your setup: http://192.168.10.1/webservice
 * Company: Telematics | Project: 37
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { processBulkUpdates } = require('./data.processor');

// ── CONFIG FROM .env ──────────────────────────────────────────────────────────
const CONFIG = {
  enabled:      process.env['4G_API_ENABLED'] === 'true',
  baseUrl:      process.env['4G_API_BASE_URL'],
  username:     process.env['4G_API_USERNAME'],
  password:     process.env['4G_API_PASSWORD'],
  projectId:    process.env['4G_API_PROJECT_ID'],
  companyName:  process.env['4G_API_COMPANY_NAME'],
  pollInterval: parseInt(process.env['4G_API_POLL_INTERVAL'], 10),
  timeout:      12000,  // 12 second timeout
};

// ── STATE ─────────────────────────────────────────────────────────────────────
let accessToken = null;
let tokenExpiry = 0;
let isPolling = false;
let pollingInterval = null;
let pollCount = 0;
let lastError = null;
let lastSuccess = null;

// ── VALIDATE CONFIG ───────────────────────────────────────────────────────────
function validateConfig() {
  if (!CONFIG.enabled) {
    return false;
  }

  if (!CONFIG.baseUrl || !CONFIG.username || !CONFIG.password || !CONFIG.projectId) {
    logger.error('❌ [4G API] Missing configuration in .env');
    logger.error('   Required: 4G_API_BASE_URL, 4G_API_USERNAME, 4G_API_PASSWORD, 4G_API_PROJECT_ID');
    return false;
  }

  logger.info('✅ [4G API] Config validated');
  logger.info('   URL: %s', CONFIG.baseUrl);
  logger.info('   Company: %s', CONFIG.companyName);
  logger.info('   Project: %s', CONFIG.projectId);
  logger.info('   Poll interval: %dms', CONFIG.pollInterval);

  return true;
}

// ── STEP 1: GENERATE TOKEN ────────────────────────────────────────────────────
async function generateToken() {
  // Return cached token if still valid
  if (accessToken && Date.now() < tokenExpiry) {
    logger.debug('[4G API] Using cached token (valid for %dms)', tokenExpiry - Date.now());
    return accessToken;
  }

  try {
    logger.info('🔑 [4G API] Generating access token...');

    const response = await axios.post(
      `${CONFIG.baseUrl}?token=generateAccessToken`,
      {
        username: CONFIG.username,
        password: CONFIG.password,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: CONFIG.timeout,
      }
    );

    // Check response structure
    if (!response.data?.result || response.data.result !== 1) {
      throw new Error('API returned result !== 1');
    }

    if (!response.data?.data?.token) {
      throw new Error('No token in API response');
    }

    accessToken = response.data.data.token;
    // Token valid for 30 min, cache until 25 min
    tokenExpiry = Date.now() + (25 * 60 * 1000);

    logger.info('✅ [4G API] Token generated successfully');
    logger.debug('   Token length: %d chars', accessToken.length);
    logger.debug('   Valid until: %s', new Date(tokenExpiry).toISOString());

    return accessToken;

  } catch (error) {
    lastError = error.message;
    logger.error('❌ [4G API] Token generation failed: %s', error.message);

    if (error.code === 'ECONNREFUSED') {
      logger.warn('⚠️  Server refused connection. Check 4G_API_BASE_URL and network connectivity');
    } else if (error.code === 'ENOTFOUND') {
      logger.warn('⚠️  Server not found. Check 4G_API_BASE_URL');
    } else if (error.message.includes('timeout')) {
      logger.warn('⚠️  Request timeout. Server may be slow or unreachable');
    }

    throw error;
  }
}

// ── STEP 2: GET LIVE DATA ─────────────────────────────────────────────────────
async function fetchVehicleData(token) {
  try {
    logger.debug('📡 [4G API] Fetching live data (company: %s)...', CONFIG.companyName);

    const response = await axios.post(
      `${CONFIG.baseUrl}?token=getTokenBaseLiveData&ProjectId=${CONFIG.projectId}`,
      {
        company_names: CONFIG.companyName,
        format: 'json',
      },
      {
        headers: {
          'auth-code': token,
          'Content-Type': 'application/json',
        },
        timeout: CONFIG.timeout,
      }
    );

    // Validate response
    if (!response.data?.root?.VehicleData) {
      logger.warn('⚠️  [4G API] No VehicleData in response');
      return [];
    }

    if (!Array.isArray(response.data.root.VehicleData)) {
      logger.error('❌ [4G API] VehicleData is not an array');
      return [];
    }

    const vehicles = response.data.root.VehicleData;
    logger.info('✅ [4G API] Fetched %d vehicle(s)', vehicles.length);

    return vehicles;

  } catch (error) {
    lastError = error.message;
    logger.error('❌ [4G API] Fetch failed: %s', error.message);
    throw error;
  }
}

// ── NORMALIZE 4G API DATA ─────────────────────────────────────────────────────
function normalizeVehicles(apiVehicles) {
  return apiVehicles.map(v => {
    // Parse ignition
    let ignition = null;
    if (v.IGN && v.IGN !== '--' && v.IGN !== null) {
      ignition = v.IGN === '1' || v.IGN === 'ON' || v.IGN === true;
    }

    // Parse coordinates
    const lat = v.Latitude ? parseFloat(v.Latitude) : null;
    const lng = v.Longitude ? parseFloat(v.Longitude) : null;

    if (!lat || !lng) {
      logger.warn('[4G API] Invalid coordinates for %s: lat=%s lng=%s', v.Imeino, lat, lng);
    }

    // Parse motion
    const speed = v.Speed ? parseFloat(v.Speed) : 0;
    const heading = v.Angle ? parseFloat(v.Angle) : 0;

    // Parse timestamps
    let gpsTime = null;
    let signalTime = null;

    if (v.GPSActualTime) {
      try {
        const [datePart, timePart] = v.GPSActualTime.split(' ');
        const [d, m, y] = datePart.split('-');
        const dt = new Date(`${y}-${m}-${d}T${timePart}Z`);
        gpsTime = Math.floor(dt.getTime() / 1000);
      } catch (e) {
        logger.debug('[4G API] Could not parse GPS time: %s', v.GPSActualTime);
      }
    }

    if (v.Datetime) {
      try {
        const [datePart, timePart] = v.Datetime.split(' ');
        const [d, m, y] = datePart.split('-');
        const dt = new Date(`${y}-${m}-${d}T${timePart}Z`);
        signalTime = Math.floor(dt.getTime() / 1000);
      } catch (e) {
        logger.debug('[4G API] Could not parse server time: %s', v.Datetime);
      }
    }

    // Parse other data
    const satellites = v.satellite_count ? parseInt(v.satellite_count, 10) : 0;
    const voltage = v.ExternalVolt ? parseFloat(v.ExternalVolt) : null;
    const odometer = v.Odometer ? parseFloat(v.Odometer) : null;

    return {
      imei: String(v.Imeino || ''),
      vehicleNumber: v.Vehicle_No || v.Vehicle_Name || '',
      lat,
      lng,
      speed,
      course: heading,
      gpsTime,
      signalTime,
      altitude: 0,
      satellites,
      accuracy: 0,
      extVoltage: voltage,
      odometer,
      acc: ignition,
      address: v.Location || null,
      status: v.Status || null,
    };
  });
}

// ── MAIN POLL FUNCTION ────────────────────────────────────────────────────────
async function doPoll() {
  pollCount++;

  try {
    logger.debug('[4G API] Poll #%d starting...', pollCount);

    // Get token
    const token = await generateToken();

    // Fetch data
    const apiVehicles = await fetchVehicleData(token);

    if (apiVehicles.length === 0) {
      logger.info('⚠️  [4G API] No vehicles in API response');
      return;
    }

    // Normalize
    const normalized = normalizeVehicles(apiVehicles);

    if (normalized.length === 0) {
      logger.warn('⚠️  [4G API] Normalization resulted in 0 vehicles');
      return;
    }

    // Log sample
    if (normalized.length > 0) {
      const first = normalized[0];
      logger.info(
        '📍 [4G API] Sample: IMEI=%s | lat=%.6f lng=%.6f | spd=%dkm/h | status=%s',
        first.imei,
        first.lat || 0,
        first.lng || 0,
        first.speed,
        first.status
      );
    }

    // Process through pipeline
    await processBulkUpdates(normalized, '4g-api');

    lastSuccess = new Date();
    logger.info('✅ [4G API] Poll #%d successful (%d vehicles)', pollCount, normalized.length);

  } catch (error) {
    logger.error('❌ [4G API] Poll #%d failed: %s', pollCount, error.message);
  }
}

// ── START POLLING ─────────────────────────────────────────────────────────────
async function startPolling() {
  if (isPolling) {
    logger.warn('⚠️  [4G API] Poller already running');
    return;
  }

  if (!validateConfig()) {
    logger.warn('⚠️  [4G API] Poller disabled (missing config or 4G_API_ENABLED != true)');
    return;
  }

  isPolling = true;

  logger.info('🚀 [4G API] POLLER STARTING');
  logger.info('   Server: %s', CONFIG.baseUrl);
  logger.info('   Company: %s | Project: %s', CONFIG.companyName, CONFIG.projectId);
  logger.info('   Poll interval: %dms (%d seconds)', CONFIG.pollInterval, CONFIG.pollInterval / 1000);
  logger.info('   Timeout: %dms', CONFIG.timeout);

  // First poll after 1 second
  setTimeout(() => {
    doPoll().catch(err => logger.error('[4G API] Initial poll error: %s', err.message));
  }, 1000);

  // Then poll at interval
  pollingInterval = setInterval(() => {
    doPoll().catch(err => logger.error('[4G API] Poll error: %s', err.message));
  }, CONFIG.pollInterval);

  logger.info('✅ [4G API] Poller started and running');
}

// ── STOP POLLING ──────────────────────────────────────────────────────────────
function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  isPolling = false;
  logger.info('⏹️  [4G API] Poller stopped');
}

// ── GET STATUS ────────────────────────────────────────────────────────────────
function getStatus() {
  return {
    enabled: CONFIG.enabled,
    running: isPolling,
    server: CONFIG.baseUrl,
    company: CONFIG.companyName,
    interval_ms: CONFIG.pollInterval,
    poll_count: pollCount,
    last_success: lastSuccess ? lastSuccess.toISOString() : null,
    last_error: lastError,
    token_expires: tokenExpiry ? new Date(tokenExpiry).toISOString() : null,
  };
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
module.exports = {
  start: startPolling,
  stop: stopPolling,
  isPolling: () => isPolling,
  getStatus,
};