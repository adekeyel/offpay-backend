const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth } = require('../middleware/auth');
const ctrl = require('../controllers/user.controller');

router.use(requireUserAuth);
router.get('/me', asyncHandler(ctrl.getProfile));
router.post('/pin', asyncHandler(ctrl.setTransactionPin));
router.post('/change-password', asyncHandler(ctrl.changePassword));

module.exports = router;
