const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth } = require('../middleware/auth');
const ctrl = require('../controllers/device.controller');

router.use(requireUserAuth);
router.post('/key', asyncHandler(ctrl.registerDeviceKey));
router.post('/push-token', asyncHandler(ctrl.registerPushToken));

module.exports = router;
