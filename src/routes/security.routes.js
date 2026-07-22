const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth } = require('../middleware/auth');
const { otpLimiter } = require('../middleware/rateLimiter');
const ctrl = require('../controllers/security.controller');

router.use(requireUserAuth);

router.get('/', asyncHandler(ctrl.getSettings));
router.post('/transfer-protection', asyncHandler(ctrl.updateTransferProtection));
router.post('/biometrics', asyncHandler(ctrl.updateBiometrics));
router.post('/google-2fa/start', asyncHandler(ctrl.startGoogle2fa));
router.post('/google-2fa/confirm', asyncHandler(ctrl.confirmGoogle2fa));
router.post('/google-2fa/disable', asyncHandler(ctrl.disableGoogle2fa));
router.post('/email-2fa', asyncHandler(ctrl.updateEmail2fa));
router.post('/transfer-otp/request', otpLimiter, asyncHandler(ctrl.requestTransferOtp));

module.exports = router;
