// models/Vehicle.js
// ══════════════════════════════════════════════════════════════════════════════
// VEHICLE MODEL - IMEI MATCHING INTEGRATION
//
// Key Features:
// - Phone-based user identification (existing)
// - IMEI linking to REGISTERED_DEVICES (new)
// - Automatic data sync from WanWay/TCP/MultiTrack (new)
// - Live tracking fields (lat/lng/speed/fuel/battery)
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema(
  {
    // ── IDENTITY ───────────────────────────────────────────────────────────
    name: {
      type: String,
      required: [true, 'Vehicle name is required'],
      trim: true,
      maxlength: 100,
    },

    registrationNumber: {
      type: String,
      required: [true, 'Vehicle registration required'],
      trim: true,
      unique: true,
      uppercase: true,
    },

    type: {
      type: String,
      enum: ['car', 'truck', 'bike', 'auto', 'bus', 'van', 'ambulance', 'tractor'],
      default: 'car',
    },

    // ── IMEI & DEVICE LINKING (NEW) ────────────────────────────────────────
    imei: {
      type: String,
      trim: true,
      sparse: true,
      unique: true,
      index: true,
      comment: '15-digit IMEI from REGISTERED_DEVICES',
    },

    protocol: {
      type: String,
      enum: ['PT06', 'GT06', 'MULTITRACK', 'UNKNOWN'],
      default: 'UNKNOWN',
      comment: 'Device protocol: PT06=WanWay, GT06=Direct TCP, MULTITRACK=AIS140',
    },

    registeredDeviceId: {
      type: String,
      comment: 'IMEI (same as imei field, for reference)',
    },

    // ── SYNC STATUS (NEW) ──────────────────────────────────────────────────
    syncStatus: {
      type: String,
      enum: ['syncing', 'synced', 'error', 'not_synced'],
      default: 'not_synced',
      comment: 'Device sync state: syncing/synced/error',
    },

    syncError: {
      type: String,
      default: null,
      comment: 'Error message if sync failed',
    },

    syncTime: {
      type: Date,
      default: null,
      comment: 'Last sync attempt time',
    },

    // ── PHONE-BASED USER ID (EXISTING) ────────────────────────────────────
    // This links the vehicle to a user by their phone number
    phone: {
      type: String,
      required: [true, 'Phone is required'],
      index: true,
      comment: 'User phone number (from JWT) - determines ownership',
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ── CONTACT INFO (EXISTING) ────────────────────────────────────────────
    pocName: {
      type: String,
      trim: true,
      default: null,
      comment: 'Point of Contact / Driver name',
    },

    pocContact: {
      type: String,
      trim: true,
      default: null,
      comment: 'Point of Contact / Driver phone or email',
    },

    // ── SPEED LIMIT ────────────────────────────────────────────────────────
    speedLimit: {
      type: Number,
      default: 80,
      comment: 'Speed limit in km/h',
    },

    // ── STATUS (EXISTING) ──────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['active', 'inactive', 'maintenance', 'moving', 'idle', 'parked', 'offline'],
      default: 'active',
    },

    deviceStatus: {
      type: String,
      enum: ['working', 'not_working', 'inactive'],
      default: 'not_working',
      comment: 'GPS device status',
    },

    todayStops: {
      type: Number,
      default: 0
    },
    todayStopResetAt: {
      type: Date,
      default: null
    },
    isOnline: {
      type: Boolean,
      default: false,
      comment: 'Is device online?',
    },

    isLive: {
      type: Boolean,
      default: false,
      comment: 'Is vehicle being tracked in real-time?',
    },

    gpsSignal: {
      type: Boolean,
      default: true,
      comment: 'Is GPS signal active?',
    },

    // ── LIVE LOCATION DATA (NEW) ───────────────────────────────────────────
    latitude: {
      type: Number,
      default: null,
      comment: 'Current latitude',
    },

    longitude: {
      type: Number,
      default: null,
      comment: 'Current longitude',
    },

    location: {
      type: String,
      default: null,
      comment: 'Human-readable address',
    },

    // ── DEVICE INFO ────────────────────────────────────────────────────────
    deviceId: {
      type: String,
      default: null,
      comment: 'WanWay device ID (if synced)',
    },

    lastDeviceSync: {
      type: Date,
      default: null,
      comment: 'Last time device data was synced',
    },

    // ── LAST KNOWN LOCATION (NEW) ──────────────────────────────────────────
    lastLocation: {
      latitude: {
        type: Number,
        default: null,
        comment: 'Last known latitude',
      },
      longitude: {
        type: Number,
        default: null,
        comment: 'Last known longitude',
      },
      timestamp: {
        type: Date,
        default: null,
        comment: 'When location was recorded',
      },
      address: {
        type: String,
        default: null,
        comment: 'Human-readable address of last location',
      },
    },

    // ── VEHICLE TELEMETRY (NEW) ────────────────────────────────────────────
    speed: {
      type: Number,
      default: 0,
      comment: 'Current speed in km/h',
    },

    heading: {
      type: Number,
      default: 0,
      comment: 'Direction in degrees (0-360)',
    },

    altitude: {
      type: Number,
      default: 0,
      comment: 'Altitude in meters',
    },

    satellites: {
      type: Number,
      default: 0,
      comment: 'Number of GPS satellites connected',
    },

    gpsAccuracy: {
      type: Number,
      default: 0,
      comment: 'GPS accuracy in meters',
    },

    // ── VEHICLE SENSORS (NEW) ──────────────────────────────────────────────
    mileage: {
      type: Number,
      default: 0,
      comment: 'Odometer reading in km',
    },

    fuelLevel: {
      type: Number,
      default: 0,
      comment: 'Fuel percentage (0-100)',
    },

    batteryVoltage: {
      type: Number,
      default: 0,
      comment: 'Device battery voltage',
    },

    ignitionOn: {
      type: Boolean,
      default: false,
      comment: 'Is vehicle ignition ON?',
    },

    ignitionSince: {
      type: Date,
      default: null,
      comment: 'Timestamp when ignition last turned ON (null = ignition is OFF)',
    },

    statusSince: {
      type: Date,
      default: () => new Date(),
      comment: 'Timestamp when vehicle status last changed',
    },

    temperature: {
      type: Number,
      default: 0,
      comment: 'Device internal temperature',
    },

    // ── TIMESTAMPS ─────────────────────────────────────────────────────────
    lastUpdate: {
      type: Date,
      default: () => new Date(),
      comment: 'Last time vehicle data was updated',
    },

    lastGpsTime: {
      type: Date,
      default: null,
      comment: 'Last time GPS data was received',
    },

    createdAt: {
      type: Date,
      default: () => new Date(),
    },

    updatedAt: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// ── INDEXES FOR PERFORMANCE ───────────────────────────────────────────────────
// Phone-scoped queries (user sees only their vehicles)
vehicleSchema.index({ phone: 1, status: 1 });
vehicleSchema.index({ phone: 1, isOnline: 1 });
vehicleSchema.index({ phone: 1, createdAt: -1 });

// IMEI queries (find vehicle by device)
vehicleSchema.index({ imei: 1 });
vehicleSchema.index({ registrationNumber: 1 });

// Real-time tracking
vehicleSchema.index({ isOnline: 1, lastUpdate: -1 });
vehicleSchema.index({ latitude: 1, longitude: 1 });

// ── PRE-SAVE MIDDLEWARE ────────────────────────────────────────────────────────
vehicleSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// ── METHODS ────────────────────────────────────────────────────────────────────

/**
 * Update vehicle with data from WanWay/TCP/MultiTrack
 */
vehicleSchema.methods.updateFromWanWay = function (wanwayData) {
  if (wanwayData.lat && wanwayData.lng) {
    this.latitude = wanwayData.lat;
    this.longitude = wanwayData.lng;
    this.lastLocation = {
      latitude: wanwayData.lat,
      longitude: wanwayData.lng,
      address: wanwayData.address || this.location,
      timestamp: new Date(),
    };
    this.lastGpsTime = new Date();
  }

  if (wanwayData.speed !== undefined) this.speed = wanwayData.speed;
  if (wanwayData.heading !== undefined) this.heading = wanwayData.heading;
  if (wanwayData.altitude !== undefined) this.altitude = wanwayData.altitude;
  if (wanwayData.satellites !== undefined) this.satellites = wanwayData.satellites;
  if (wanwayData.gpsAccuracy !== undefined) this.gpsAccuracy = wanwayData.gpsAccuracy;
  if (wanwayData.gpsSignal !== undefined) this.gpsSignal = wanwayData.gpsSignal;

  if (wanwayData.ignitionOn !== undefined) this.ignitionOn = wanwayData.ignitionOn;
  if (wanwayData.mileage !== undefined) this.mileage = wanwayData.mileage;
  if (wanwayData.fuelLevel !== undefined) this.fuelLevel = wanwayData.fuelLevel;
  if (wanwayData.batteryVoltage !== undefined) this.batteryVoltage = wanwayData.batteryVoltage;
  if (wanwayData.temperature !== undefined) this.temperature = wanwayData.temperature;
  if (wanwayData.address !== undefined) this.location = wanwayData.address;

  this.isOnline = wanwayData.isOnline !== false;
  this.lastUpdate = new Date();

  return this;
};

/**
 * Mark vehicle as successfully synced with WanWay
 */
vehicleSchema.methods.markSynced = function (deviceId) {
  this.deviceId = deviceId;
  this.syncStatus = 'synced';
  this.syncError = null;
  this.syncTime = new Date();
  this.deviceStatus = 'working';
  return this;
};

/**
 * Mark vehicle as currently syncing
 */
vehicleSchema.methods.markSyncing = function () {
  this.syncStatus = 'syncing';
  this.syncTime = new Date();
  return this;
};

/**
 * Mark vehicle sync as failed
 */
vehicleSchema.methods.markSyncError = function (error) {
  this.syncStatus = 'error';
  this.syncError = error?.message || error?.toString() || 'Unknown error';
  this.syncTime = new Date();
  this.deviceStatus = 'not_working';
  return this;
};

module.exports = mongoose.models.Vehicle || mongoose.model('Vehicle', vehicleSchema);