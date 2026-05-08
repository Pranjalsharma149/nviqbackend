'use strict';

const mongoose = require('mongoose');

/**
 * LocationPing — one GPS fix persisted by PersistentSyncService.recordGPSFixWithOdometer()
 *
 * This model is required by TripPlaybackController. If your project already
 * has an equivalent model under a different name (e.g. GpsRecord, GPSFix),
 * update the require() in TripPlaybackController.js to point at that file.
 */
const locationPingSchema = new mongoose.Schema({
  vehicleId:        { type: String, required: true, index: true },
  imei:             { type: String, index: true },

  latitude:         { type: Number, required: true },
  longitude:        { type: Number, required: true },
  speed:            { type: Number, default: 0 },      // km/h
  heading:          { type: Number, default: 0 },      // degrees
  altitude:         { type: Number, default: 0 },      // metres
  accuracy:         { type: Number, default: 0 },      // metres (GPS HDOP)
  satellites:       { type: Number, default: 0 },

  batteryVoltage:   { type: Number, default: 0 },      // volts
  ignitionOn:       { type: Boolean, default: false },

  // Primary time field — always use this for queries and sorting
  gpsTime:          { type: Date, required: true, index: true },
  deviceTime:       { type: Date },                    // server-receive time

  address:          { type: String },                  // reverse-geocoded string

  // Running totals at the moment of this fix (populated by PersistentSyncService)
  serverOdometerKm: { type: Number, default: 0 },      // cumulative odometer
  todayDistance:    { type: Number, default: 0 },      // distance today in km
  engineHours:      { type: Number, default: 0 },      // engine-on hours today

  source:           { type: String, default: 'wanway' },
}, {
  timestamps: true,
  versionKey: false,
  collection: 'locationpings',
});

// Compound indexes for the queries in TripPlaybackController
locationPingSchema.index({ vehicleId: 1, gpsTime: -1 });
locationPingSchema.index({ imei: 1, gpsTime: -1 });

module.exports = mongoose.model('LocationPing', locationPingSchema);