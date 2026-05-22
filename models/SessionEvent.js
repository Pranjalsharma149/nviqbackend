'use strict';
const mongoose = require('mongoose');

const sessionEventSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      index: true
    },
    eventType: {
      type: String,
      enum: ['click', 'page_view', 'form_view', 'form_submit'],
      required: true,
      index: true
    },
    elementId: {
      type: String, // HTML ID attribute clicked (e.g. "btn-mutual-funds")
      trim: true
    },
    elementText: {
      type: String, // Label or text value of button
      trim: true
    },
    pagePath: {
      type: String, // e.g., "/products/fasttag"
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    // TTL index: Automatically delete click logs after 30 days to avoid performance lag
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 30 * 24 * 60 * 60 // 30 days in seconds
    }
  },
  {
    versionKey: false
  }
);

// Compound index to quickly pull historical journeys for a specific session
sessionEventSchema.index({ sessionId: 1, timestamp: 1 });

module.exports = mongoose.models.SessionEvent || mongoose.model('SessionEvent', sessionEventSchema, 'session_events');
