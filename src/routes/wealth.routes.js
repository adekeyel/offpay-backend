const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth, requireApprovedKyc } = require('../middleware/auth');
const ctrl = require('../controllers/wealth.controller');

router.use(requireUserAuth);
router.get('/products', asyncHandler(ctrl.listProducts));
router.get('/accounts', asyncHandler(ctrl.listMyAccounts));
router.post('/accounts', requireApprovedKyc, asyncHandler(ctrl.openAccount));
router.post('/accounts/:id/deposit', requireApprovedKyc, asyncHandler(ctrl.deposit));
router.post('/accounts/:id/withdraw', requireApprovedKyc, asyncHandler(ctrl.withdraw));

module.exports = router;
