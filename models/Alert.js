// models/Alert.js
'use strict';

const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  vehicleId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
  vehicleReg: { type: String },

  title:   { type: String, required: true, maxlength: 100 },
  message: { type: String, required: true, maxlength: 500 },

  type: {
    type: String,
    enum: [
      'overspeed','powerCut','geofenceExit','geofenceEnter',
      'unauthorizedMovement','ignitionOn','ignitionOff',
      'harshBraking','harshAcceleration','lowFuel','lowBattery',
      'gpsLost','idle','parking','engineOverheat','maintenanceDue',
    ],
    required: true,
    index: true,
  },

  priority: { type: String, enum: ['critical','high','medium','low'], default: 'low', index: true },

  // Snapshot at time of alert
  latitude:  { type: Number },
  longitude: { type: Number },
  speed:     { type: Number },

  // POC snapshot (denormalized for fast reads)
  pocName:     { type: String },
  pocContact:  { type: String },
  vehicleType: { type: String },

  // State
  isRead:         { type: Boolean, default: false, index: true },
  isAcknowledged: { type: Boolean, default: false },
  acknowledgedAt: { type: Date },
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  timestamp: { type: Date, default: Date.now, index: true },
}, {
  versionKey: false,
});

// ── Compound indexes for Flutter alert screen queries ─────────────────────────
alertSchema.index({ isRead: 1, timestamp: -1 });
alertSchema.index({ priority: 1, isRead: 1 });
alertSchema.index({ vehicleId: 1, type: 1, timestamp: -1 });

// ── Auto-expire alerts after 30 days ─────────────────────────────────────────
alertSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

alertSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Alert', alertSchema);