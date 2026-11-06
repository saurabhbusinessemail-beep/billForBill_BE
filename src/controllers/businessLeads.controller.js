'use strict';
const service = require('../services/businessDocuments.service');
const run = (fn, status = 200) => async (req, res, next) => { try { res.status(status).json({ success: true, data: await fn(req) }); } catch (error) { next(error); } };
module.exports = {
  options: run(req => service.getOptions(req.params.businessId, req.authUserId, 'business.leads.view')),
  lookupContact: run(req => service.lookupContact(req.params.businessId, req.authUserId, req.query, 'business.leads.create')),
  list: run(req => service.listLeads(req.params.businessId, req.authUserId, req.query)),
  get: run(req => service.getLead(req.params.businessId, req.authUserId, req.params.leadId)),
  create: run(req => service.createLead(req.params.businessId, req.authUserId, req.body, req.get('Idempotency-Key')), 201),
  update: run(req => service.updateLead(req.params.businessId, req.authUserId, req.params.leadId, req.body)),
  remove: run(req => service.deleteLead(req.params.businessId, req.authUserId, req.params.leadId)),
  convert: run(req => service.convertLead(req.params.businessId, req.authUserId, req.params.leadId, req.body?.mode, req.body?.version, req.get('Idempotency-Key'), req.body?.deliveryCompleted), 201),
};
