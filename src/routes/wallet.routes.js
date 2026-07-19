const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth, requireApprovedKyc } = require('../middleware/auth');
const ctrl = require('../controllers/wallet.controller');

router.use(requireUserAuth);

router.get('/summary', asyncHandler(ctrl.getSummary));
router.get('/resolve', asyncHandler(ctrl.resolveWallet));
router.post('/resolve-external-account', asyncHandler(ctrl.resolveExternalAccount));

// Money-movement / offline-spend endpoints — gated behind approved KYC, same
// as the equivalent endpoints in transaction.routes.js.
router.post('/offline-token', requireApprovedKyc, asyncHandler(ctrl.issueOfflineToken));
router.post('/offline-sync', requireApprovedKyc, asyncHandler(ctrl.syncOfflineBatch));
router.post('/transfer-to-bank', requireApprovedKyc, asyncHandler(ctrl.transferToBank));

module.exports = router;
