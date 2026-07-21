const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { upload, persistUploads } = require('../middleware/upload');
const { requireUserAuth } = require('../middleware/auth');
const ctrl = require('../controllers/user.controller');
const notificationsCtrl = require('../controllers/userNotifications.controller');

router.use(requireUserAuth);
router.get('/me', asyncHandler(ctrl.getProfile));
router.post('/pin', asyncHandler(ctrl.setTransactionPin));
router.post('/change-password', asyncHandler(ctrl.changePassword));
router.post(
  '/tier-upgrade',
  upload.fields([{ name: 'ninSlip', maxCount: 1 }, { name: 'utilityBill', maxCount: 1 }]),
  persistUploads,
  asyncHandler(ctrl.requestTierUpgrade)
);

router.get('/notifications', asyncHandler(notificationsCtrl.list));
router.get('/notifications/unread-count', asyncHandler(notificationsCtrl.unreadCount));
router.post('/notifications/:id/read', asyncHandler(notificationsCtrl.markRead));
router.post('/notifications/read-all', asyncHandler(notificationsCtrl.markAllRead));

module.exports = router;
