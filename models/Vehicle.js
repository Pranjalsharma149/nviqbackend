'use strict';

/**
 * models/Vehicle.js
 *
 * Vehicle schema with phone-based identification.
 * Every vehicle is linked to a user's phone number.
 * Phone = User ID, so vehicles are easily queried by phone.
 */

const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema(
  {
    // ── Identity ───────────────────────────────────────────────────────────
    name: {
      type:      String,
      required:  [true, 'Vehicle name is required'],
      trim:      true,
      maxlength: 100,
    },

    registrationNumber: {
      type:      String,
      required:  [true, 'Vehicle registration required'],
      trim:      true,
      unique:    true,
      uppercase: true,
    },

    type: {
      type:    String,
      enum:    ['car', 'truck', 'bike', 'auto', 'bus', 'van', 'ambulance', 'tractor'],
      default: 'car',
    },

    imei: {
      type:   String,
      trim:   true,
      sparse: true,
    },

    protocol: {
      type:    String,
      default: 'GT06',
    },

    // ── Phone-based User Identification (IMPORTANT!) ──────────────────────
    // This links the vehicle to a user by their phone number
    phone: {
      type:     String,
      required: [true, 'Phone is required'],
      index:    true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'User',
      default: null,
    },

    // ── Personnel ──────────────────────────────────────────────────────────
    pocName: {
      type:    String,
      trim:    true,
      default: null,
    },

    pocContact: {
      type:    String,
      trim:    true,
      default: null,
    },

    // ── Speed Limit ────────────────────────────────────────────────────────
    speedLimit: {
      type:    Number,
      default: 80,
    },

    // ── Status ─────────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ['active', 'inactive', 'maintenance'],
      default: 'active',
    },

    deviceStatus: {
      type:    String,
      enum:    ['working', 'not_working', 'inactive'],
      default: 'not_working',
    },

    isOnline: {
      type:    Boolean,
      default: false,
    },

    isLive: {
      type:    Boolean,
      default: false,
    },

    gpsSignal: {
      type:    Boolean,
      default: true,
    },

    // ── Location ───────────────────────────────────────────────────────────
    latitude: {
      type:    Number,
      default: null,
    },

    longitude: {
      type:    Number,
      default: null,
    },

    location: {
      type:    String,
      default: null,
    },

    // ── Device Info ────────────────────────────────────────────────────────
    deviceId: {
      type:    String,
      default: null,
    },

    lastDeviceSync: {
      type:    Date,
      default: null,
    },

    // ── Last Location ──────────────────────────────────────────────────────
    lastLocation: {
      latitude: {
        type:    Number,
        default: null,
      },
      longitude: {
        type:    Number,
        default: null,
      },
      timestamp: {
        type:    Date,
        default: null,
      },
      address: {
        type:    String,
        default: null,
      },
    },

    // ── Vehicle Metrics ────────────────────────────────────────────────────
    mileage: {
      type:    Number,
      default: 0,
    },

    fuelLevel: {
      type:    Number,
      default: 0,
    },

    speed: {
      type:    Number,
      default: 0,
    },

    // ── Timestamps ─────────────────────────────────────────────────────────
    lastUpdate: {
      type:    Date,
      default: () => new Date(),
    },

    createdAt: {
      type:    Date,
      default: () => new Date(),
    },

    updatedAt: {
      type:    Date,
      default: () => new Date(),
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// ── Indexes ────────────────────────────────────────────────────────────────
// Query by phone to get all vehicles for a user
vehicleSchema.index({ phone: 1, status: 1 });
vehicleSchema.index({ phone: 1, isOnline: 1 });
vehicleSchema.index({ registrationNumber: 1 });
vehicleSchema.index({ lastUpdate: -1 });

// ── Pre-save middleware ────────────────────────────────────────────────────
vehicleSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.Vehicle || mongoose.model('Vehicle', vehicleSchema);