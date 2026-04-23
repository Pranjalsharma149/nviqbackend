'use strict';

const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Vehicle name is required'],
    trim: true,
    maxlength: 100
  },

  vehicleReg: {
    type: String,
    required: [true, 'Vehicle registration required'],
    trim: true,
    unique: true,
    uppercase: true
  },

  type: {
    type: String,
    enum: ['car','truck','bike','auto','bus','van','ambulance','tractor','unknown'],
    default: 'car'
  },

  imei: {
    type: String,
    trim: true,
    unique: true,
    sparse: true
  },

  protocol: {
    type: String,
    default: 'GT06'
  },

  pocName:    { type: String, trim: true },
  pocContact: { type: String, trim: true },

  // ── Live Telemetry (current/last received values) ──────────────────────────
  latitude:  { type: Number, default: null },
longitude: { type: Number, default: null },
  altitude:  { type: Number, default: 0 },
  speed:     { type: Number, default: 0 },
  heading:   { type: Number, default: 0 },

  fuel:         { type: Number, default: 100 },
  batteryLevel: { type: Number, default: 100 },
  gpsSignal:    { type: Boolean, default: true },

  status: {
    type: String,
    enum: ['moving','idle','parked','static','offline','towing','unknown'],
    default: 'idle'
  },

  // ── State Management ───────────────────────────────────────────────────────
  isLive:   { type: Boolean, default: false },
  isOnline: { type: Boolean, default: false },

  insideGeofences: [{ type: String }],

  location:       { type: String },   // reverse-geocoded address string
  lastUpdate:     { type: Date, default: Date.now },
  lastWanWaySync: { type: Date },

  // ── Last Known Good State ──────────────────────────────────────────────────
  // Only written when device was online AND had a valid GPS fix.
  // Survives offline periods — use this in your UI when isOnline === false.
  lastKnownLocation: {
    latitude:  { type: Number },
    longitude: { type: Number },
    speed:     { type: Number },
    heading:   { type: Number },
    altitude:  { type: Number },
    voltage:   { type: Number },   // e.g. 12.9V from IOP GPS
    odometer:  { type: Number },   // e.g. 2997 KM from IOP GPS
    address:   { type: String },   // reverse-geocoded at time of last ping
    timestamp: { type: Date },     // actual GPS timestamp from device (not server time)
  },

  // When did we last see this device online with valid GPS? (drives "Offline Xh" label)
  lastOnlineAt: { type: Date },

  // ── Analytics ─────────────────────────────────────────────────────────────
  analytics: {
    todayDistance: { type: Number, default: 0 },
    avgSpeed:      { type: Number, default: 0 },
    totalTrips:    { type: Number, default: 0 },
  }

}, {
  timestamps: true,
  versionKey: false,
});

// ── INDEXES ────────────────────────────────────────────────────────────────
vehicleSchema.index({ isLive: 1, status: 1 });
vehicleSchema.index({ lastUpdate: -1 });
vehicleSchema.index({ lastOnlineAt: -1 });  // ← for "offline vehicles" queries

// ── JSON TRANSFORM ─────────────────────────────────────────────────────────
vehicleSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    ret.id  = ret._id.toString();
    ret.lat = ret.latitude;
    ret.lng = ret.longitude;

    // ✅ Convenience: expose offlineDuration in API response automatically
    // Frontend can directly show "Offline 3h 24m" without computing it
    if (!ret.isOnline && ret.lastOnlineAt) {
      const ms = Date.now() - new Date(ret.lastOnlineAt).getTime();
      const totalMinutes = Math.floor(ms / 60000);
      const days    = Math.floor(totalMinutes / 1440);
      const hours   = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;

      ret.offlineDuration = days > 0
        ? `${days}d ${hours}h`
        : hours > 0
          ? `${hours}h ${minutes}m`
          : `${minutes}m`;
    } else {
      ret.offlineDuration = null;
    }

    delete ret._id;
    return ret;
  },
});

// ── VIRTUALS ───────────────────────────────────────────────────────────────
// True real-time check: was the device heard from in the last 5 minutes?
vehicleSchema.virtual('isOnlineNow').get(function () {
  return this.lastUpdate && (Date.now() - this.lastUpdate.getTime()) < 5 * 60 * 1000;
});

// How long since we last saw this device online (in milliseconds)
// Use in backend logic: if (vehicle.offlineMs > 24 * 60 * 60 * 1000) { alert... }
vehicleSchema.virtual('offlineMs').get(function () {
  if (this.isOnline || !this.lastOnlineAt) return 0;
  return Date.now() - this.lastOnlineAt.getTime();
});

module.exports = mongoose.models.Vehicle || mongoose.model('Vehicle', vehicleSchema);