// services/notification.service.js
//
// Firebase Push Notification Service for NVIQ
// Sends push notifications when alerts are triggered
//
// Usage:
// const notificationService = require('./services/notification.service');
// await notificationService.sendAlertNotification(userId, alertData);

'use strict';

const admin = require('firebase-admin');
const Device = require('../models/Device');
const logger = require('../utils/logger');

class NotificationService {
  /**
   * Send alert notification to user's devices
   * 
   * @param {String} userId - User ID
   * @param {Object} alertData - Alert information
   *   {
   *     alertId: "alert-123",
   *     vehicleId: "vehicle-456",
   *     vehicleName: "Swift",
   *     vehicleReg: "MH-02-AB-1234",
   *     title: "Overspeed Alert",
   *     body: "Vehicle exceeded 80 km/h",
   *     priority: "high",
   *     type: "overspeed",
   *   }
   */
  static async sendAlertNotification(userId, alertData) {
    try {
      if (!userId) {
        logger.warn('⚠️  sendAlertNotification: userId is required');
        return null;
      }

      logger.debug(`📱 Sending notification for alert: ${alertData.alertId}`);

      // Get all devices for this user
      const devices = await Device.find({ userId }).select('fcmToken platform');

      if (!devices || devices.length === 0) {
        logger.info(`⚠️  No devices found for user ${userId}`);
        return { success: true, messagesSent: 0, reason: 'No devices registered' };
      }

      const tokens = devices.map(d => d.fcmToken).filter(Boolean);

      if (tokens.length === 0) {
        logger.warn(`⚠️  No valid FCM tokens for user ${userId}`);
        return { success: true, messagesSent: 0, reason: 'No valid tokens' };
      }

      logger.info(`📱 Found ${tokens.length} devices for user ${userId}`);

      // Build notification message
      const message = {
        notification: {
          title: alertData.title || 'NVIQ Alert',
          body: alertData.body || 'New vehicle alert',
        },
        data: {
          alertId: alertData.alertId || '',
          vehicleId: alertData.vehicleId || '',
          vehicleName: alertData.vehicleName || '',
          vehicleReg: alertData.vehicleReg || '',
          priority: alertData.priority || 'medium',
          type: alertData.type || 'alert',
          timestamp: new Date().toISOString(),
        },
        android: {
          priority: this._getPriority(alertData.priority),
          ttl: 86400, // 24 hours
        },
        apns: {
          headers: {
            'apns-priority': '10',
          },
          payload: {
            aps: {
              sound: 'default',
              badge: '1',
            },
          },
        },
      };

      // Send to all devices
      const response = await admin.messaging().sendMulticast({
        tokens,
        ...message,
      });

      logger.info(
        `✅ Notification sent: ${response.successCount} success, ${response.failureCount} failed`
      );

      // Clean up invalid tokens
      if (response.failureCount > 0) {
        await this._cleanupInvalidTokens(devices, response.responses);
      }

      return {
        success: true,
        messagesSent: response.successCount,
        deviceCount: tokens.length,
        failed: response.failureCount,
      };
    } catch (error) {
      logger.error(`❌ Error sending notification: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Register device FCM token
   * Call this when app starts or user logs in
   *
   * @param {String} userId - User ID
   * @param {String} fcmToken - Firebase Cloud Messaging token
   * @param {String} platform - 'android' or 'ios'
   * @param {String} deviceId - Unique device identifier
   */
  static async registerDevice(userId, fcmToken, platform, deviceId) {
    try {
      if (!userId || !fcmToken) {
        logger.warn('⚠️  registerDevice: userId and fcmToken are required');
        return null;
      }

      logger.debug(`📱 Registering device for user ${userId}`);

      // Find or create device
      let device = await Device.findOne({ userId, deviceId });

      if (device) {
        // Update existing device
        device.fcmToken = fcmToken;
        device.platform = platform || 'android';
        device.lastUpdated = new Date();
        await device.save();
        logger.info(`✅ Device updated: ${deviceId}`);
      } else {
        // Create new device
        device = new Device({
          userId,
          deviceId,
          fcmToken,
          platform: platform || 'android',
          registeredAt: new Date(),
          lastUpdated: new Date(),
        });
        await device.save();
        logger.info(`✅ Device registered: ${deviceId} for user ${userId}`);
      }

      return {
        success: true,
        message: 'Device registered',
        deviceId: device._id,
      };
    } catch (error) {
      logger.error(`❌ Error registering device: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Unregister device (called on logout)
   */
  static async unregisterDevice(userId, deviceId) {
    try {
      const result = await Device.deleteOne({ userId, deviceId });
      logger.info(`🗑️  Device unregistered: ${deviceId}`);
      return { success: true };
    } catch (error) {
      logger.error(`❌ Error unregistering device: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get priority for Android/iOS
   */
  static _getPriority(priority) {
    const priorityMap = {
      critical: 'high',
      high: 'high',
      medium: 'normal',
      low: 'normal',
    };
    return priorityMap[priority?.toLowerCase()] || 'normal';
  }

  /**
   * Remove invalid tokens from database
   */
  static async _cleanupInvalidTokens(devices, responses) {
    try {
      for (let i = 0; i < responses.length; i++) {
        if (!responses[i].success) {
          const errorCode = responses[i].error?.code;
          // Only delete if token is permanently invalid
          if (errorCode === 'messaging/invalid-registration-token' ||
              errorCode === 'messaging/registration-token-not-registered') {
            logger.warn(`🗑️  Removing invalid token for device ${devices[i]._id}`);
            await Device.deleteOne({ _id: devices[i]._id });
          }
        }
      }
    } catch (error) {
      logger.warn(`Could not cleanup tokens: ${error.message}`);
    }
  }
}

module.exports = NotificationService;