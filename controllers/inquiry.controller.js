'use strict';

const crypto = require('crypto');
const Inquiry = require('../models/Inquiry');
const VisitorSession = require('../models/VisitorSession');
const SessionEvent = require('../models/SessionEvent');
const Newsletter = require('../models/Newsletter');
const logger = require('../utils/logger');

// Simple XSS Stripper helper
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>?/gm, '').trim(); // Remove basic HTML tags
}

/**
 * Handle new Inquiry or Contact Us form submission
 */
exports.createInquiry = async (req, res) => {
  try {
    const {
      inquiryType,
      fullName,
      email,
      phoneNumber,
      message,
      businessName,
      numberOfVehicles,
      fleetSize,
      productOfInterest,
      sessionId,
      sourcePage,
      sourceElement,
      // Honeypot field (hidden field that must be empty)
      website
    } = req.body;

    // 1. Honeypot Spam Check
    if (website && website.trim().length > 0) {
      logger.warn(`🤖 Spam bot caught via honeypot! IP: ${req.ip}`);
      // Return fake success to confuse the script bot
      return res.status(201).json({
        success: true,
        message: 'Inquiry submitted successfully'
      });
    }

    // 2. Base Validation
    if (!inquiryType || !['fleet_inquiry', 'product_inquiry', 'contact_us'].includes(inquiryType)) {
      return res.status(400).json({ success: false, message: 'Invalid or missing inquiryType' });
    }
    if (!fullName || !email || !phoneNumber) {
      return res.status(400).json({ success: false, message: 'Full Name, Email, and Phone Number are required fields' });
    }
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'Session attribution parameter (sessionId) is required' });
    }

    // 3. Payload Normalization & XSS Stripping
    const cleanData = {
      inquiryType,
      fullName: sanitizeString(fullName),
      email: sanitizeString(email).toLowerCase(),
      phoneNumber: sanitizeString(phoneNumber),
      message: message ? sanitizeString(message) : '',
      sessionId: sanitizeString(sessionId),
      sourcePage: sourcePage ? sanitizeString(sourcePage) : '',
      sourceElement: sourceElement ? sanitizeString(sourceElement) : '',
      productOfInterest: productOfInterest || 'general',
      userAgent: req.headers['user-agent']
    };

    // Conditional Fields mapping
    if (inquiryType === 'fleet_inquiry') {
      cleanData.businessName = businessName ? sanitizeString(businessName) : 'N/A';
      cleanData.numberOfVehicles = Number(numberOfVehicles) || 0;
    } else if (inquiryType === 'contact_us') {
      cleanData.fleetSize = Number(fleetSize) || 0;
    }

    // 4. Save to MongoDB
    const inquiry = await Inquiry.create(cleanData);
    logger.info(`📧 Lead Captured [${inquiryType}]: ${cleanData.email} (ID: ${inquiry._id})`);

    res.status(201).json({
      success: true,
      message: 'Thank you! Your inquiry has been recorded successfully.',
      inquiryId: inquiry._id
    });

  } catch (err) {
    logger.error(`❌ Error creating inquiry: ${err.message}`);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

/**
 * Initialize visitor tracking session details
 */
exports.initializeSession = async (req, res) => {
  try {
    const { sessionId, initialReferrer, utm, deviceInfo } = req.body;

    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    // Generate IP hash to protect visitor privacy while preventing duplicate logs
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ipAddressHash = crypto.createHash('sha256').update(ipAddress).digest('hex');

    const cleanSessionData = {
      sessionId: sanitizeString(sessionId),
      initialReferrer: initialReferrer ? sanitizeString(initialReferrer) : 'Direct',
      utm: {
        source:   utm?.source ? sanitizeString(utm.source) : '',
        medium:   utm?.medium ? sanitizeString(utm.medium) : '',
        campaign: utm?.campaign ? sanitizeString(utm.campaign) : '',
        term:     utm?.term ? sanitizeString(utm.term) : '',
        content:  utm?.content ? sanitizeString(utm.content) : ''
      },
      deviceInfo: {
        browser:    deviceInfo?.browser ? sanitizeString(deviceInfo.browser) : 'Unknown',
        os:         deviceInfo?.os ? sanitizeString(deviceInfo.os) : 'Unknown',
        deviceType: deviceInfo?.deviceType ? sanitizeString(deviceInfo.deviceType) : 'desktop'
      },
      ipAddressHash
    };

    // Upsert session (in case they reload page, we don't duplicate rows)
    const session = await VisitorSession.findOneAndUpdate(
      { sessionId },
      { $setOnInsert: cleanSessionData },
      { upsert: true, new: true }
    );

    res.status(200).json({ success: true, sessionCreated: session.isNew });

  } catch (err) {
    logger.error(`❌ Error registering session: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to record session' });
  }
};

/**
 * Record a raw anonymous click or interaction event
 */
exports.recordClickEvent = async (req, res) => {
  try {
    const { sessionId, eventType, elementId, elementText, pagePath } = req.body;

    if (!sessionId || !eventType || !pagePath) {
      return res.status(400).json({ success: false, message: 'Missing sessionId, eventType or pagePath' });
    }

    const cleanEventData = {
      sessionId: sanitizeString(sessionId),
      eventType: sanitizeString(eventType),
      elementId: elementId ? sanitizeString(elementId) : '',
      elementText: elementText ? sanitizeString(elementText) : '',
      pagePath: sanitizeString(pagePath)
    };

    await SessionEvent.create(cleanEventData);
    res.status(200).json({ success: true });

  } catch (err) {
    logger.error(`❌ Error recording session event: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to record event log' });
  }
};

/**
 * ADMIN: Get inquiry listings with user clickstream correlations
 */
exports.getInquiryWithLogs = async (req, res) => {
  try {
    const { inquiryId } = req.params;

    const inquiry = await Inquiry.findById(inquiryId).lean();
    if (!inquiry) {
      return res.status(404).json({ success: false, message: 'Inquiry not found' });
    }

    // Correlate with session details
    const sessionMeta = await VisitorSession.findOne({ sessionId: inquiry.sessionId }).lean();

    // Pull last 50 click events prior to submission
    const clickLogs = await SessionEvent.find({ sessionId: inquiry.sessionId })
      .sort({ timestamp: 1 })
      .limit(50)
      .lean();

    res.json({
      success: true,
      data: {
        inquiry,
        session: sessionMeta || null,
        userJourney: clickLogs
      }
    });

  } catch (err) {
    logger.error(`❌ Error fetching journey details: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to load details' });
  }
};

/**
 * ADMIN: Retrieve all inquiries sorted by date
 */
exports.getAllInquiries = async (req, res) => {
  try {
    const inquiries = await Inquiry.find({}).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ success: true, count: inquiries.length, data: inquiries });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Handle new newsletter subscription
 */
exports.subscribeNewsletter = async (req, res) => {
  try {
    const { email, sessionId } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email address is required' });
    }

    const cleanEmail = sanitizeString(email).toLowerCase();

    // Check if they are already subscribed
    const existing = await Newsletter.findOne({ email: cleanEmail });
    if (existing) {
      if (existing.status === 'subscribed') {
        return res.status(200).json({
          success: true,
          message: "You're already subscribed to our launch updates!"
        });
      } else {
        // Resubscribe
        existing.status = 'subscribed';
        if (sessionId) existing.sessionId = sanitizeString(sessionId);
        await existing.save();
        
        logger.info(`📧 Newsletter Resubscription: ${cleanEmail}`);
        return res.status(200).json({
          success: true,
          message: "Thank you! You've been successfully subscribed to our launch updates."
        });
      }
    }

    const newSub = await Newsletter.create({
      email: cleanEmail,
      sessionId: sessionId ? sanitizeString(sessionId) : undefined
    });

    logger.info(`📧 Newsletter Subscription: ${cleanEmail} (ID: ${newSub._id})`);

    res.status(201).json({
      success: true,
      message: "Thank you! You've been successfully subscribed to our launch updates."
    });

  } catch (err) {
    logger.error(`❌ Error subscribing to newsletter: ${err.message}`);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};
