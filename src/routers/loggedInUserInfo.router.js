'use strict';

const express = require('express');
const { loggedInUserInfo } = require('../controllers/loggedInUserInfo.controller');
const { requireSession } = require('../middleware/requireSession');

const router = express.Router();

router.get('/loggedInUserInfo', requireSession, loggedInUserInfo);

module.exports = router;
