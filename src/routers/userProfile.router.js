'use strict';

const express = require('express');
const { requireSession } = require('../middleware/requireSession');
const controller = require('../controllers/userProfile.controller');

const router = express.Router();
router.use(requireSession);
router.get('/', controller.getProfile);
router.post('/addresses', controller.addAddress);
router.put('/addresses/:addressId', controller.updateAddress);
router.delete('/addresses/:addressId', controller.deleteAddress);

module.exports = router;
