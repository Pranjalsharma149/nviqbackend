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
  
  // WanWay-compatible status strings
  status:       { 
    type: String, 
    enum: ['moving', 'static', 'idle', 'parked', 'offline', 'unknown'], 
    default: 'static' 
  },
  
  gpsSignal:    { type: Boolean, default: true },
  
  // Primary timestamp for logic and TTL
  timestamp:    { type: Date, default: Date.now, index: true },
}, {
  // Optimization: Disable versionKey and timestamps for high-write collections
  versionKey: false,
  timestamps: false 
});

// ── Compound index for History Playback (Flutter) ─────────────────────────────
// Essential for O(1) retrieval of route history
locationPingSchema.index({ vehicleId: 1, timestamp: -1 });

// ── Auto-expire pings after 90 days (Scale-Safe) ──────────────────────────────
// 90 days * 24h * 60m * 60s = 7,776,000
locationPingSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7776000 });

module.exports = mongoose.model('LocationPing', locationPingSchema);