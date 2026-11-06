'use strict';

const { saveBusinessLogo, getBusinessLogo, deleteBusinessLogo } = require('../services/businessLogos.service');

async function putBusinessLogo(req, res) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  let originalName = req.headers['x-file-name'];
  if (typeof originalName === 'string') {
    try { originalName = decodeURIComponent(originalName); } catch { originalName = ''; }
  }
  const data = await saveBusinessLogo(req.authUserId, req.params.businessId, contentType, originalName, req.body);
  res.status(200).json({ success: true, data });
}

async function sendBusinessLogo(req, res) {
  const logo = await getBusinessLogo(req.authUserId, req.params.businessId);
  res.setHeader('Content-Type', logo.contentType);
  res.setHeader('Content-Length', String(logo.sizeBytes));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.status(200).send(logo.data);
}

async function removeBusinessLogo(req, res) {
  const data = await deleteBusinessLogo(req.authUserId, req.params.businessId);
  res.status(200).json({ success: true, data });
}

module.exports = { putBusinessLogo, sendBusinessLogo, removeBusinessLogo };
