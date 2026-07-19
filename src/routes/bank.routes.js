const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const ctrl = require('../controllers/bank.controller');

router.get('/', asyncHandler(ctrl.listBanks));

module.exports = router;
