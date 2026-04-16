// models/Trip.js
'use strict';

const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  latitude:  { type: Number },
  longitude: { type: Number },
  address:   { type: String },
}, { _id: false });

const tripSchema = new mongoose.Schema({
  vehicleId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },

  startTime:    { type: Date, required: true },
  endTime:      { type: Date },
  duration:     { type: Number, default: 0 },   // minutes

  startLocation: locationSchema,
  endLocation:   locationSchema,

  totalDistance: { type: Number, default: 0 },  // km
  avgSpeed:      { type: Number, default: 0 },  // km/h
  maxSpeed:      { type: Number, default: 0 },

  fuelStart:    { type: Number },
  fuelEnd:      { type: Number },
  fuelConsumed: { type: Number, default: 0 },
  efficiency:   { type: Number, default: 0 },   // km/litre

  isCompleted: { type: Boolean, default: false, index: true },
}, {
  timestamps: true,
  versionKey: false,
});

tripSchema.index({ vehicleId: 1, startTime: -1 });
tripSchema.index({ vehicleId: 1, isCompleted: 1 });

tripSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Trip', tripSchema);