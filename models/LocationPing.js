// models/LocationPing.js
'use strict';

const mongoose = require('mongoose');

const locationPingSchema = new mongoose.Schema({
  vehicleId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
  latitude:     { type: Number, required: true },
  longitude:    { type: Number, required: true },
  altitude:     { type: Number, default: 0 },
  speed:        { type: Number, default: 0 },
  heading:      { type: Number, default: 0 },
  fuel:         { type: Number },
  batteryLevel: { type: Number },
  status:       { type: String, enum: ['moving','idle','parked','offline','unknown'], default: 'idle' },
  gpsSignal:    { type: Boolean, default: true },
  timestamp:    { type: Date, default: Date.now, index: true },
}, {
  versionKey: false,
  // No timestamps: true — timestamp field is explicit above
});

// ── Compound index for history queries ────────────────────────────────────────
locationPingSchema.index({ vehicleId: 1, timestamp: -1 });

// ── Auto-expire pings after 90 days to keep collection lean ──────────────────
locationPingSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model('LocationPing', locationPingSchema);