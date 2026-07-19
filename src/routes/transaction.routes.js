const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth, requireApprovedKyc } = require('../middleware/auth');
const ctrl = require('../controllers/transaction.controller');

router.use(requireUserAuth);
router.get('/', asyncHandler(ctrl.history));
router.get('/:id/receipt', asyncHandler(ctrl.getReceipt));
router.get('/statement/download', asyncHandler(ctrl.getStatement));
router.post('/send-to-bank', requireApprovedKyc, asyncHandler(ctrl.sendToBank));
router.post('/send-in-app', requireApprovedKyc, asyncHandler(ctrl.sendInApp));
router.post('/simulate-deposit', requireApprovedKyc, asyncHandler(ctrl.simulateExternalDeposit));

module.exports = router;
