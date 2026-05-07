'use strict';

const mongoose = require('mongoose');

/**
 * DailySummary — Pre-computed daily analytics per vehicle.
 *
 * Generated nightly by the cron job (cron/dailySummary.job.js).
 * Used by /api/analytics/daily for fast reads without scanning RawGpsLog.
 *
 * The cron job REPLACES (upserts) today's summary every night, so
 * figures are always accurate to the end of the previous day.
 * For the CURRENT day, the analytics route falls back to computing
 * from RawGpsLog directly.
 */
const DailySummarySchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────────
    vehicleId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Vehicle',
      required: true,
    },
    imei: {
      type:  String,
      index: true,
    },

    // ── Date (stored as UTC midnight, e.g. 2025-07-15T00:00:00.000Z) ─────────
    date: {
      type:     Date,
      required: true,
    },

    // ── Distance ──────────────────────────────────────────────────────────────
    totalDistance: {
      type:    Number,   // kilometres, 3 decimal places
      default: 0,
    },

    // ── Time Buckets (seconds) ────────────────────────────────────────────────
    engineOnSeconds: {
      type:    Number,   // ignition ON (moving + idle combined)
      default: 0,
    },
    runningSeconds: {
      type:    Number,   // speed > 5 km/h
      default: 0,
    },
    idleSeconds: {
      type:    Number,   // speed = 0 AND ignition ON
      default: 0,
    },

    // ── Derived (stored for quick UI display) ─────────────────────────────────
    engineHours: {
      type:    Number,   // engineOnSeconds / 3600
      default: 0,
    },
    runningHours: {
      type:    Number,
      default: 0,
    },
    idleHours: {
      type:    Number,
      default: 0,
    },

    // ── Speed ─────────────────────────────────────────────────────────────────
    maxSpeed: {
      type:    Number,
      default: 0,
    },
    avgSpeed: {
      type:    Number,
      default: 0,
    },

    // ── Trip Count ────────────────────────────────────────────────────────────
    tripCount: {
      type:    Number,
      default: 0,
    },

    // ── Point Count (diagnostic) ──────────────────────────────────────────────
    rawPointCount: {
      type:    Number,
      default: 0,
    },

    // ── Metadata ──────────────────────────────────────────────────────────────
    generatedAt: {
      type:    Date,
      default: Date.now,
    },
    isPartial: {
      // true = this is today's live summary (may be updated intra-day)
      type:    Boolean,
      default: false,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
DailySummarySchema.index({ vehicleId: 1, date: -1 });
DailySummarySchema.index({ imei: 1,     date: -1 });

// Enforce one summary per vehicle per day
DailySummarySchema.index({ vehicleId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailySummary', DailySummarySchema);