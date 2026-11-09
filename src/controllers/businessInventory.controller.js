'use strict';
const service = require('../services/businessInventory.service');
const run = fn => async (req, res, next) => { try { res.json({ success: true, data: await fn(req) }); } catch (error) { next(error); } };
module.exports = {
  list: run(req => service.list(req.params.businessId, req.authUserId, req.query)),
  adjust: run(async req => service.adjust(req.params.businessId, req.authUserId, req.body)),
  ledger: run(req => service.ledger(req.params.businessId, req.authUserId, req.params.productId, req.query.variantKey)),
  report: run(req => service.report(req.params.businessId, req.authUserId, req.query)),
  reorderLevel: run(req => service.setReorderLevel(req.params.businessId, req.authUserId, req.params.productId, req.body)),
};
