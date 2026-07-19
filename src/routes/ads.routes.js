const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const ctrl = require('../controllers/ads.controller');

router.get('/', asyncHandler(ctrl.getForSlot));

module.exports = router;
