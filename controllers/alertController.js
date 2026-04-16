// controllers/alertController.js
'use strict';

const Alert   = require('../models/Alert');
const Vehicle = require('../models/Vehicle');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/alerts
// ─────────────────────────────────────────────────────────────────────────────
exports.getAlerts = async (req, res) => {
  try {
    const { limit = 50, acknowledged, vehicleId, priority, type, unreadOnly } = req.query;

    const query = {};
    if (acknowledged  !== undefined) query.isAcknowledged = acknowledged === 'true';
    if (vehicleId)                   query.vehicleId      = vehicleId;
    if (priority && ['low','medium','high','critical'].includes(priority)) query.priority = priority;
    if (type)                        query.type           = type;
    if (unreadOnly === 'true')       query.isRead         = false;

    const [alerts, total] = await Promise.all([
      Alert.find(query).sort({ timestamp: -1 }).limit(Math.min(parseInt(limit), 200)).lean(),
      Alert.countDocuments(query),
    ]);

    const data = alerts.map(a => ({
      ...a,
      id:  a._id.toString(),
      lat: a.latitude,
      lng: a.longitude,
    }));

    res.json({ success: true, count: data.length, total, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/alerts/unread-count  ← must be registered BEFORE /:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getUnreadCount = async (req, res) => {
  try {
    const count = await Alert.countDocuments({ isRead: false });
    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/alerts/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getAlertById = async (req, res) => {
  try {
    const alert = await Alert.findById(req.params.id).lean();
    if (!alert) return res.status(404).json({ success: false, message: 'Alert not found' });
    res.json({ success: true, data: { ...alert, id: alert._id.toString() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/alerts/:id/acknowledge
// ─────────────────────────────────────────────────────────────────────────────
exports.acknowledgeAlert = async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(
      req.params.id,
      {
        isAcknowledged: true,
        isRead:         true,
        acknowledgedAt: new Date(),
        acknowledgedBy: req.user._id,
      },
      { new: true }
    );

    if (!alert) return res.status(404).json({ success: false, message: 'Alert not found' });

    if (req.io) {
      req.io.emit('alertAcknowledged', {
        alertId:        alert._id.toString(),
        acknowledgedBy: req.user.name,
        acknowledgedAt: alert.acknowledgedAt,
      });
    }

    res.json({ success: true, message: 'Alert acknowledged', data: { ...alert.toObject(), id: alert.id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/alerts/acknowledge-all  ← must be registered BEFORE /:id
// ─────────────────────────────────────────────────────────────────────────────
exports.acknowledgeAll = async (req, res) => {
  try {
    const result = await Alert.updateMany(
      { isAcknowledged: false },
      { isAcknowledged: true, isRead: true, acknowledgedAt: new Date(), acknowledgedBy: req.user._id }
    );

    if (req.io) {
      req.io.emit('alertsBulkAcknowledged', {
        count:          result.modifiedCount,
        acknowledgedBy: req.user.name,
        acknowledgedAt: new Date(),
      });
    }

    res.json({ success: true, message: `${result.modifiedCount} alerts acknowledged` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/alerts/:id  (admin only)
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteAlert = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admins can delete alerts' });
    }

    const alert = await Alert.findByIdAndDelete(req.params.id);
    if (!alert) return res.status(404).json({ success: false, message: 'Alert not found' });

    if (req.io) req.io.emit('alertDeleted', { alertId: alert._id.toString() });

    res.json({ success: true, message: 'Alert deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/alerts/test  (dev only)
// ─────────────────────────────────────────────────────────────────────────────
exports.createTestAlert = async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ success: false, message: 'Disabled in production' });
    }

    const { vehicleId, type = 'overspeed', priority = 'medium' } = req.body;
    const vehicle = await Vehicle.findById(vehicleId);
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });

    const alert = await Alert.create({
      vehicleId:  vehicle._id,
      vehicleReg: vehicle.vehicleReg,
      title:      `🧪 Test ${type} Alert`,
      message:    `Test alert for ${vehicle.name}`,
      type, priority,
      latitude:   vehicle.latitude,
      longitude:  vehicle.longitude,
      speed:      vehicle.speed,
      timestamp:  new Date(),
    });

    if (req.io) req.io.emit('newAlert', { ...alert.toObject(), id: alert._id.toString() });

    res.status(201).json({ success: true, message: 'Test alert created', data: { ...alert.toObject(), id: alert._id.toString() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};