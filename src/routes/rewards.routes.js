const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth } = require('../middleware/auth');
const ctrl = require('../controllers/rewards.controller');

router.use(requireUserAuth);
router.get('/summary', asyncHandler(ctrl.getSummary));

module.exports = router;
