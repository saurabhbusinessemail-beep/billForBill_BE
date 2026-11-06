'use strict';
const service = require('../services/plansOffers.service');
const run = (fn, status = 200) => async (req, res, next) => { try { res.status(status).json({ success: true, data: await fn(req) }); } catch (error) { next(error); } };
module.exports = {
  list: kind => run(req => service.list(kind, req.query)),
  get: kind => run(req => service.get(kind, req.params.id)),
  create: kind => run(req => service.create(kind, req.body), 201),
  update: kind => run(req => service.update(kind, req.params.id, req.body)),
  active: kind => run(req => service.setActive(kind, req.params.id, req.body?.isActive)),
  planOffers: run(req => service.planOffers(req.params.id)),
  lookup: kind => run(req => service.lookups(kind, req.query)),
};
