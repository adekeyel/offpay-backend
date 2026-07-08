const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth, requireApprovedKyc } = require('../middleware/auth');
const ctrl = require('../controllers/wallet.controller');

router.use(requireUserAuth);
router.get('/summary', asyncHandler(ctrl.getSummary));
router.get('/resolve', asyncHandler(ctrl.resolveWallet));
router.post('/offline-token', requireApprovedKyc, asyncHandler(ctrl.issueOfflineToken));
router.post('/offline-sync', requireApprovedKyc, asyncHandler(ctrl.syncOfflineBatch));

module.exports = router;
