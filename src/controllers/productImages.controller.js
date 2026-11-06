'use strict';

const service = require('../services/productImages.service');

module.exports = {
  image: async (req, res) => {
    const businessId = req.get('X-Catalog-Business-Id') || null;
    const image = await service.getForProduct(req.authUserId, req.params.imageId, businessId);
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', String(image.sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(image.data);
  },
};
