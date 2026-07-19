const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth, requireApprovedKyc } = require('../middleware/auth');
const ctrl = require('../controllers/offlineVoucher.controller');

router.use(requireUserAuth);
router.post('/incoming', asyncHandler(ctrl.reportIncoming));
router.post('/voucher', requireApprovedKyc, asyncHandler(ctrl.syncVoucher));
router.get('/history', asyncHandler(ctrl.history));

module.exports = router;
