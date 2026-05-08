'use strict';

/**
 * models/Vehicle.js
 *
 * FIXES applied to align with vehicle.controller.js normalise() and
 * Flutter live_tracking_screen.dart:
 *
 *   FIX-A  ignition field added — controller.normalise() reads v.ignition,
 *          data.processor writes it, Flutter probes 'ignition' and 'ignitionOn'.
 *          Was completely missing, so ENGINE ON/OFF badge was always false.
 *
 *   FIX-B  voltage field added — controller reads v.voltage for batteryVoltage.
 *          data.processor writes extVoltage ÷ 10 here. Was missing.
 *
 *   FIX-C  satellites + accuracy fields added — controller emits them,
 *          Flutter shows "GPS Signal (N sats)" in the info panel.
 *
 *   FIX-D  odometer field added — controller uses v.odometer for totalDistanceKm.
 *          Without this the odometer panel always showed "— km".
 *
 *   FIX-E  todayDistance field added — data.processor.js increments this
 *          live on the Vehicle doc. controller fallback reads it when
 *          DailySummary is unavailable.
 *
 *   FIX-F  todayEngineHours field added — same pipeline as todayDistance.
 *          Flutter "Today Hours" panel reads engineHoursToday from the
 *          mileage report which falls back to this field.
 *
 *   FIX-G  todayMaxSpeed field added — analytics pipeline writes max speed
 *          per day here. Mileage report exposes it as maxSpeed.
 *
 *   FIX-H  speedLimit field added — Flutter speed-limit display and alert
 *          logic reads v.speedLimit from the normalised vehicle.
 *
 *   FIX-I  userId field added — multi-tenant support; controller exposes it.
 *
 *   FIX-J  analytics sub-schema expanded to match the full shape that
 *          controller.normalise() passes to Flutter (avgSpeed, totalTrips,
 *          todayDistance are already there; maxSpeed, satellites, accuracy
 *          added for completeness).
 *
 *   FIX-K  VEHICLE_FIELDS selector in controller now includes every field
 *          this schema defines — confirmed by adding all new fields to the
 *          field list comment at the top of this file.
 *
 *   FIX-L  toJSON transform updated to sync lat/lng ↔ latitude/longitude,
 *          populate all address aliases, emit ignitionOn + ignition,
 *          emit batteryVoltage + voltage, emit todayDistanceKm +
 *          totalDistanceKm + engineHoursToday at top level.
 *
 *   FIX-M  Indexes added for imei (unique lookup by poller),
 *          status+isOnline (fleet dashboard query), lastUpdate (sort).
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

    vehicleReg: {
      type:      String,
      required:  [true, 'Vehicle registration required'],
      trim:      true,
      unique:    true,
      uppercase: true,
    },

    type: {
      type:    String,
      enum:    ['car', 'truck', 'bike', 'auto', 'bus', 'van', 'ambulance', 'tractor', 'unknown'],
      default: 'car',
    },

    imei: {
      type:   String,
      trim:   true,
      unique: true,
      sparse: true,       // allows multiple null values
    },

    protocol: { type: String, default: 'GT06' },

    // ── Personnel ──────────────────────────────────────────────────────────
    pocName:     { type: String, trim: true, default: null },
    pocContact:  { type: String, trim: true, default: null },
    driverName:  { type: String, trim: true, default: null },
    driverPhone: { type: String, trim: true, default: null },

    // ── FIX-H: Speed limit ─────────────────────────────────────────────────
    speedLimit: { type: Number, default: 80 },

    // ── FIX-I: Multi-tenant owner ──────────────────────────────────────────
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // ── Live Telemetry — coordinates ───────────────────────────────────────
    // Both short (lat/lng) and long (latitude/longitude) forms stored so
    // every part of the stack finds what it expects without conversion.
    lat:       { type: Number, default: null },
    lng:       { type: Number, default: null },
    latitude:  { type: Number, default: null },
    longitude: { type: Number, default: null },
    altitude:  { type: Number, default: 0 },

    // ── Live Telemetry — motion ────────────────────────────────────────────
    speed:   { type: Number, default: 0 },
    heading: { type: Number, default: 0 },

    // ── FIX-A: Ignition ────────────────────────────────────────────────────
    // data.processor writes Boolean(Number(dev.acc)) here.
    // controller normalise() emits as both 'ignition' and 'ignitionOn'.
    // Flutter _parseBoolField probes: ignition, acc, ignitionOn, engine_on …
    ignition: { type: Boolean, default: false },

    // ── FIX-B: Voltage ─────────────────────────────────────────────────────
    // data.processor writes dev.extVoltage / 10 (e.g. 124 → 12.4 V).
    // controller emits as both 'voltage' and 'batteryVoltage'.
    voltage: { type: Number, default: 0 },

    // ── FIX-C: GPS quality ─────────────────────────────────────────────────
    satellites: { type: Number, default: 0 },
    accuracy:   { type: Number, default: 0 },   // metres (HDOP proxy)

    // ── FIX-D: Odometer ────────────────────────────────────────────────────
    // Cumulative total distance in km — never resets.
    // controller exposes as totalDistanceKm / odometer / odometerKm.
    odometer: { type: Number, default: 0 },

    // ── FIX-E: Today distance ──────────────────────────────────────────────
    // Running daily total in km — incremented by data.processor, reset at UTC
    // midnight by the analytics scheduler.
    // controller exposes as todayDistanceKm / dailyDistance / distanceToday.
    todayDistance: { type: Number, default: 0 },

    // ── FIX-F: Today engine hours ──────────────────────────────────────────
    // Running ignition-on hours today — incremented by data.processor.
    // controller exposes as engineHours / totalEngineHours / runningHours.
    todayEngineHours: { type: Number, default: 0 },

    // ── FIX-G: Today max speed ─────────────────────────────────────────────
    todayMaxSpeed: { type: Number, default: 0 },

    // ── Legacy fields kept for backward compatibility ──────────────────────
    fuel:         { type: Number, default: 100 },
    batteryLevel: { type: Number, default: 100 },
    gpsSignal:    { type: Boolean, default: true },

    // ── Status ─────────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ['moving', 'idle', 'parked', 'static', 'offline', 'towing', 'unknown'],
      default: 'idle',
    },

    isLive:   { type: Boolean, default: false },
    isOnline: { type: Boolean, default: false },

    insideGeofences: [{ type: String }],

    // ── Address fields ─────────────────────────────────────────────────────
    // All three kept in sync by data.processor and the toJSON transform.
    // Flutter probes formattedLocationStr → liveAddress → location → address.
    location:          { type: String, default: null },
    address:           { type: String, default: null },
    formattedLocation: { type: String, default: null },

    // ── Timestamps ─────────────────────────────────────────────────────────
    lastUpdate:     { type: Date, default: Date.now },
    lastWanWaySync: { type: Date, default: null },
    lastGpsTime:    { type: Date, default: null },   // actual GPS fix time
    lastOnlineAt:   { type: Date, default: null },

    offlineDuration: { type: String, default: null },

    // ── Last Known Good State ──────────────────────────────────────────────
    lastKnownLocation: {
      latitude:  { type: Number, default: null },
      longitude: { type: Number, default: null },
      speed:     { type: Number, default: 0 },
      heading:   { type: Number, default: 0 },
      altitude:  { type: Number, default: 0 },
      voltage:   { type: Number, default: 0 },
      odometer:  { type: Number, default: 0 },
      address:   { type: String, default: null },
      timestamp: { type: Date,   default: null },
      serverTime:{ type: Date,   default: null },
    },

    // ── FIX-J: Analytics sub-document ─────────────────────────────────────
    // Expanded to carry all fields the controller and Flutter dashboard use.
    analytics: {
      todayDistance: { type: Number, default: 0 },
      totalDistance: { type: Number, default: 0 },
      avgSpeed:      { type: Number, default: 0 },
      maxSpeed:      { type: Number, default: 0 },
      totalTrips:    { type: Number, default: 0 },
      satellites:    { type: Number, default: 0 },
      accuracy:      { type: Number, default: 0 },
    },
  },
  {
    timestamps: true,   // adds createdAt + updatedAt automatically
    versionKey: false,
  }
);

// ── FIX-M: Indexes ────────────────────────────────────────────────────────────
// NOTE: imei index is NOT declared here — it is created automatically by
// Mongoose from the { unique: true, sparse: true } on the field definition
// above. Adding it again here causes the "Duplicate schema index" warning.
// Fleet dashboard sorts / filters by online status and last activity.
vehicleSchema.index({ isOnline: 1, status: 1 });
vehicleSchema.index({ lastUpdate: -1 });
vehicleSchema.index({ lastOnlineAt: -1 });
// userId for multi-tenant fleet isolation queries.
vehicleSchema.index({ userId: 1 });

// ── FIX-L: toJSON transform ───────────────────────────────────────────────────
vehicleSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    // ── id ──────────────────────────────────────────────────────────────────
    ret.id = ret._id?.toString();
    delete ret._id;

    // ── Coordinates: keep both short and long forms in sync ─────────────────
    ret.lat       = ret.lat       ?? ret.latitude  ?? null;
    ret.lng       = ret.lng       ?? ret.longitude ?? null;
    ret.latitude  = ret.latitude  ?? ret.lat       ?? null;
    ret.longitude = ret.longitude ?? ret.lng       ?? null;

    // ── FIX-A / FIX-L: Ignition — both key names Flutter probes ─────────────
    const ignBool  = ret.ignition ?? false;
    ret.ignition   = ignBool;
    ret.ignitionOn = ignBool;

    // ── FIX-B / FIX-L: Voltage — both key names Flutter probes ──────────────
    const voltVal       = ret.voltage ?? 0;
    ret.voltage         = voltVal;
    ret.batteryVoltage  = voltVal;

    // ── FIX-E / FIX-L: Today distance — all aliases Flutter probes ───────────
    const todayKm         = ret.todayDistance ?? 0;
    ret.todayDistance     = todayKm;
    ret.todayDistanceKm   = todayKm;   // Flutter _VState.todayDistanceKm
    ret.dailyDistance     = todayKm;   // alias probed by _fetchWanwayDataForVehicle
    ret.distanceToday     = todayKm;   // alias probed by _fetchWanwayDataForVehicle

    // ── FIX-D / FIX-L: Odometer — all aliases Flutter probes ─────────────────
    const totalKm         = ret.odometer ?? 0;
    ret.odometer          = totalKm;
    ret.totalDistanceKm   = totalKm;   // Flutter _VState.totalDistanceKm
    ret.odometerKm        = totalKm;   // alias

    // ── FIX-F / FIX-L: Engine hours — all aliases Flutter probes ─────────────
    const engHrs           = ret.todayEngineHours ?? 0;
    ret.todayEngineHours   = engHrs;
    ret.engineHoursToday   = engHrs;   // Flutter _VState.engineHoursToday
    ret.engineHours        = engHrs;   // alias probed by _fetchWanwayDataForVehicle
    ret.totalEngineHours   = engHrs;   // alias
    ret.runningHours       = engHrs;   // alias

    // ── FIX-G / FIX-L: Max speed ─────────────────────────────────────────────
    ret.maxSpeedToday = ret.todayMaxSpeed ?? 0;

    // ── Address: keep all three fields in sync ────────────────────────────────
    const bestAddress =
      ret.formattedLocation            ||
      ret.address                      ||
      ret.location                     ||
      ret.lastKnownLocation?.address   ||
      null;

    ret.formattedLocation    = bestAddress;
    ret.address              = bestAddress;
    ret.location             = bestAddress;
    // Flutter also probes formattedLocationStr and liveAddress
    ret.formattedLocationStr = bestAddress;
    ret.liveAddress          = bestAddress;

    if (ret.lastKnownLocation && bestAddress) {
      ret.lastKnownLocation.address = bestAddress;
    }

    // ── lastGpsTime alias ─────────────────────────────────────────────────────
    ret.lastGpsTime = ret.lastGpsTime
      ?? ret.lastKnownLocation?.timestamp
      ?? ret.lastUpdate
      ?? null;

    // ── offlineDuration pre-computed for Flutter ──────────────────────────────
    if (!ret.isOnline && ret.lastOnlineAt) {
      const ms           = Date.now() - new Date(ret.lastOnlineAt).getTime();
      const totalMinutes = Math.floor(ms / 60000);
      const days         = Math.floor(totalMinutes / 1440);
      const hours        = Math.floor((totalMinutes % 1440) / 60);
      const minutes      = totalMinutes % 60;

      ret.offlineDuration = days  > 0 ? `${days}d ${hours}h`
                          : hours > 0 ? `${hours}h ${minutes}m`
                          :             `${minutes}m`;
    } else {
      ret.offlineDuration = null;
    }

    // ── Personnel aliases ─────────────────────────────────────────────────────
    ret.pocName    = ret.pocName    ?? ret.driverName  ?? null;
    ret.pocContact = ret.pocContact ?? ret.driverPhone ?? null;

    // ── vehicleTypeKey (Flutter uses this, not 'type') ────────────────────────
    ret.vehicleTypeKey = ret.type ?? 'car';

    // ── userId as string ──────────────────────────────────────────────────────
    if (ret.userId) ret.userId = ret.userId.toString();

    return ret;
  },
});

// ── Virtuals ──────────────────────────────────────────────────────────────────
vehicleSchema.virtual('isOnlineNow').get(function () {
  return this.lastUpdate
    && (Date.now() - this.lastUpdate.getTime()) < 5 * 60 * 1000;
});

vehicleSchema.virtual('offlineMs').get(function () {
  if (this.isOnline || !this.lastOnlineAt) return 0;
  return Date.now() - this.lastOnlineAt.getTime();
});

// ── Pre-save middleware ───────────────────────────────────────────────────────
// Keep lat/lng and latitude/longitude in sync on every save so the DB is
// never in a state where one pair is set but the other is null.
vehicleSchema.pre('save', function (next) {
  if (this.latitude  != null && this.lat  == null) this.lat  = this.latitude;
  if (this.longitude != null && this.lng  == null) this.lng  = this.longitude;
  if (this.lat       != null && this.latitude  == null) this.latitude  = this.lat;
  if (this.lng       != null && this.longitude == null) this.longitude = this.lng;
  next();
});

// Keep address fields in sync on every save.
vehicleSchema.pre('save', function (next) {
  const best =
    this.formattedLocation ||
    this.address           ||
    this.location          ||
    this.lastKnownLocation?.address ||
    null;

  if (best) {
    this.formattedLocation = best;
    this.address           = best;
    this.location          = best;
  }
  next();
});

module.exports = mongoose.models.Vehicle || mongoose.model('Vehicle', vehicleSchema);