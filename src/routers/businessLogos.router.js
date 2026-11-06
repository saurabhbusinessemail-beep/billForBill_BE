'use strict';

const express = require('express');
const { putBusinessLogo, sendBusinessLogo, removeBusinessLogo } = require('../controllers/businessLogos.controller');
const { requireSession } = require('../middleware/requireSession');

const router = express.Router();
const readImageBody = express.raw({
  type: ['image/jpeg', 'image/png', 'image/webp'],
  limit: '1mb',
});

router.put('/:businessId/logo', requireSession, readImageBody, putBusinessLogo);
router.get('/:businessId/logo', requireSession, sendBusinessLogo);
router.delete('/:businessId/logo', requireSession, removeBusinessLogo);

module.exports = router;
