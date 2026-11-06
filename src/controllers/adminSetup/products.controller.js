'use strict';
const service = require('../../services/adminSetup/products.service');
const common = require('../../services/adminSetup/catalogCommon.service');
function metadata(req) {
  const text = req.headers['x-product-metadata'];
  if (typeof text !== 'string' || text.length > 12000) throw common.error(400, 'INVALID_PRODUCT_METADATA', 'Enter product details.');
  try { return JSON.parse(text); } catch { throw common.error(400, 'INVALID_PRODUCT_METADATA', 'Enter valid product details.'); }
}
function fileInfo(req) {
  let name = String(req.headers['x-file-name'] || 'product-image');
  try { name = decodeURIComponent(name); } catch { name = ''; }
  return { type: String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), name, bytes: req.body };
}
module.exports = {
  list: async (req, res) => res.status(200).json({ success: true, data: await service.list(req.query) }),
  get: async (req, res) => res.status(200).json({ success: true, data: await service.get(req.params.id) }),
  create: async (req, res) => { const file = fileInfo(req); res.status(201).json({ success: true, data: await service.createWithImage(metadata(req), file.type, file.name, file.bytes) }); },
  update: async (req, res) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type === 'application/json') return res.status(200).json({ success: true, data: await service.updateDetails(req.params.id, req.body) });
    const file = fileInfo(req); res.status(200).json({ success: true, data: await service.updateWithImage(req.params.id, metadata(req), file.type, file.name, file.bytes) });
  },
  remove: async (req, res) => {
    const scope = req.query.scope;
    if (scope !== undefined && !['admin-only', 'all-copies'].includes(scope)) throw common.error(400, 'INVALID_PRODUCT_DELETE_SCOPE', 'Choose a valid product deletion scope.');
    res.status(200).json({ success: true, data: await service.remove(req.params.id, { scope }) });
  },
  deleteImpact: async (req, res) => res.status(200).json({ success: true, data: await service.deleteImpact(req.params.id) }),
};
