// models/Geofence.js
'use strict';

const mongoose = require('mongoose');

const geofenceSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, trim: true },

  // GeoJSON polygon for geospatial queries
  geometry: {
    type:        { type: String, enum: ['Polygon','Circle'], required: true },
    coordinates: { type: Array },   // GeoJSON coordinates for Polygon
    center:      { latitude: Number, longitude: Number },  // for Circle
    radius:      { type: Number },  // metres, for Circle
  },

  // Which vehicles this geofence applies to (empty = all vehicles)
  vehicleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' }],

  alertOnEntry: { type: Boolean, default: true },
  alertOnExit:  { type: Boolean, default: true },
  isActive:     { type: Boolean, default: true, index: true },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, {
  timestamps: true,
  versionKey: false,
});

geofenceSchema.index({ isActive: 1 });

geofenceSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Geofence', geofenceSchema);