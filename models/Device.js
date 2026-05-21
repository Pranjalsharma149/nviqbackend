// models/Device.js
//
// Stores registered devices and their FCM tokens
// Used for Firebase push notifications

'use strict';

const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  // Unique device identifier (UUID or similar)
  deviceId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // Firebase Cloud Messaging token
  fcmToken: {
    type: String,
    required: true,
    index: true,
  },

  // Platform: 'android' or 'ios'
  platform: {
    type: String,
    enum: ['android', 'ios'],
    default: 'android',
  },

  // App version (for analytics)
  appVersion: String,

  // Device info (optional)
  deviceName: String,
  deviceModel: String,

  // Timestamps
  registeredAt: {
    type: Date,
    default: Date.now,
  },

  lastUpdated: {
    type: Date,
    default: Date.now,
  },

  // Token validity
  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
}, {
  versionKey: false,
});

// Compound indexes
deviceSchema.index({ userId: 1, isActive: 1 });
deviceSchema.index({ userId: 1, platform: 1 });

module.exports = mongoose.model('Device', deviceSchema);