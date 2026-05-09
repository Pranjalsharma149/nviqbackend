'use strict';

const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  vehicleId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
  vehicleReg: { type: String, index: true },
  imei:       { type: String, index: true },

  title:   { type: String, required: true, maxlength: 100 },
  message: { type: String, required: true, maxlength: 500 },

  // FIX: added 'extremeOverspeed' to match Flutter AlertType.extremeOverspeed
  type: {
    type: String,
    enum: [
      'overspeed',
      'extremeOverspeed',       // ← added: matches Flutter AlertType & VehicleAlertConfig
      'powerCut',
      'geofenceExit',
      'geofenceEnter',
      'unauthorizedMovement',
      'ignitionOn',
      'ignitionOff',
      'harshBraking',
      'harshAcceleration',
      'lowFuel',
      'lowBattery',
      'gpsLost',
      'idle',
      'parking',
      'engineOverheat',
      'maintenanceDue',
      'sos',
    ],
    required: true,
    index: true,
  },

  priority: {
    type:    String,
    enum:    ['critical', 'high', 'medium', 'low'],
    default: 'low',
    index:   true,
  },

  latitude:  { type: Number },
  longitude: { type: Number },
  speed:     { type: Number },

  pocName:     { type: String },
  pocContact:  { type: String },
  vehicleType: { type: String },

  isRead: { type: Boolean, default: false, index: true },

  // FIX: field name is isAcknowledged (was accidentally used as isAcked in controller)
  isAcknowledged: { type: Boolean, default: false, index: true },
  acknowledgedAt: { type: Date },
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // NOTE: no field-level index: true here — TTL index below covers this field.
  // Declaring index: true AND schema.index() on the same field = duplicate index warning.
  timestamp: { type: Date, default: Date.now },
}, {
  versionKey: false,
});

// ── Compound indexes ───────────────────────────────────────────────────────────
alertSchema.index({ isRead: 1, timestamp: -1 });
alertSchema.index({ priority: 1, isRead: 1 });
alertSchema.index({ vehicleId: 1, type: 1, timestamp: -1 });

// ── TTL index: auto-purge alerts older than 30 days ───────────────────────────
alertSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

alertSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Alert', alertSchema);