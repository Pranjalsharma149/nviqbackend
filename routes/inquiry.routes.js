'use strict';

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const inquiryController = require('../controllers/inquiry.controller');
const { protect, requireRole } = require('../middleware/auth');

// ── Rate Limiters ─────────────────────────────────────────────────────────────

const leadSubmissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 submissions per window
  message: {
    success: false,
    message: 'Too many inquiries submitted from this IP. Please try again in 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

const clickStreamLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, // Safe threshold to prevent click spam loops
  message: { success: false, message: 'Rate limit reached for session analytics.' },
  standardHeaders: true,
  legacyHeaders: false
});

// ── Public Web Routes (Lead Capture & Tracking) ───────────────────────────────────

// Post inquiries (inquiry types: fleet_inquiry, product_inquiry, contact_us)
router.post('/inquiries', leadSubmissionLimiter, inquiryController.createInquiry);

// Newsletter subscription
router.post('/newsletter', leadSubmissionLimiter, inquiryController.subscribeNewsletter);

// Analytics integration routes
router.post('/analytics/session', clickStreamLimiter, inquiryController.initializeSession);
router.post('/analytics/event', clickStreamLimiter, inquiryController.recordClickEvent);

// ── Admin Dashboard Routes (Protected) ───────────────────────────────────────────

// Retrieve all leads
router.get('/inquiries', protect, requireRole('admin'), inquiryController.getAllInquiries);

// Retrieve detailed lead file with session journey logs
router.get('/inquiries/:inquiryId/journey', protect, requireRole('admin'), inquiryController.getInquiryWithLogs);

module.exports = router;
