const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { upload, persistUploads } = require('../middleware/upload');
const { authLimiter, otpLimiter } = require('../middleware/rateLimiter');
const { requireUserAuth } = require('../middleware/auth');
const ctrl = require('../controllers/auth.controller');

router.post('/register', authLimiter, upload.single('passport'), persistUploads, asyncHandler(ctrl.register));
router.post('/verify-email-otp', otpLimiter, asyncHandler(ctrl.verifyEmailOtp));
router.post('/login', authLimiter, asyncHandler(ctrl.login));
router.post('/set-app-lock-pin', requireUserAuth, asyncHandler(ctrl.setAppLockPin));
router.post('/unlock', authLimiter, asyncHandler(ctrl.unlock));
router.post('/refresh', asyncHandler(ctrl.refresh));
router.post('/logout', asyncHandler(ctrl.logout));
router.post('/heartbeat', requireUserAuth, asyncHandler(ctrl.heartbeat));
router.post('/recovery-request', authLimiter, asyncHandler(ctrl.requestRecovery));

module.exports = router;
