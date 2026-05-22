'use strict';

/**
 * services/diagnostic.js
 * 
 * Diagnostic service to test data flow from WanWay API to MongoDB
 * Called via: GET /api/debug/diagnose
 */

const axios = require('axios');
const crypto = require('crypto');
const Vehicle = require('../models/Vehicle');
const LocationPing = require('../models/LocationPing');
const RawGpsLog = require('../models/RawGpsLog');
const logger = require('../utils/logger');
const { processIncomingData } = require('./data.processor');

async function runDiagnostics() {
  const report = {
    timestamp: new Date().toISOString(),
    checks: {},
    errors: [],
  };

  try {
    // ──────────────────────────────────────────────────────────────────────
    // CHECK 1: MongoDB Connection
    // ──────────────────────────────────────────────────────────────────────
    logger.info('✓ CHECK 1: MongoDB Connection');
    try {
      const vehicleCount = await Vehicle.countDocuments();
      const pingCount = await LocationPing.countDocuments();
      const logCount = await RawGpsLog.countDocuments();

      report.checks.mongodb = {
        status: 'ok',
        vehicleCount,
        locationPingCount: pingCount,
        rawGpsLogCount: logCount,
        message: 'MongoDB connection successful ✅',
      };
      logger.info('  ✅ MongoDB OK | Vehicles: %d | Pings: %d | Logs: %d', vehicleCount, pingCount, logCount);
    } catch (err) {
      report.errors.push('MongoDB connection failed: ' + err.message);
      report.checks.mongodb = { status: 'error', error: err.message };
      logger.error('  ❌ MongoDB failed: %s', err.message);
      return report;
    }

    // ──────────────────────────────────────────────────────────────────────
    // CHECK 2: WanWay Configuration
    // ──────────────────────────────────────────────────────────────────────
    logger.info('✓ CHECK 2: WanWay Configuration');
    const appId = process.env.WANWAY_APPID;
    const secret = process.env.WANWAY_SECRET;

    if (!appId || !secret) {
      report.errors.push('Missing WANWAY_APPID or WANWAY_SECRET in .env');
      report.checks.wanwayConfig = { status: 'error', message: 'Missing credentials' };
      logger.error('  ❌ Missing WanWay credentials');
      return report;
    }

    report.checks.wanwayConfig = {
      status: 'ok',
      hasAppId: !!appId,
      hasSecret: !!secret,
      message: 'WanWay credentials present ✅',
    };
    logger.info('  ✅ WanWay config OK');

    // ──────────────────────────────────────────────────────────────────────
    // CHECK 3: WanWay Token Generation
    // ──────────────────────────────────────────────────────────────────────
    logger.info('✓ CHECK 3: WanWay Token Generation');
    let token;
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const md5Hash = crypto.createHash('md5').update(secret).digest('hex');
      const signature = crypto.createHash('md5').update(md5Hash + timestamp).digest('hex');

      const tokenResponse = await axios.post(
        'https://open.iopgps.com/api/auth',
        { appid: appId, time: timestamp, signature },
        { timeout: 15000 }
      );

      if (tokenResponse.data.code !== 0) {
        throw new Error(`Auth failed: ${tokenResponse.data.message}`);
      }

      token = tokenResponse.data.accessToken;
      report.checks.wanwayToken = {
        status: 'ok',
        message: 'Token generated successfully ✅',
        expiresIn: tokenResponse.data.expiresIn,
      };
      logger.info('  ✅ Token generation OK (expires in %d seconds)', tokenResponse.data.expiresIn);
    } catch (err) {
      report.errors.push('Token generation failed: ' + err.message);
      report.checks.wanwayToken = { status: 'error', error: err.message };
      logger.error('  ❌ Token generation failed: %s', err.message);
      return report;
    }

    // ──────────────────────────────────────────────────────────────────────
    // CHECK 4: Fetch GPS Data from WanWay
    // ──────────────────────────────────────────────────────────────────────
    logger.info('✓ CHECK 4: Fetch GPS Data from WanWay');
    let rawData = [];
    try {
      const response = await axios.get(
        'https://open.iopgps.com/api/device/status',
        {
          params: { accessToken: token },
          timeout: 15000,
        }
      );

      if (response.data.code !== 0) {
        throw new Error(`API error: ${response.data.message}`);
      }

      rawData = response.data.data || [];
      report.checks.wanwayFetch = {
        status: 'ok',
        deviceCount: rawData.length,
        message: `Fetched ${rawData.length} devices from WanWay ✅`,
      };

      if (rawData.length > 0) {
        logger.info('  ✅ Fetched %d devices from WanWay', rawData.length);
        logger.info('  📊 Sample device fields: %s', Object.keys(rawData[0]).join(', '));
        logger.info('  📊 First device IMEI: %s', rawData[0].imei || rawData[0].imeino);
      } else {
        logger.warn('  ⚠️  No devices returned from WanWay API');
      }
    } catch (err) {
      report.errors.push('WanWay fetch failed: ' + err.message);
      report.checks.wanwayFetch = { status: 'error', error: err.message };
      logger.error('  ❌ WanWay fetch failed: %s', err.message);
      return report;
    }

    // ──────────────────────────────────────────────────────────────────────
    // CHECK 5: Process Sample Data
    // ──────────────────────────────────────────────────────────────────────
    logger.info('✓ CHECK 5: Process Sample Data');
    if (rawData.length === 0) {
      report.checks.dataProcessing = {
        status: 'skipped',
        reason: 'No devices to process',
      };
      logger.warn('  ⚠️  No data to process');
    } else {
      try {
        const firstDevice = rawData[0];
        logger.info('  Processing device: IMEI=%s', firstDevice.imei || firstDevice.imeino);

        await processIncomingData(
          {
            imei: String(firstDevice.imei || firstDevice.imeino || ''),
            latitude: firstDevice.lat || firstDevice.latitude,
            longitude: firstDevice.lng || firstDevice.longitude,
            speed: parseFloat(firstDevice.speed || 0),
            heading: parseFloat(firstDevice.course || firstDevice.heading || 0),
            satellites: parseInt(firstDevice.satellites || 0, 10),
            accuracy: parseFloat(firstDevice.accuracy || 0),
            gpsTimestamp: firstDevice.gpsTime ? new Date(firstDevice.gpsTime * 1000) : null,
            ignition: firstDevice.acc,
          },
          'diagnostic'
        );

        report.checks.dataProcessing = {
          status: 'ok',
          message: 'Data processed successfully ✅',
        };
        logger.info('  ✅ Data processing OK');
      } catch (err) {
        report.errors.push('Data processing failed: ' + err.message);
        report.checks.dataProcessing = { status: 'error', error: err.message };
        logger.error('  ❌ Data processing failed: %s', err.message);
      }
    }

    // ──────────────────────────────────────────────────────────────────────
    // CHECK 6: Verify Data in MongoDB
    // ──────────────────────────────────────────────────────────────────────
    logger.info('✓ CHECK 6: Verify Data in MongoDB');
    try {
      const recentPings = await LocationPing.find().sort({ gpsTime: -1 }).limit(5);
      const recentLogs = await RawGpsLog.find().sort({ gpsTimestamp: -1 }).limit(5);

      report.checks.mongodbVerify = {
        status: 'ok',
        recentPingCount: recentPings.length,
        recentLogCount: recentLogs.length,
        latestPing: recentPings[0] ? {
          imei: recentPings[0].imei,
          gpsTime: recentPings[0].gpsTime,
          lat: recentPings[0].latitude,
          lng: recentPings[0].longitude,
          vehicleId: recentPings[0].vehicleId,
        } : null,
        message: `Found ${recentPings.length} recent pings and ${recentLogs.length} recent logs ✅`,
      };
      logger.info('  ✅ Recent pings: %d | Recent logs: %d', recentPings.length, recentLogs.length);
      if (recentPings[0]) {
        logger.info('  📍 Latest ping: IMEI=%s at %s', recentPings[0].imei, recentPings[0].gpsTime);
      }
    } catch (err) {
      report.errors.push('MongoDB verification failed: ' + err.message);
      report.checks.mongodbVerify = { status: 'error', error: err.message };
      logger.error('  ❌ MongoDB verification failed: %s', err.message);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Final Summary
    // ──────────────────────────────────────────────────────────────────────
    const okCount = Object.values(report.checks).filter(c => c.status === 'ok').length;
    const errorCount = report.errors.length;

    report.summary = {
      passedChecks: okCount,
      failedChecks: errorCount,
      allPassed: errorCount === 0,
      recommendation: errorCount === 0
        ? '✅ All checks passed! Data flow is working. If no 24hr data, use EasyCron to keep backend awake.'
        : '❌ Some checks failed. See errors array for details.',
    };

    logger.info('═══════════════════════════════════════════════');
    logger.info('DIAGNOSTIC SUMMARY: %d passed, %d failed', okCount, errorCount);
    logger.info('═══════════════════════════════════════════════');

  } catch (err) {
    logger.error('❌ Diagnostic script error: %s', err.message);
    report.errors.push('Fatal error: ' + err.message);
  }

  return report;
}

module.exports = { runDiagnostics };