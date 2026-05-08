'use strict';

const mongoose = require('mongoose');

const geofenceSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, trim: true },

  // ── Geometry ───────────────────────────────────────────────────────────────
  geometry: {
    type:        { type: String, enum: ['Polygon', 'Circle'], required: true },
    coordinates: { type: Array },
    center:      { latitude: Number, longitude: Number },
    radius:      { type: Number },
  },

  // ── Targets ────────────────────────────────────────────────────────────────
  vehicleIds: [{
    type:  mongoose.Schema.Types.ObjectId,
    ref:   'Vehicle',
    index: true,
  }],

  // ── Settings & Flags ───────────────────────────────────────────────────────
  alertOnEntry: { type: Boolean, default: true },
  alertOnExit:  { type: Boolean, default: true },

  // FIX: removed index: true — geofenceSchema.index({ isActive: 1 }) below
  // already creates this index. Both together = duplicate warning.
  isActive: { type: Boolean, default: true },

  // ── Metadata ───────────────────────────────────────────────────────────────
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, {
  timestamps: true,
  versionKey: false,
});

// ── Indexes ───────────────────────────────────────────────────────────────────
// FIX: this is the ONLY index on isActive — field-level index: true removed above
geofenceSchema.index({ isActive: 1 });
geofenceSchema.index({ 'geometry.type': 1 });

// ── Virtuals ──────────────────────────────────────────────────────────────────
geofenceSchema.virtual('isGlobal').get(function () {
  return !this.vehicleIds || this.vehicleIds.length === 0;
});

geofenceSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Geofence', geofenceSchema);