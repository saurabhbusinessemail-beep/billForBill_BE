'use strict';
const express = require('express');
const controller = require('../controllers/businessCatalog.controller');
const router = express.Router({ mergeParams: true });
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
const readImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '512000b' });
router.get('/:kind', controller.list);
router.get('/products/barcode-lookup', async (req, res) => {
  const { business } = await require('../services/businessCatalog.service').authorize(req.params.businessId, req.authUserId, 'products', true);
  const currency = require('../services/businessCurrency').businessCurrency(business);
  const data = await require('../services/adminSetup/barcodeLookup').lookup(req.query.gtin, currency);
  res.json({ success: true, data });
});
router.get('/:kind/:id/delete-impact', controller.deleteImpact);
router.get('/:kind/:id', controller.get);
router.post('/:kind', (req, res, next) => req.params.kind === 'products' ? readImage(req, res, next) : next(), controller.create);
router.put('/:kind/:id', (req, res, next) => req.params.kind === 'products' && !req.is('application/json') ? readImage(req, res, next) : next(), controller.update);
router.delete('/:kind/:id', controller.remove);
module.exports = router;
