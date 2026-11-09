'use strict';

const { listBusinesses, getBusiness, createBusiness, updateBusiness, listBusinessTypeOptions } = require('../services/businesses.service');
const catalog = require('../services/businessCatalog.service');

async function getBusinesses(req, res) {
  const data = await listBusinesses(req.authUserId);
  res.status(200).json({ success: true, data });
}

async function getOneBusiness(req, res) {
  const data = await getBusiness(req.authUserId, req.params.businessId);
  res.status(200).json({ success: true, data });
}

async function getBusinessTypeOptions(_req, res) {
  const data = await listBusinessTypeOptions();
  res.status(200).json({ success: true, data });
}

async function postBusiness(req, res) {
  const data = await createBusiness(req.authUserId, req.body, req.get('Idempotency-Key'));
  res.status(201).json({ success: true, data });
}

async function patchBusiness(req, res) {
  const data = await updateBusiness(req.authUserId, req.params.businessId, req.body);
  res.status(200).json({ success: true, data });
}

async function getCatalogAuthorization(req, res) {
  const data = await catalog.authorization(req.params.businessId, req.authUserId);
  res.status(200).json({ success: true, data });
}

module.exports = { getBusinesses, getOneBusiness, getBusinessTypeOptions, postBusiness, patchBusiness, getCatalogAuthorization };
