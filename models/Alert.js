'use strict';

const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  vehicleId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
  vehicleReg: { type: String, index: true },
  imei:       { type: String, index: true }, // Crucial for WanWay API correlation

  title:   { type: String, required: true, maxlength: 100 },
  message: { type: String, required: true, maxlength: 500 },

  type: {
    type: String,
    enum: [
      'overspeed','powerCut','geofenceExit','geofenceEnter',
      'unauthorizedMovement','ignitionOn','ignitionOff',
      'harshBraking','harshAcceleration','lowFuel','lowBattery',
      'gpsLost','idle','parking','engineOverheat','maintenanceDue',
      'sos' 
    ],
    required: true,
    index: true,
  },

  priority: { 
    type: String, 
    enum: ['critical','high','medium','low'], 
    default: 'low', 
    index: true 
  },

  // Snapshot of location when alert triggered
  latitude:  { type: Number },
  longitude: { type: Number },
  speed:     { type: Number },

  // Denormalized snapshots for O(1) read performance on Flutter app
  pocName:     { type: String },
  pocContact:  { type: String },
  vehicleType: { type: String },

  // Interaction State
  isRead:          { type: Boolean, default: false, index: true },
  isAcknowledged: { type: Boolean, default: false, index: true },
  acknowledgedAt: { type: Date },
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  timestamp: { type: Date, default: Date.now, index: true },
}, {
  versionKey: false,
});

// ── Compound indexes: Makes the "Alerts" tab in Flutter instantaneous ──────────
alertSchema.index({ isRead: 1, timestamp: -1 });
alertSchema.index({ priority: 1, isRead: 1 });
alertSchema.index({ vehicleId: 1, type: 1, timestamp: -1 });

// ── TTL Index: Auto-purges old data to prevent DB bloat ────────────────────────
// Deletes document 30 days after 'timestamp'
alertSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

alertSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Alert', alertSchema);