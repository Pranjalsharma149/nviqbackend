'use strict';
const mongoose = require('mongoose');

const inquirySchema = new mongoose.Schema(
  {
    inquiryType: {
      type: String,
      required: true,
      enum: ['fleet_inquiry', 'product_inquiry', 'contact_us'],
      index: true
    },
    // Common fields
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters']
    },
    email: {
      type: String,
      required: [true, 'Email address is required'],
      trim: true,
      lowercase: true,
      match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
    },
    phoneNumber: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true
    },
    message: {
      type: String,
      trim: true,
      maxlength: [2000, 'Message cannot exceed 2000 characters']
    },

    // Fleet Inquiry specific fields (used in standard inquiry form)
    businessName: {
      type: String,
      trim: true
    },
    numberOfVehicles: {
      type: Number,
      min: [0, 'Number of vehicles cannot be negative']
    },

    // Contact Form specific fields
    fleetSize: {
      type: Number,
      min: [0, 'Fleet size cannot be negative']
    },

    // Product Inquiry specific fields
    productOfInterest: {
      type: String,
      enum: ['gps_fleet_tracking', 'mutual_funds', 'fast_tag_system', 'agriculture_drone', 'general'],
      default: 'general',
      index: true
    },

    // Marketing & Event attribution correlation
    sessionId: {
      type: String,
      required: true,
      index: true
    },
    sourcePage: {
      type: String, // e.g., "/products/agriculture-drone"
      trim: true
    },
    sourceElement: {
      type: String, // e.g., "cta-hero-order-now"
      trim: true
    },

    // Administrative CRM workflow fields
    status: {
      type: String,
      enum: ['new', 'contacted', 'qualified', 'junk', 'closed'],
      default: 'new',
      index: true
    },
    notes: [
      {
        content: String,
        author: String,
        createdAt: { type: Date, default: Date.now }
      }
    ]
  },
  {
    timestamps: true,
    versionKey: false
  }
);

// Optimize search queries
inquirySchema.index({ createdAt: -1 });

module.exports = mongoose.models.Inquiry || mongoose.model('Inquiry', inquirySchema, 'inquiries');
