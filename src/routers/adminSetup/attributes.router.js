'use strict';
const express = require('express'); const controller = require('../../controllers/adminSetup/attributes.controller');
const router = express.Router();
router.get('/', controller.list); router.post('/', controller.create); router.get('/:id/delete-impact', controller.deleteImpact); router.get('/:id', controller.get); router.put('/:id', controller.update); router.delete('/:id', controller.remove);
module.exports = router;
