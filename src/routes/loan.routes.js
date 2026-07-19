const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth, requireApprovedKyc } = require('../middleware/auth');
const ctrl = require('../controllers/loan.controller');

router.use(requireUserAuth);
router.get('/products', asyncHandler(ctrl.listProducts));
router.get('/active', asyncHandler(ctrl.getActiveLoan));
router.post('/request', requireApprovedKyc, asyncHandler(ctrl.requestLoan));
router.post('/repay', requireApprovedKyc, asyncHandler(ctrl.repay));

module.exports = router;
