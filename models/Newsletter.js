'use strict';
const mongoose = require('mongoose');

const newsletterSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email address is required'],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
    },
    sessionId: {
      type: String,
      trim: true,
      index: true
    },
    status: {
      type: String,
      enum: ['subscribed', 'unsubscribed'],
      default: 'subscribed',
      index: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// Optimize search queries
newsletterSchema.index({ createdAt: -1 });

module.exports = mongoose.models.Newsletter || mongoose.model('Newsletter', newsletterSchema, 'newsletters');
