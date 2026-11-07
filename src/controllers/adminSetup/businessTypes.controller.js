'use strict';
const service = require('../../services/adminSetup/businessTypes.service');
const off = require('../../services/adminSetup/openFoodFacts.service');
const resource = require('./resourceController')(service);
module.exports = {
  ...resource,
  saveOpenFoodFactsConfig: async (req, res) => res.status(200).json({ success: true, data: await off.saveConfig(req.params.id, req.body) }),
  openFoodFactsTaxonomy: async (req, res) => res.status(200).json({ success: true, data: await off.taxonomySuggestions(req.query.tagType, req.query.q, req.query.categories) }),
  syncOpenFoodFacts: async (req, res) => {
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const data = await off.sync(req.params.id, { ...req.body, signal: controller.signal });
    if (!controller.signal.aborted) res.status(200).json({ success: true, data });
  },
};
