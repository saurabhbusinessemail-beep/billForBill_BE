'use strict';
const service = require('../services/businessCatalog.service');
const common = require('../services/adminSetup/catalogCommon.service');
const KINDS = new Set(['products', 'categories', 'attributes', 'units', 'taxes']);
function kind(req) { const value = req.params.kind; if (!KINDS.has(value)) throw common.error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.'); return value; }
function metadata(req) { const text = req.headers['x-product-metadata']; if (typeof text !== 'string' || text.length > 12000) throw common.error(400, 'INVALID_PRODUCT_METADATA', 'Enter product details.'); try { return JSON.parse(text); } catch { throw common.error(400, 'INVALID_PRODUCT_METADATA', 'Enter valid product details.'); } }
function fileInfo(req) { let name = String(req.headers['x-file-name'] || 'product-image'); try { name = decodeURIComponent(name); } catch { name = ''; } return { type: String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), name, bytes: req.body }; }
module.exports = {
  list: async (req, res) => res.status(200).json({ success: true, data: await service.list(req.params.businessId, req.authUserId, kind(req), req.query) }),
  get: async (req, res) => res.status(200).json({ success: true, data: await service.get(req.params.businessId, req.authUserId, kind(req), req.params.id) }),
  create: async (req, res) => { const area = kind(req); const result = area === 'products' ? req.is('application/json') ? await service.createProduct(req.params.businessId, req.authUserId, req.body) : await (() => { const file = fileInfo(req); return service.createProduct(req.params.businessId, req.authUserId, metadata(req), file.type, file.name, file.bytes); })() : await service.create(req.params.businessId, req.authUserId, area, req.body); res.status(201).json({ success: true, data: result }); },
  update: async (req, res) => { const area = kind(req); if (area !== 'products' || req.is('application/json')) return res.status(200).json({ success: true, data: area === 'products' ? await service.updateProduct(req.params.businessId, req.authUserId, req.params.id, req.body) : await service.update(req.params.businessId, req.authUserId, area, req.params.id, req.body) }); const file = fileInfo(req); res.status(200).json({ success: true, data: await service.updateProduct(req.params.businessId, req.authUserId, req.params.id, metadata(req), file.type, file.name, file.bytes) }); },
  remove: async (req, res) => res.status(200).json({ success: true, data: await service.remove(req.params.businessId, req.authUserId, kind(req), req.params.id) }),
  deleteImpact: async (req, res) => res.status(200).json({ success: true, data: await service.impact(req.params.businessId, req.authUserId, kind(req), req.params.id) }),
};
