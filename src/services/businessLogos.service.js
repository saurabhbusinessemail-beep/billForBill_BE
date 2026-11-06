'use strict';

const { assertDatabaseConnected } = require('../DB/connection');
const BusinessLogo = require('../DB/models/BusinessLogo');
const { assertOwnedBusiness } = require('./businesses.service');
const { access: authorizeBusiness } = require('./businessPeopleTeams.service');

const MAX_LOGO_BYTES = 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function createError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function matchesSignature(data, contentType) {
  if (contentType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (contentType === 'image/png') return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === 'image/webp') return data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

async function saveBusinessLogo(ownerUserId, businessId, contentType, originalName, data) {
  assertDatabaseConnected();
  const { business } = await authorizeBusiness(businessId, ownerUserId, 'business.logo.update');
  if (!ALLOWED_TYPES.has(contentType)) throw createError(415, 'UNSUPPORTED_LOGO_TYPE', 'Use a JPEG, PNG, or WebP image.');
  if (!Buffer.isBuffer(data) || data.length === 0) throw createError(400, 'EMPTY_LOGO', 'Choose an image to upload.');
  if (data.length > MAX_LOGO_BYTES) throw createError(413, 'LOGO_TOO_LARGE', 'The logo must be 1 MB or smaller.');
  if (!matchesSignature(data, contentType)) throw createError(415, 'INVALID_LOGO_CONTENT', 'The selected file does not match its image type.');
  const safeName = typeof originalName === 'string' ? originalName.replace(/[\\/\0-\x1f]/g, '').slice(0, 255) : 'business-logo';
  const logo = await BusinessLogo.findOneAndUpdate(
    { businessId, ownerUserId: business.ownerUserId },
    { $set: { originalName: safeName || 'business-logo', contentType, sizeBytes: data.length, data } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  ).select('-data');
  return { businessId: String(logo.businessId), contentType: logo.contentType, sizeBytes: logo.sizeBytes };
}

async function getBusinessLogo(_userId, businessId) {
  assertDatabaseConnected();
  const logo = await BusinessLogo.findOne({ businessId }).select('+data');
  if (!logo) throw createError(404, 'BUSINESS_LOGO_NOT_FOUND', 'No logo is saved for this business.');
  return { contentType: logo.contentType, data: logo.data, sizeBytes: logo.sizeBytes };
}

async function deleteBusinessLogo(ownerUserId, businessId) {
  assertDatabaseConnected();
  const { business } = await authorizeBusiness(businessId, ownerUserId, 'business.logo.update');
  await BusinessLogo.deleteOne({ businessId, ownerUserId: business.ownerUserId });
  return { deleted: true };
}

module.exports = { saveBusinessLogo, getBusinessLogo, deleteBusinessLogo, MAX_LOGO_BYTES };
