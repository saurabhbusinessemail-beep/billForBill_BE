'use strict';

const express = require('express');
const { getBusinesses, getOneBusiness, getBusinessTypeOptions, postBusiness, patchBusiness, getCatalogAuthorization } = require('../controllers/businesses.controller');
const { requireSession } = require('../middleware/requireSession');
const catalogRouter = require('./businessCatalog.router');

const router = express.Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });

router.get('/', requireSession, getBusinesses);
router.get('/business-types', requireSession, getBusinessTypeOptions);
router.post('/', requireSession, postBusiness);
router.use('/:businessId/catalog', requireSession, catalogRouter);
router.get('/:businessId/catalog-authorization', requireSession, getCatalogAuthorization);
router.get('/:businessId', requireSession, getOneBusiness);
router.patch('/:businessId', requireSession, patchBusiness);

module.exports = router;
