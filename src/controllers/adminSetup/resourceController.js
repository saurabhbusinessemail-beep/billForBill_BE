'use strict';
module.exports = (service) => ({
  list: async (req, res) => res.status(200).json({ success: true, data: await service.list(req.query) }),
  get: async (req, res) => res.status(200).json({ success: true, data: await service.get(req.params.id) }),
  create: async (req, res) => res.status(201).json({ success: true, data: await service.create(req.body) }),
  update: async (req, res) => res.status(200).json({ success: true, data: await service.update(req.params.id, req.body) }),
  remove: async (req, res) => res.status(200).json({ success: true, data: await service.remove(req.params.id) }),
  deleteImpact: async (req, res) => res.status(200).json({ success: true, data: await service.deleteImpact(req.params.id) }),
});
