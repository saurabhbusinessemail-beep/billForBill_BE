'use strict';

const express = require('express');
const { requestPhoneOtp, verifyPhoneOtp, logoutUser } = require('../controllers/auth.controller');
const { requireSession } = require('../middleware/requireSession');

const router = express.Router();

router.post('/phone', requestPhoneOtp);
router.post('/otp/verify', verifyPhoneOtp);
router.post('/logout', requireSession, logoutUser);

module.exports = router;
