// models/Vehicle.js
'use strict';

const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema({
  // ── Identity ──────────────────────────────────────────────────────────────
  name:       { type: String, required: [true, 'Vehicle name is required'], trim: true, maxlength: 100 },
  vehicleReg: { type: String, required: [true, 'Vehicle registration / IMEI required'], trim: true, uppercase: true, unique: true },
  type:       { type: String, enum: ['car','truck','bike','auto','bus','van','ambulance','tractor','unknown'], default: 'car' },

  // ── IMEI / Device ─────────────────────────────────────────────────────────
  imei:     { type: String, trim: true, sparse: true, index: true },
  protocol: { type: String, default: 'GT06' },  // GT06 | NMEA | HTTP

  // ── POC / Driver ─────────────────────────────────────────────────────────
  pocName:    { type: String, trim: true },
  pocContact: { type: String, trim: true },

  // ── GPS Position ──────────────────────────────────────────────────────────
  latitude:  { type: Number, default: 28.6139 },
  longitude: { type: Number, default: 77.2090 },
  altitude:  { type: Number, default: 0 },
  speed:     { type: Number, default: 0, min: 0 },
  heading:   { type: Number, default: 0, min: 0, max: 360 },

  // ── Telemetry ─────────────────────────────────────────────────────────────
  fuel:         { type: Number, default: 100, min: 0, max: 100 },
  batteryLevel: { type: Number, default: 100, min: 0, max: 100 },
  gpsSignal:    { type: Boolean, default: true },

  // ── Status ────────────────────────────────────────────────────────────────
  status:   { type: String, enum: ['moving','idle','parked','offline','towing','unknown'], default: 'idle' },
  isLive:   { type: Boolean, default: false },
  isOnline: { type: Boolean, default: false },
  location: { type: String },  // reverse-geocoded address

  lastUpdate: { type: Date, default: Date.now, index: true },

  // ── Daily analytics (updated by GPS engine) ───────────────────────────────
  analytics: {
    todayDistance: { type: Number, default: 0 },
    avgSpeed:      { type: Number, default: 0 },
    totalTrips:    { type: Number, default: 0 },
  },
}, {
  timestamps: true,
  versionKey: false,
});

// ── Indexes ───────────────────────────────────────────────────────────────────
vehicleSchema.index({ vehicleReg: 1 }, { unique: true });
vehicleSchema.index({ imei: 1 },       { sparse: true });
vehicleSchema.index({ isLive: 1, status: 1 });
vehicleSchema.index({ latitude: 1, longitude: 1 });
vehicleSchema.index({ lastUpdate: -1 });

// ── toJSON — map _id → id ─────────────────────────────────────────────────────
vehicleSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id  = ret._id.toString();
    // Flutter reads lat/lng so add aliases here
    ret.lat = ret.latitude;
    ret.lng = ret.longitude;
    delete ret._id;
    return ret;
  },
});

// ── Virtual: isOnlineNow (within 5 min) ───────────────────────────────────────
vehicleSchema.virtual('isOnlineNow').get(function () {
  return this.lastUpdate && (Date.now() - this.lastUpdate.getTime()) < 5 * 60 * 1000;
});

module.exports = mongoose.model('Vehicle', vehicleSchema);