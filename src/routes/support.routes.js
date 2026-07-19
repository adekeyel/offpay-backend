const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireUserAuth } = require('../middleware/auth');
const ctrl = require('../controllers/support.controller');

router.post('/', requireUserAuth, asyncHandler(ctrl.createTicket));
router.get('/mine', requireUserAuth, asyncHandler(ctrl.myTickets));

module.exports = router;
