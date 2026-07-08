const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const upload = require('../middleware/upload');
const { authLimiter, otpLimiter } = require('../middleware/rateLimiter');
const { requireUserAuth } = require('../middleware/auth');
const ctrl = require('../controllers/auth.controller');

router.post('/register', authLimiter, upload.single('passport'), asyncHandler(ctrl.register));
router.post('/verify-email-otp', otpLimiter, asyncHandler(ctrl.verifyEmailOtp));
router.post('/login', authLimiter, asyncHandler(ctrl.login));
router.post('/verify-login-otp', otpLimiter, asyncHandler(ctrl.verifyLoginOtp));
router.post('/refresh', asyncHandler(ctrl.refresh));
router.post('/logout', asyncHandler(ctrl.logout));
router.post('/heartbeat', requireUserAuth, asyncHandler(ctrl.heartbeat));
router.post('/recovery-request', authLimiter, asyncHandler(ctrl.requestRecovery));

module.exports = router;
