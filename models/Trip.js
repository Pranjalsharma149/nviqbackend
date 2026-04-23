'use strict';

const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  latitude:  { type: Number },
  longitude: { type: Number },
  address:   { type: String },
}, { _id: false });

const tripSchema = new mongoose.Schema({
  vehicleId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
  imei:       { type: String, index: true },

  startTime:    { type: Date, required: true, index: true },
  endTime:      { type: Date, index: true },
  duration:     { type: Number, default: 0 },   // minutes
  idleTime:     { type: Number, default: 0 },   // minutes spent static during trip

  startLocation: locationSchema,
  endLocation:   locationSchema,

  totalDistance: { type: Number, default: 0 },  // km
  avgSpeed:      { type: Number, default: 0 },  // km/h
  maxSpeed:      { type: Number, default: 0 },

  fuelStart:    { type: Number },
  fuelEnd:      { type: Number },
  fuelConsumed: { type: Number, default: 0 },
  
  isCompleted: { type: Boolean, default: false, index: true },
  
  // Useful for safety scoring (e.g., how many overspeed alerts during this trip)
  alertCount:  { type: Number, default: 0 }
}, {
  timestamps: true,
  versionKey: false,
});

// ── Compound indexes for O(1) Reporting ───────────────────────────────────────
tripSchema.index({ vehicleId: 1, startTime: -1 });
tripSchema.index({ imei: 1, isCompleted: 1 });
tripSchema.index({ isCompleted: 1, startTime: -1 });

// ── Virtual: Fuel Efficiency (L/100km) ────────────────────────────────────────
tripSchema.virtual('efficiency').get(function() {
  if (!this.fuelConsumed || !this.totalDistance) return 0;
  return (this.fuelConsumed / this.totalDistance) * 100;
});

tripSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Trip', tripSchema);