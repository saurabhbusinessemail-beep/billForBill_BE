'use strict';
const service = require('../services/businessPlans.service');
const run = (handler, status = 200) => async (req, res, next) => { try { res.status(status).json({ success: true, data: await handler(req) }); } catch (error) { next(error); } };
module.exports = {
  dashboard: run(req => service.dashboard(req.params.businessId, req.authUserId)),
  plans: run(req => service.availablePlans(req.params.businessId, req.authUserId)),
  credits: run(req => service.availableExtraCredits(req.params.businessId, req.authUserId)),
  validateOffer: run(req => service.validateOffer(req.params.businessId, req.authUserId, req.body)),
  purchasePlan: run(req => service.purchasePlan(req.params.businessId, req.authUserId, req.body, req.get('Idempotency-Key')), 201),
  purchaseExtraCredit: run(req => service.purchaseExtraCredit(req.params.businessId, req.authUserId, req.body, req.get('Idempotency-Key')), 201),
};
