'use strict';
const mongoose = require('mongoose');

const visitorSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    initialReferrer: {
      type: String,
      default: 'Direct'
    },
    utm: {
      source:   { type: String, trim: true },
      medium:   { type: String, trim: true },
      campaign: { type: String, trim: true },
      term:     { type: String, trim: true },
      content:  { type: String, trim: true }
    },
    deviceInfo: {
      browser:    String,
      os:         String,
      deviceType: String // e.g. "desktop", "mobile", "tablet"
    },
    ipAddressHash: {
      type: String, // SHA256 Hash of IP (for GDPR/privacy compliance)
      index: true
    },
    // TTL index: Automatically prune session records after 90 days
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 90 * 24 * 60 * 60 // 90 days in seconds
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

module.exports = mongoose.models.VisitorSession || mongoose.model('VisitorSession', visitorSessionSchema, 'visitor_sessions');
