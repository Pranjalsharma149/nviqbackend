'use strict';

const mongoose = require('mongoose');

const geofenceSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, trim: true },

  // ── Geometry ───────────────────────────────────────────────────────────────
  geometry: {
    type:        { type: String, enum: ['Polygon', 'Circle'], required: true },
    coordinates: { type: Array },   // For Polygon: [[lng, lat], [lng, lat]...] (GeoJSON format)
    center:      { latitude: Number, longitude: Number }, // For Circle
    radius:      { type: Number },  // In meters, for Circle
  },

  // ── Targets ────────────────────────────────────────────────────────────────
  // If empty, this geofence applies to the entire fleet (Global Fence)
  vehicleIds: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Vehicle',
    index: true 
  }],

  // ── Settings & Flags ───────────────────────────────────────────────────────
  alertOnEntry: { type: Boolean, default: true },
  alertOnExit:  { type: Boolean, default: true },
  isActive:     { type: Boolean, default: true, index: true },

  // ── Metadata ───────────────────────────────────────────────────────────────
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, {
  timestamps: true,
  versionKey: false,
});

// ── Indexes for Scale ────────────────────────────────────────────────────────
geofenceSchema.index({ isActive: 1 });
geofenceSchema.index({ "geometry.type": 1 });

// ── Virtuals ─────────────────────────────────────────────────────────────────
// Helper to identify "Global" fences without iterating vehicleIds
geofenceSchema.virtual('isGlobal').get(function() {
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