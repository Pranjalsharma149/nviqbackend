'use strict';

const mongoose = require('mongoose');

/**
 * RawGpsLog — PRIMARY SOURCE OF TRUTH
 *
 * Every GPS point from TCP + WanWay + MultiTrack is written here unconditionally.
 * NEVER filter by speed. NEVER skip idle. NEVER overwrite.
 * Analytics are always derived from this collection.
 */
const RawGpsLogSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────────
    imei: {
      type:     String,
      required: true,
      index:    true,
      trim:     true,
    },
    vehicleId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Vehicle',
      required: true,
      index:    true,
    },

    // ── Position ──────────────────────────────────────────────────────────────
    latitude: {
      type:     Number,
      required: true,
    },
    longitude: {
      type:     Number,
      required: true,
    },

    // ── Motion ────────────────────────────────────────────────────────────────
    speed: {
      type:    Number,
      default: 0,
      min:     0,
    },
    heading: {
      type:    Number,
      default: 0,
      min:     0,
      max:     360,
    },

    // ── Engine / Ignition ─────────────────────────────────────────────────────
    ignition: {
      type:    Boolean,
      default: null,   // null = unknown (device didn't report)
    },

    // ── Status ────────────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ['moving', 'idle', 'offline'],
      default: 'idle',
    },

    // ── Source ────────────────────────────────────────────────────────────────
    source: {
      type:     String,
      enum:     ['tcp', 'wanway', 'multitrack'],  // ← UPDATED: added 'multitrack'
      required: true,
    },

    // ── Timestamps ────────────────────────────────────────────────────────────
    gpsTimestamp: {
      type:  Date,
      index: true,
    },
    serverTimestamp: {
      type:    Date,
      default: Date.now,
      index:   true,
    },

    // ── GPS Quality ───────────────────────────────────────────────────────────
    satellites: {
      type:    Number,
      default: 0,
    },
    accuracy: {
      type:    Number,
      default: 0,
    },

    // ── Hardware Data ─────────────────────────────────────────────────────────
    voltage: {
      type:    Number,
      default: null,
    },
    odometer: {
      type:    Number,
      default: null,
    },

    // ── Duplicate Guard ───────────────────────────────────────────────────────
    // Used to quickly reject exact-same points from the same device
    isDuplicate: {
      type:    Boolean,
      default: false,
    },
  },
  {
    timestamps: false,  // We manage our own timestamps above
    versionKey: false,
  }
);

// ── Compound Indexes ──────────────────────────────────────────────────────────
// These two are the primary query patterns for analytics + playback
RawGpsLogSchema.index({ vehicleId: 1, gpsTimestamp: 1 });
RawGpsLogSchema.index({ imei: 1, gpsTimestamp: 1 });
RawGpsLogSchema.index({ vehicleId: 1, serverTimestamp: 1 });
RawGpsLogSchema.index({ source: 1, serverTimestamp: 1 });

// ── Duplicate Detection Index ─────────────────────────────────────────────────
// Allows fast lookup when checking for near-identical points
RawGpsLogSchema.index({ imei: 1, gpsTimestamp: 1, latitude: 1, longitude: 1 });

// ── TTL Index (optional archival) ─────────────────────────────────────────────
// Uncomment to auto-delete raw logs older than 90 days:
// RawGpsLogSchema.index(
//   { serverTimestamp: 1 },
//   { expireAfterSeconds: 90 * 24 * 60 * 60 }
// );

module.exports = mongoose.model('RawGpsLog', RawGpsLogSchema);