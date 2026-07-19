const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth, requireApprovedKyc } = require('../middleware/auth');
const ctrl = require('../controllers/card.controller');

router.use(requireUserAuth);
router.get('/mine', asyncHandler(ctrl.getMyCard));
router.post('/', requireApprovedKyc, asyncHandler(ctrl.createCard));
router.post('/:id/status', asyncHandler(ctrl.updateStatus));

module.exports = router;
