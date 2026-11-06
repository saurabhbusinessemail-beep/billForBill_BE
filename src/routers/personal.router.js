'use strict';

const express = require('express');
const { requireSession } = require('../middleware/requireSession');
const controller = require('../controllers/personal.controller');

const router = express.Router();
router.use(requireSession, (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
router.get('/dashboard', controller.dashboard);
router.get('/bills/:billId', controller.bill);
router.get('/bills/:billId/files/:fileId', controller.file);

module.exports = router;
