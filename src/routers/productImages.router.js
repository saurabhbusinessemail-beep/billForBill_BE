'use strict';

const express = require('express');
const { requireSession } = require('../middleware/requireSession');
const controller = require('../controllers/productImages.controller');

const router = express.Router();
router.use(requireSession);
router.get('/:imageId', controller.image);

module.exports = router;
