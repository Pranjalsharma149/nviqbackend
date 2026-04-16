// routes/alerts.routes.js
'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/alertController');
const { protect } = require('../middleware/auth');

// ✅ CRITICAL: static routes BEFORE /:id — otherwise 'unread-count'
// and 'acknowledge-all' get matched as MongoDB ObjectId params → CastError
router.get('/unread-count',      protect, ctrl.getUnreadCount);
router.put('/acknowledge-all',   protect, ctrl.acknowledgeAll);
router.post('/test',             protect, ctrl.createTestAlert);

router.get('/',     protect, ctrl.getAlerts);
router.get('/:id',  protect, ctrl.getAlertById);
router.put('/:id/acknowledge', protect, ctrl.acknowledgeAlert);
router.delete('/:id',          protect, ctrl.deleteAlert);

module.exports = router;