'use strict';

const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema(
  {
    // The user who owns / generated this referral code
    referrer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Unique 8-character alphanumeric code  e.g. "NVIQ-A3F7"
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },

    // List of users who signed up using this code
    referredUsers: [
      {
        user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        joinedAt:  { type: Date, default: Date.now },
        phone:     { type: String },
      },
    ],

    totalReferrals: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('Referral', referralSchema);