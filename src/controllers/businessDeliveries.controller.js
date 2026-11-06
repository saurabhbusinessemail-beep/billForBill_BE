'use strict';
const service = require('../services/businessDeliveries.service');
const run = (fn, status = 200) => async (req, res, next) => { try { res.status(status).json({ success: true, data: await fn(req) }); } catch (error) { next(error); } };
module.exports = {
  list: run(req => service.list(req.params.businessId, req.authUserId, req.query)),
  get: run(req => service.get(req.params.businessId, req.authUserId, req.params.deliveryId)),
  create: run(req => service.create(req.params.businessId, req.authUserId, req.body), 201),
  update: run(req => service.update(req.params.businessId, req.authUserId, req.params.deliveryId, req.body)),
  action: run(req => service.action(req.params.businessId, req.authUserId, req.params.deliveryId, req.body)),
  orders: run(req => service.eligibleOrders(req.params.businessId, req.authUserId, req.query.deliveryId)),
  parties: run(req => service.parties(req.params.businessId, req.authUserId, req.query.search)),
  addresses: run(req => service.partyAddresses(req.params.businessId, req.authUserId, req.params.partyId)),
  addAddress: run(req => service.addPartyAddress(req.params.businessId, req.authUserId, req.params.partyId, req.body), 201),
  searchUsers: run(req => service.searchUsers(req.params.businessId, req.authUserId, req.query.search)),
  createUser: run(req => service.createUser(req.params.businessId, req.authUserId, req.body), 201),
};
