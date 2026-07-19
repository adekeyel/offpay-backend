const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth } = require('../middleware/auth');
const ctrl = require('../controllers/vtu.controller');

router.use(requireUserAuth);
router.get('/products/:category', asyncHandler(ctrl.listProducts));
router.post('/purchase', asyncHandler(ctrl.purchase));
router.get('/history', asyncHandler(ctrl.history));

module.exports = router;
