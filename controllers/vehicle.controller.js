// controllers/vehicle.controller.js
// ══════════════════════════════════════════════════════════════════════════════
// VEHICLE CONTROLLER - MATCH IMEI WITH REGISTERED_DEVICES
//
// Flow:
// 1. User registers vehicle with IMEI
// 2. Backend checks if IMEI exists in REGISTERED_DEVICES
// 3. If found → Link vehicle to registered device
// 4. Auto-fetch tracking data based on device protocol (PT06/GT06/MULTITRACK)
// 5. Show live location, speed, fuel, etc. on dashboard
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const Vehicle = require('../models/Vehicle');
const registeredDevices = require('../config/registered.devices');
const WanwayService = require('../services/wanway.service');
const MultiTrackService = require('../services/multitrack.service');
const TcpService = require('../services/tcp.service');
const logger = require('../utils/logger');

// ══════════════════════════════════════════════════════════════════════════════
// REGISTER VEHICLE - Auto Match with REGISTERED_DEVICES by IMEI
// ══════════════════════════════════════════════════════════════════════════════
exports.registerVehicle = async (req, res) => {
  try {
    const { imei, name, vehicleReg, pocName, pocContact, speedLimit, vehicleType } =
      req.body;
    const phone = req.user?.phone;

    // ── Validation ───────────────────────────────────────────────────────────
    if (!imei || !name) {
      return res.status(400).json({
        success: false,
        message: 'IMEI and name are required',
      });
    }

    if (imei.length !== 15 && !/^[A-Z0-9]+$/.test(imei)) {
      // Accept both 15-digit IMEI and MultiTrack engine numbers like "K15CN9457322"
      return res.status(400).json({
        success: false,
        message: 'Invalid IMEI format',
      });
    }

    // ── Check if IMEI already registered by another user ──────────────────────
    const existingVehicle = await Vehicle.findOne({ imei });
    if (existingVehicle) {
      return res.status(409).json({
        success: false,
        message: `IMEI ${imei} already registered to another account`,
      });
    }

    // ── Check duplicate reg number per user ───────────────────────────────────
    if (vehicleReg) {
      const duplicate = await Vehicle.findOne({ phone, vehicleReg });
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: `Registration number ${vehicleReg} already in your fleet`,
        });
      }
    }

    // ── CRITICAL: Check if IMEI exists in REGISTERED_DEVICES ─────────────────
    const registeredDevice = registeredDevices.getByIMEI(imei);

    if (!registeredDevice) {
      return res.status(400).json({
        success: false,
        message: `IMEI ${imei} not found in registered devices. Please add device to system first.`,
        knownIMEIs: registeredDevices.getAllIMEIs(),
      });
    }

    logger.info(`✅ IMEI ${imei} found in REGISTERED_DEVICES: ${registeredDevice.name}`);

    // ── Create vehicle document linked to registered device ──────────────────
    const vehicle = new Vehicle({
      phone,
      imei,
      name: name || registeredDevice.name,
      vehicleReg: vehicleReg || registeredDevice.vehicleReg,
      vehicleType: vehicleType || registeredDevice.type || 'car',
      pocName: pocName || registeredDevice.pocName,
      pocContact: pocContact || registeredDevice.pocContact,
      speedLimit: speedLimit || registeredDevice.speedLimit || 80,
      status: 'active',

      // Link to registered device
      registeredDeviceId: imei,
      deviceProtocol: registeredDevice.protocol, // PT06, GT06, MULTITRACK
      syncStatus: 'syncing',
    });

    await vehicle.save();
    logger.info(
      `✅ Vehicle registered: ${vehicle.name} (IMEI: ${imei}, Protocol: ${registeredDevice.protocol})`
    );

    // ── Background: Fetch initial data based on protocol ────────────────────
    fetchDeviceDataAsync(vehicle._id, imei, registeredDevice.protocol).catch(err => {
      logger.error(`Background data fetch failed for ${imei}:`, err.message);
    });

    // ── Return immediately (data fetch happens in background) ───────────────
    return res.status(201).json({
      success: true,
      message: 'Vehicle registered. Fetching tracking data...',
      vehicle: formatResponse(vehicle, registeredDevice),
    });
  } catch (err) {
    logger.error('Register vehicle error:', err);
    return res.status(500).json({
      success: false,
      message: `Registration failed: ${err.message}`,
    });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// GET USER'S VEHICLES (Auto-refresh from registered devices)
// ══════════════════════════════════════════════════════════════════════════════
exports.getUserVehicles = async (req, res) => {
  try {
    const phone = req.user?.phone;

    const vehicles = await Vehicle.find({ phone }).sort({ createdAt: -1 });

    // ── Statistics ───────────────────────────────────────────────────────────
    const stats = {
      total: vehicles.length,
      synced: vehicles.filter(v => v.syncStatus === 'synced').length,
      syncing: vehicles.filter(v => v.syncStatus === 'syncing').length,
      error: vehicles.filter(v => v.syncStatus === 'error').length,
      online: vehicles.filter(v => v.isOnline).length,
      offline: vehicles.filter(v => !v.isOnline).length,
    };

    // ── Background: Refresh data for all vehicles ────────────────────────────
    refreshAllVehiclesAsync(vehicles).catch(err => {
      logger.warn('Background refresh failed:', err.message);
    });

    // ── Return immediately with current data ──────────────────────────────────
    return res.status(200).json({
      success: true,
      ...stats,
      vehicles: vehicles.map(v => {
        const reg = registeredDevices.getByIMEI(v.imei);
        return formatResponse(v, reg);
      }),
    });
  } catch (err) {
    logger.error('Get vehicles error:', err);
    return res.status(500).json({
      success: false,
      message: `Failed to fetch vehicles: ${err.message}`,
    });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// GET SINGLE VEHICLE WITH LIVE DATA
// ══════════════════════════════════════════════════════════════════════════════
exports.getVehicle = async (req, res) => {
  try {
    const { vehicleId } = req.params;
    const phone = req.user?.phone;

    const vehicle = await Vehicle.findOne({ _id: vehicleId, phone });
    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: 'Vehicle not found',
      });
    }

    const registeredDevice = registeredDevices.getByIMEI(vehicle.imei);
    if (!registeredDevice) {
      return res.status(404).json({
        success: false,
        message: `Registered device not found for IMEI ${vehicle.imei}`,
      });
    }

    // ── If syncing, try to complete ──────────────────────────────────────────
    if (vehicle.syncStatus === 'syncing') {
      try {
        await fetchDeviceData(vehicle, registeredDevice.protocol);
        vehicle.syncStatus = 'synced';
        await vehicle.save();
        logger.info(`✅ Vehicle sync completed: ${vehicle.name}`);
      } catch (err) {
        logger.warn(`Could not complete sync for ${vehicle.imei}:`, err.message);
        vehicle.syncStatus = 'error';
        vehicle.syncError = err.message;
        await vehicle.save();
      }
    }

    // ── Refresh latest data based on protocol ────────────────────────────────
    if (vehicle.syncStatus === 'synced') {
      try {
        await fetchDeviceData(vehicle, registeredDevice.protocol);
        await vehicle.save();
      } catch (err) {
        logger.warn(`Could not refresh data for ${vehicle.imei}:`, err.message);
        // Still return what we have
      }
    }

    return res.status(200).json({
      success: true,
      vehicle: formatResponse(vehicle, registeredDevice),
    });
  } catch (err) {
    logger.error('Get vehicle error:', err);
    return res.status(500).json({
      success: false,
      message: `Failed to fetch vehicle: ${err.message}`,
    });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// UPDATE VEHICLE DETAILS
// ══════════════════════════════════════════════════════════════════════════════
exports.updateVehicle = async (req, res) => {
  try {
    const { vehicleId } = req.params;
    const phone = req.user?.phone;
    const { name, pocName, pocContact, speedLimit, status } = req.body;

    const vehicle = await Vehicle.findOne({ _id: vehicleId, phone });
    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: 'Vehicle not found',
      });
    }

    if (name) vehicle.name = name;
    if (pocName !== undefined) vehicle.pocName = pocName || null;
    if (pocContact !== undefined) vehicle.pocContact = pocContact || null;
    if (speedLimit) vehicle.speedLimit = speedLimit;
    if (status) vehicle.status = status;

    await vehicle.save();
    logger.info(`✅ Vehicle updated: ${vehicle.name}`);

    const registeredDevice = registeredDevices.getByIMEI(vehicle.imei);
    return res.status(200).json({
      success: true,
      message: 'Vehicle updated',
      vehicle: formatResponse(vehicle, registeredDevice),
    });
  } catch (err) {
    logger.error('Update vehicle error:', err);
    return res.status(500).json({
      success: false,
      message: `Failed to update vehicle: ${err.message}`,
    });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// DELETE VEHICLE
// ══════════════════════════════════════════════════════════════════════════════
exports.deleteVehicle = async (req, res) => {
  try {
    const { vehicleId } = req.params;
    const phone = req.user?.phone;

    const vehicle = await Vehicle.findOne({ _id: vehicleId, phone });
    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: 'Vehicle not found',
      });
    }

    const name = vehicle.name;
    await Vehicle.deleteOne({ _id: vehicleId });
    logger.info(`✅ Vehicle deleted: ${name}`);

    return res.status(200).json({
      success: true,
      message: 'Vehicle deleted',
    });
  } catch (err) {
    logger.error('Delete vehicle error:', err);
    return res.status(500).json({
      success: false,
      message: `Failed to delete vehicle: ${err.message}`,
    });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// GET VEHICLE STATUS SUMMARY
// ══════════════════════════════════════════════════════════════════════════════
exports.getVehiclesSummary = async (req, res) => {
  try {
    const phone = req.user?.phone;
    const vehicles = await Vehicle.find({ phone });

    const summary = {
      total: vehicles.length,
      synced: vehicles.filter(v => v.syncStatus === 'synced').length,
      syncing: vehicles.filter(v => v.syncStatus === 'syncing').length,
      error: vehicles.filter(v => v.syncStatus === 'error').length,
      online: vehicles.filter(v => v.isOnline).length,
      offline: vehicles.filter(v => !v.isOnline).length,
      moving: vehicles.filter(v => v.isOnline && v.speed > 0).length,
      idle: vehicles.filter(v => v.isOnline && v.speed === 0).length,
    };

    return res.status(200).json({
      success: true,
      summary,
    });
  } catch (err) {
    logger.error('Get summary error:', err);
    return res.status(500).json({
      success: false,
      message: `Failed to get summary: ${err.message}`,
    });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch device data based on protocol
 */
async function fetchDeviceData(vehicle, protocol) {
  logger.debug(`📡 Fetching data for ${vehicle.imei} (Protocol: ${protocol})`);

  let data = null;

  if (protocol === 'PT06') {
    // IOP GPS / WanWay platform
    data = await WanwayService.getDeviceLatestData(vehicle.imei);
  } else if (protocol === 'GT06') {
    // Direct TCP devices (cached in memory)
    data = await TcpService.getDeviceLatestData(vehicle.imei);
  } else if (protocol === 'MULTITRACK') {
    // MultiTrackVTS AIS 140 platform
    data = await MultiTrackService.getDeviceLatestData(vehicle.imei);
  }

  if (data) {
    // Update vehicle with latest data
    vehicle.location = {
      latitude: data.lat || 0,
      longitude: data.lng || 0,
      address: data.address || null,
      timestamp: new Date(),
    };

    vehicle.speed = data.speed || 0;
    vehicle.heading = data.heading || 0;
    vehicle.altitude = data.altitude || 0;
    vehicle.satellites = data.satellites || 0;
    vehicle.gpsAccuracy = data.gpsAccuracy || 0;
    vehicle.gpsSignal = data.gpsSignal !== false;

    vehicle.ignitionOn = data.ignitionOn || false;
    vehicle.mileage = data.mileage || 0;
    vehicle.fuelLevel = data.fuelLevel || 100;
    vehicle.batteryVoltage = data.batteryVoltage || 0;
    vehicle.temperature = data.temperature || 0;

    vehicle.isOnline = data.isOnline !== false;
    vehicle.lastGpsTime = new Date();
    vehicle.lastUpdate = new Date();
    vehicle.syncStatus = 'synced';
    vehicle.syncError = null;

    logger.info(
      `📍 ${vehicle.name}: Lat=${data.lat}, Lng=${data.lng}, Speed=${data.speed}, Fuel=${data.fuelLevel}%`
    );
  }
}

/**
 * Async fetch for registration (doesn't block response)
 */
async function fetchDeviceDataAsync(vehicleId, imei, protocol) {
  try {
    const vehicle = await Vehicle.findById(vehicleId);
    if (!vehicle) return;

    await fetchDeviceData(vehicle, protocol);
    await vehicle.save();
  } catch (err) {
    logger.error(`Async fetch failed for ${imei}:`, err.message);
  }
}

/**
 * Refresh all vehicles
 */
async function refreshAllVehiclesAsync(vehicles) {
  for (const vehicle of vehicles) {
    if (vehicle.syncStatus === 'error') continue;

    try {
      const protocol = vehicle.deviceProtocol;
      await fetchDeviceData(vehicle, protocol);
      await vehicle.save();
    } catch (err) {
      logger.debug(`Could not refresh ${vehicle.imei}:`, err.message);
    }
  }
}

/**
 * Format response
 */
function formatResponse(vehicle, registeredDevice = null) {
  return {
    id: vehicle._id,
    name: vehicle.name,
    vehicleReg: vehicle.vehicleReg,
    imei: vehicle.imei,
    vehicleType: vehicle.vehicleType,
    pocName: vehicle.pocName,
    pocContact: vehicle.pocContact,
    status: vehicle.status,
    speedLimit: vehicle.speedLimit,

    location: {
      lat: vehicle.location?.latitude || 0,
      lng: vehicle.location?.longitude || 0,
      address: vehicle.location?.address || 'Fetching...',
      timestamp: vehicle.location?.timestamp,
    },

    speed: vehicle.speed,
    heading: vehicle.heading,
    altitude: vehicle.altitude,
    gpsSignal: vehicle.gpsSignal,
    satellites: vehicle.satellites,
    gpsAccuracy: vehicle.gpsAccuracy,

    ignitionOn: vehicle.ignitionOn,
    mileage: vehicle.mileage,
    fuelLevel: vehicle.fuelLevel,
    batteryVoltage: vehicle.batteryVoltage,
    temperature: vehicle.temperature,

    isOnline: vehicle.isOnline,
    isLive: vehicle.isLive,
    lastUpdate: vehicle.lastUpdate,
    lastGpsTime: vehicle.lastGpsTime,

    syncStatus: vehicle.syncStatus,
    syncError: vehicle.syncError,
    deviceProtocol: vehicle.deviceProtocol,

    registeredDevice: registeredDevice
      ? {
          name: registeredDevice.name,
          protocol: registeredDevice.protocol,
          type: registeredDevice.type,
        }
      : null,

    createdAt: vehicle.createdAt,
  };
}

module.exports = exports;