'use strict';

const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  vehicleId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
  vehicleReg: { type: String, index: true },
  imei:       { type: String, index: true },

  title:   { type: String, required: true, maxlength: 100 },
  message: { type: String, required: true, maxlength: 500 },

  type: {
    type: String,
    enum: [
      'overspeed','powerCut','geofenceExit','geofenceEnter',
      'unauthorizedMovement','ignitionOn','ignitionOff',
      'harshBraking','harshAcceleration','lowFuel','lowBattery',
      'gpsLost','idle','parking','engineOverheat','maintenanceDue',
      'sos',
    ],
    required: true,
    index: true,
  },

  priority: {
    type:    String,
    enum:    ['critical','high','medium','low'],
    default: 'low',
    index:   true,
  },

  latitude:  { type: Number },
  longitude: { type: Number },
  speed:     { type: Number },

  pocName:     { type: String },
  pocContact:  { type: String },
  vehicleType: { type: String },

  isRead:         { type: Boolean, default: false, index: true },
  isAcknowledged: { type: Boolean, default: false, index: true },
  acknowledgedAt: { type: Date },
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // FIX: removed index: true here.
  // The TTL schema.index() below already creates an index on this field.
  // Declaring index: true AND schema.index() on the same field = duplicate warning.
  timestamp: { type: Date, default: Date.now },
}, {
  versionKey: false,
});

// ── Compound indexes ───────────────────────────────────────────────────────────
alertSchema.index({ isRead: 1, timestamp: -1 });
alertSchema.index({ priority: 1, isRead: 1 });
alertSchema.index({ vehicleId: 1, type: 1, timestamp: -1 });

// ── TTL index: auto-purge alerts older than 30 days ───────────────────────────
// This is the ONLY index on { timestamp: 1 } — field-level index: true removed above
alertSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

alertSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Alert', alertSchema);