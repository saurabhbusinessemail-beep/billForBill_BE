'use strict';
const express = require('express');
const { requireSession } = require('../middleware/requireSession');
const { requireAdminOrSuperAdmin } = require('../middleware/requireAdminOrSuperAdmin');
const { requireSuperAdmin } = require('../middleware/requireSuperAdmin');
const controller = require('../controllers/plansOffers.controller');

const router = express.Router();
router.use(requireSession, requireAdminOrSuperAdmin, (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
router.get('/lookups/plans', controller.lookup('plans'));
router.get('/lookups/users', controller.lookup('users'));
router.get('/lookups/businesses', controller.lookup('businesses'));
router.get('/lookups/business-types', controller.lookup('business-types'));
for (const [path, kind] of [['plans', 'plans'], ['extra-credits', 'credits'], ['offers', 'offers']]) {
  router.get(`/${path}`, controller.list(kind));
  if (kind === 'plans') router.get('/plans/:id/offers', controller.planOffers);
  router.get(`/${path}/:id`, controller.get(kind));
  router.post(`/${path}`, requireSuperAdmin, controller.create(kind));
  router.put(`/${path}/:id`, requireSuperAdmin, controller.update(kind));
  router.patch(`/${path}/:id/active`, requireSuperAdmin, controller.active(kind));
}
module.exports = router;
