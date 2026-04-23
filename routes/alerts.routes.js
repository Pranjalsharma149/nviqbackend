'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/alertController');
const { protect, requireRole } = require('../middleware/auth');

// ── Static Routes (Precedence Matters!) ──────────────────────────────────────
// These must be defined before /:id to prevent routing conflicts
router.get('/unread-count',    protect, ctrl.getUnreadCount);
router.put('/acknowledge-all', protect, ctrl.acknowledgeAll);

// ── Admin-Only Maintenance ───────────────────────────────────────────────────
router.delete('/purge-old',    protect, requireRole('admin'), ctrl.purgeOldAlerts);

// ── Development & Testing ───────────────────────────────────────────────────
router.post('/test',           protect, ctrl.createTestAlert);

// ── Resource CRUD ────────────────────────────────────────────────────────────
router.get('/',      protect, ctrl.getAlerts);
router.get('/:id',   protect, ctrl.getAlertById);

router.put('/:id/acknowledge', protect, ctrl.acknowledgeAlert);

// Note: requireRole('admin') added here to prevent accidental data loss by staff
router.delete('/:id',          protect, requireRole('admin'), ctrl.deleteAlert);

module.exports = router;