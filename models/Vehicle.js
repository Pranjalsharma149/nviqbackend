'use strict';

const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema({
  name: {
    type:      String,
    required:  [true, 'Vehicle name is required'],
    trim:      true,
    maxlength: 100,
  },

  vehicleReg: {
    type:      String,
    required:  [true, 'Vehicle registration required'],
    trim:      true,
    unique:    true,
    uppercase: true,
  },

  type: {
    type:    String,
    enum:    ['car','truck','bike','auto','bus','van','ambulance','tractor','unknown'],
    default: 'car',
  },

  imei: {
    type:   String,
    trim:   true,
    unique: true,
    sparse: true,
  },

  protocol: { type: String, default: 'GT06' },

  pocName:    { type: String, trim: true },
  pocContact: { type: String, trim: true },
  driverName:  { type: String, trim: true },
  driverPhone: { type: String, trim: true },

  // ── Live Telemetry ─────────────────────────────────────────────────────────
  // Store in BOTH formats so every part of the codebase finds what it expects.
  // data.processor writes lat/lng + latitude/longitude.
  // vehicleController reads either. Flutter receives both.
  lat:       { type: Number, default: null },   // ✅ ADDED
  lng:       { type: Number, default: null },   // ✅ ADDED
  latitude:  { type: Number, default: null },
  longitude: { type: Number, default: null },
  altitude:  { type: Number, default: 0 },
  speed:     { type: Number, default: 0 },
  heading:   { type: Number, default: 0 },

  fuel:         { type: Number, default: 100 },
  batteryLevel: { type: Number, default: 100 },
  gpsSignal:    { type: Boolean, default: true },

  status: {
    type:    String,
    enum:    ['moving','idle','parked','static','offline','towing','unknown'],
    default: 'idle',
  },

  // ── State ──────────────────────────────────────────────────────────────────
  isLive:   { type: Boolean, default: false },
  isOnline: { type: Boolean, default: false },

  insideGeofences: [{ type: String }],

  // ── Address fields ─────────────────────────────────────────────────────────
  // All three are kept in sync by data.processor and vehicleController so
  // Flutter's _resolveAddress() finds the address no matter which field it checks.
  location:          { type: String, default: null }, // existing field — kept
  address:           { type: String, default: null }, // ✅ ADDED — IOPGPS / Nominatim
  formattedLocation: { type: String, default: null }, // ✅ ADDED — Flutter primary field

  lastUpdate:     { type: Date, default: Date.now },
  lastWanWaySync: { type: Date },
  lastGpsTime:    { type: Date, default: null },      // ✅ ADDED — actual GPS timestamp

  // ── Last Known Good State ──────────────────────────────────────────────────
  lastKnownLocation: {
    latitude:  { type: Number },
    longitude: { type: Number },
    speed:     { type: Number },
    heading:   { type: Number },
    altitude:  { type: Number },
    voltage:   { type: Number },
    odometer:  { type: Number },
    address:   { type: String },   // ✅ already existed — confirmed kept
    timestamp: { type: Date },
  },

  lastOnlineAt:    { type: Date },
  offlineDuration: { type: String, default: null },   // ✅ ADDED — pre-computed label

  // ── Analytics ──────────────────────────────────────────────────────────────
  analytics: {
    todayDistance: { type: Number, default: 0 },
    avgSpeed:      { type: Number, default: 0 },
    totalTrips:    { type: Number, default: 0 },
  },

}, {
  timestamps: true,
  versionKey: false,
});

// ── INDEXES ────────────────────────────────────────────────────────────────
vehicleSchema.index({ isLive: 1, status: 1 });
vehicleSchema.index({ lastUpdate: -1 });
vehicleSchema.index({ lastOnlineAt: -1 });

// ── JSON TRANSFORM ─────────────────────────────────────────────────────────
vehicleSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    ret.id = ret._id?.toString();

    // Always expose both lat/lng AND latitude/longitude
    ret.lat       = ret.lat       ?? ret.latitude  ?? null;
    ret.lng       = ret.lng       ?? ret.longitude ?? null;
    ret.latitude  = ret.latitude  ?? ret.lat       ?? null;
    ret.longitude = ret.longitude ?? ret.lng       ?? null;

    // ✅ Ensure all three address fields are populated in the API response.
    // Whichever field was written by the processor, copy it to the others
    // so Flutter always finds the address regardless of which field it reads.
    const bestAddress =
      ret.formattedLocation ||
      ret.address           ||
      ret.location          ||
      ret.lastKnownLocation?.address ||
      null;

    ret.formattedLocation = bestAddress;
    ret.address           = bestAddress;
    ret.location          = bestAddress;

    // Also inject address into lastKnownLocation so that sub-object is complete
    if (ret.lastKnownLocation && bestAddress) {
      ret.lastKnownLocation.address = bestAddress;
    }

    // ✅ offlineDuration pre-computed so Flutter doesn't have to
    if (!ret.isOnline && ret.lastOnlineAt) {
      const ms           = Date.now() - new Date(ret.lastOnlineAt).getTime();
      const totalMinutes = Math.floor(ms / 60000);
      const days         = Math.floor(totalMinutes / 1440);
      const hours        = Math.floor((totalMinutes % 1440) / 60);
      const minutes      = totalMinutes % 60;

      ret.offlineDuration = days > 0
        ? `${days}d ${hours}h`
        : hours > 0
          ? `${hours}h ${minutes}m`
          : `${minutes}m`;
    } else {
      ret.offlineDuration = null;
    }

    // Driver field aliases
    ret.pocName    = ret.pocName    ?? ret.driverName  ?? null;
    ret.pocContact = ret.pocContact ?? ret.driverPhone ?? null;

    // lastGpsTime alias
    ret.lastGpsTime = ret.lastGpsTime ?? ret.lastKnownLocation?.timestamp ?? null;

    delete ret._id;
    return ret;
  },
});

// ── VIRTUALS ───────────────────────────────────────────────────────────────
vehicleSchema.virtual('isOnlineNow').get(function () {
  return this.lastUpdate && (Date.now() - this.lastUpdate.getTime()) < 5 * 60 * 1000;
});

vehicleSchema.virtual('offlineMs').get(function () {
  if (this.isOnline || !this.lastOnlineAt) return 0;
  return Date.now() - this.lastOnlineAt.getTime();
});

module.exports = mongoose.models.Vehicle || mongoose.model('Vehicle', vehicleSchema);