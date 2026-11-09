'use strict';
const express = require('express'); const controller = require('../../controllers/adminSetup/products.controller');
const router = express.Router();
const readImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '512000b' });
router.get('/barcode-lookup', async (req, res) => {
  const data = await require('../../services/adminSetup/barcodeLookup').lookup(req.query.gtin);
  res.setHeader('Cache-Control', 'private, no-store').json({ success: true, data });
});
router.get('/', controller.list); router.get('/:id/delete-impact', controller.deleteImpact); router.get('/:id', controller.get);
router.post('/', readImage, controller.create);
router.put('/:id', (req, res, next) => req.is('application/json') ? next() : readImage(req, res, next), controller.update);
router.delete('/:id', controller.remove);
module.exports = router;
