'use strict';

const mongoose = require('mongoose');

const tripItemSchema = new mongoose.Schema({
  date: {
    type: String, // e.g., 'YYYY-MM-DD'
    required: true
  },
  startTime: {
    type: String,
    required: true
  },
  endTime: {
    type: String
  },
  tripStart: {
    type: String, // location name / address
    default: ''
  },
  tripEnd: {
    type: String, // location name / address
    default: ''
  },
  duration: {
    type: String, // formatted string, e.g. '45m' or '01:15:00'
    default: '0'
  },
  distance: {
    type: String, // formatted string, e.g. '12.4 km'
    default: '0'
  },
  max_speed: {
    type: String, // formatted string, e.g. '85 km/h'
    default: '0'
  },
  avg_speed: {
    type: String, // formatted string, e.g. '45 km/h'
    default: '0'
  },
  stops: {
    type: Number,
    default: 0
  },
  latlong: {
    lat: { type: String, default: '0.0' },
    long: { type: String, default: '0.0' }
  }
}, { _id: false });

const historySchema = new mongoose.Schema({
  vehicleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
    required: true,
    index: true
  },
  imei: {
    type: String,
    index: true
  },
  date: {
    type: Date, // UTC midnight representing the day of the history
    required: true,
    index: true
  },
  distance: {
    type: Number, // Stored as numeric for aggregation
    default: 0
  },
  running_time: {
    type: Number, // Stored as numeric (minutes) for aggregation
    default: 0
  },
  max_speed: {
    type: Number,
    default: 0
  },
  totalstops: {
    type: Number,
    default: 0
  },
  trips: [tripItemSchema]
}, {
  timestamps: true,
  versionKey: false
});

// Compound index to guarantee only one history log per vehicle per day
historySchema.index({ vehicleId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('History', historySchema);