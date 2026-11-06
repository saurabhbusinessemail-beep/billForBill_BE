'use strict';
const service = require('../services/businessDocuments.service');
const run = (fn, status = 200) => async (req, res, next) => { try { res.status(status).json({ success: true, data: await fn(req) }); } catch (error) { next(error); } };
const raw = (req) => { if (!Buffer.isBuffer(req.body) || !req.body.length) throw Object.assign(new Error('Choose an image file.'), { statusCode: 400, code: 'ORDER_IMAGE_REQUIRED', expose: true }); return req.body; };
const metadata = (req) => { try { return JSON.parse(req.get('X-Order-Metadata') || '{}'); } catch { throw Object.assign(new Error('Image order details are invalid.'), { statusCode: 400, code: 'INVALID_ORDER_IMAGE_METADATA', expose: true }); } };
module.exports = {
  list: run(req => service.listOrders(req.params.businessId, req.authUserId, req.query)),
  summary: run(req => service.summary(req.params.businessId, req.authUserId)),
  options: run(req => service.getOptions(req.params.businessId, req.authUserId)),
  leadOptions: run(req => service.getOptions(req.params.businessId, req.authUserId, 'business.leads.view')),
  lookupContact: run(req => service.lookupContact(req.params.businessId, req.authUserId, req.query)),
  lookupLeadContact: run(req => service.lookupContact(req.params.businessId, req.authUserId, req.query, 'business.leads.create')),
  addTax: run(req => service.addTax(req.params.businessId, req.authUserId, req.body), 201),
  get: run(req => service.getOrder(req.params.businessId, req.authUserId, req.params.orderId)),
  create: run(req => service.createOrder(req.params.businessId, req.authUserId, req.body, req.get('Idempotency-Key')), 201),
  createImage: run(req => service.createImageOrder(req.params.businessId, req.authUserId, metadata(req), raw(req), req.query.filename, req.get('Idempotency-Key')), 201),
  update: run(req => service.updateOrder(req.params.businessId, req.authUserId, req.params.orderId, req.body)),
  transition: run(req => service.transitionOrder(req.params.businessId, req.authUserId, req.params.orderId, req.body)),
  remove: run(req => service.deleteOrder(req.params.businessId, req.authUserId, req.params.orderId)),
  attachImage: run(req => service.attachImage(req.params.businessId, req.authUserId, req.params.orderId, raw(req), req.query.filename), 201),
  removeImage: run(req => service.removeImage(req.params.businessId, req.authUserId, req.params.orderId, req.params.imageId)),
  abortImageOrder: run(req => service.abortImageOrder(req.params.businessId, req.authUserId, req.params.orderId)),
  image: async (req, res, next) => { try { const { image, stream } = await service.imageStreamInfo(req.params.businessId, req.authUserId, req.params.orderId, req.params.imageId); res.setHeader('Content-Type', image.contentType); res.setHeader('Content-Length', String(image.size)); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(image.filename)}"`); stream.on('error', next).pipe(res); } catch (error) { next(error); } },
};
