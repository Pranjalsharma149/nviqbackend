// routes/notifications.routes.js
//
// API endpoints for Firebase notifications
// POST /api/notifications/register - Register device
// POST /api/notifications/send-alert - Send alert notification (internal only)

'use strict';

const router = require('express').Router();
const notificationService = require('../services/notification.service');
const { protect } = require('../middleware/auth');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notifications/register
// Register device for push notifications (called by app on startup)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/register', protect, async (req, res) => {
  try {
    const { deviceId, fcmToken, platform, appVersion } = req.body;
    const userId = req.user._id || req.user.id;

    // Validate
    if (!deviceId || !fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'deviceId and fcmToken are required',
      });
    }

    logger.info(`📱 Device registration request: ${deviceId}`);

    // Register device
    const result = await notificationService.registerDevice(
      userId,
      fcmToken,
      platform || 'android',
      deviceId
    );

    if (!result) {
      return res.status(500).json({
        success: false,
        message: 'Failed to register device',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Device registered for notifications',
      deviceId: result.deviceId,
    });
  } catch (error) {
    logger.error('Device registration error:', error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notifications/send-alert
// Internal endpoint: Send alert notification
// Called by alert controller when alert is triggered
// ─────────────────────────────────────────────────────────────────────────────

router.post('/send-alert', protect, async (req, res) => {
  try {
    const { userId, alertId, vehicleId, vehicleName, vehicleReg, title, body, priority, type } = req.body;

    // Validate
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required',
      });
    }

    logger.info(`🔔 Sending notification for alert ${alertId} to user ${userId}`);

    // Send notification
    const result = await notificationService.sendAlertNotification(userId, {
      alertId,
      vehicleId,
      vehicleName,
      vehicleReg,
      title: title || 'NVIQ Alert',
      body: body || 'New vehicle alert',
      priority: priority || 'medium',
      type: type || 'alert',
    });

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: result.error || 'Failed to send notification',
      });
    }

    return res.status(200).json({
      success: true,
      message: `Notification sent to ${result.messagesSent} device(s)`,
      messagesSent: result.messagesSent,
      deviceCount: result.deviceCount,
    });
  } catch (error) {
    logger.error('Send notification error:', error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;