'use strict';
const service = require('../services/dataCleanup.service');
const run = kind => async (req, res) => res.status(200).json({ success: true, data: await service.cleanup(kind, req.params.businessId) });
module.exports = { businesses: async (req, res) => res.status(200).json({ success: true, data: await service.listBusinesses(req.query) }), adminCatalog: run('admin'), businessData: run('business'), allData: run('all') };
