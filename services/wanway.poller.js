'use strict';

const axios  = require('axios');
const crypto = require('crypto');
const { processBulkUpdates } = require('./data.processor');
const logger = require('../utils/logger');

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

class IOPGPSPoller {
  constructor() {
    this.baseUrl  = process.env.WANWAY_API_BASE || 'https://open.iopgps.com';
    this.appId    = process.env.WANWAY_APPID;
    this.secret   = process.env.WANWAY_SECRET;
    this.token    = null;
    this.tokenExp = 0;
    this.isPolling = false;
    this.consecutiveErrors = 0;
  }

  validateConfig() {
    if (!this.appId || !this.secret) {
      logger.error('❌ Missing WANWAY_APPID or WANWAY_SECRET in .env');
      return false;
    }
    return true;
  }

  // Token expires in 2 hours — refresh 5 min before expiry
  async getToken() {
    if (this.token && Date.now() < this.tokenExp) return this.token;

    const time      = Math.floor(Date.now() / 1000);
    const signature = md5(md5(this.secret) + time);

    const res = await axios.post(
      `${this.baseUrl}/api/auth`,
      { appid: this.appId, time, signature },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    if (res.data?.code !== 0) {
      throw new Error(`Auth failed: ${res.data?.result || res.data?.message}`);
    }

    this.token    = res.data.accessToken;
    this.tokenExp = Date.now() + res.data.expiresIn - 300000;
    logger.info('🔑 IOP GPS token refreshed');
    return this.token;
  }

  async fetchDeviceData() {
    try {
      const token = await this.getToken();

      // ── Strategy 1: GET /api/device/status (all devices under account) ──
      const statusRes = await axios.get(
        `${this.baseUrl}/api/device/status`,
        {
          params: { accessToken: token },
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );

      if (statusRes.data?.code === 0 && Array.isArray(statusRes.data.data) && statusRes.data.data.length > 0) {
        logger.info('📡 Strategy 1 success: %d devices', statusRes.data.data.length);
        this.consecutiveErrors = 0;
        return statusRes.data.data;
      }

      // ── Strategy 2: GET /api/vehicle/location (vehicle-linked devices) ──
      const vehicleRes = await axios.get(
        `${this.baseUrl}/api/vehicle/location`,
        {
          params: { accessToken: token },
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );

      if (vehicleRes.data?.code === 0 && vehicleRes.data?.data?.list?.length > 0) {
        logger.info('📡 Strategy 2 success: %d vehicles', vehicleRes.data.data.list.length);
        this.consecutiveErrors = 0;
        return vehicleRes.data.data.list;
      }

      // ── Strategy 3: GET /api/device/location with known IMEI ──
      const { getAllIMEIs } = require('../config/devices');
      const imeis = getAllIMEIs();

      if (imeis.length > 0) {
        const locationRes = await axios.get(
          `${this.baseUrl}/api/device/location`,
          {
            params: { accessToken: token, imei: imeis[0] },
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
            validateStatus: () => true,
          }
        );

        if (locationRes.data?.code === 0 && locationRes.data?.data) {
          logger.info('📡 Strategy 3 success: direct IMEI lookup');
          this.consecutiveErrors = 0;
          return Array.isArray(locationRes.data.data)
            ? locationRes.data.data
            : [locationRes.data.data];
        }

        logger.warn('⚠️ Strategy 3 response: %s', JSON.stringify(locationRes.data));
      }

      // All strategies returned empty — device is offline
      logger.warn('⚠️ Device offline or not visible to API account');
      this.consecutiveErrors = 0;
      return [];

    } catch (err) {
      this.consecutiveErrors++;

      if (err.response) {
        logger.error('❌ API Error %d: %s',
          err.response.status,
          JSON.stringify(err.response.data)
        );
      } else {
        logger.error('❌ API Fetch Error: %s', err.message);
      }

      // If rate limited — back off exponentially
      if (this.consecutiveErrors > 3) {
        logger.warn('⚠️ Too many errors — backing off for 5 minutes');
        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
        this.consecutiveErrors = 0;
      }

      return [];
    }
  }

  async start() {
    if (this.isPolling) return;
    if (!this.validateConfig()) return;

    this.isPolling = true;
    logger.info('🚀 IOPGPS Poller started (Interval: 30s)');

    // Run immediately then every 30s
    try {
      const devices = await this.fetchDeviceData();
      if (devices.length > 0) {
        logger.info('📡 Received %d devices from IOP GPS', devices.length);
        await processBulkUpdates(devices);
      }
    } catch (err) {
      logger.error('❌ Initial poll error: %s', err.message);
    }

    setInterval(async () => {
      try {
        const devices = await this.fetchDeviceData();
        if (devices.length > 0) {
          logger.info('📡 Received %d devices from IOP GPS', devices.length);
          await processBulkUpdates(devices);
        }
      } catch (err) {
        logger.error('❌ Poller Error: %s', err.message);
      }
    }, 30000);
  }
}

module.exports = new IOPGPSPoller();