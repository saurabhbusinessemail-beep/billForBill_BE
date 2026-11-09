'use strict';

const mongoose = require('mongoose');
const { assertDatabaseConnected } = require('../DB/connection');
const Business = require('../DB/models/Business');
const BusinessLogo = require('../DB/models/BusinessLogo');
const BusinessType = require('../DB/models/BusinessType');
const { access: authorizeBusiness } = require('./businessPeopleTeams.service');
const { copyBusinessTypeCatalog } = require('./businessCatalogCopy.service');
const { businessCurrency, supportedCurrencies } = require('./businessCurrency');
const { normalizeGstin } = require('../utils/gstin');

function createError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

const duplicateGstin = () => createError(409, 'GSTIN_ALREADY_IN_USE', 'This GSTIN is already registered to a business.');

async function assertGstinAvailable(gstin, businessId) {
  if (!gstin) return;
  const filter = businessId ? { gstin, _id: { $ne: businessId } } : { gstin };
  if (await Business.exists(filter)) throw duplicateGstin();
}

function translateGstinConflict(error) {
  if (error.code === 11000 && error.keyPattern?.gstin === 1) throw duplicateGstin();
  throw error;
}

const BUSINESS_FIELDS = ['legalName', 'businessTypeId', 'registrationId', 'phone', 'email', 'website', 'address'];
const MAX_LENGTHS = { legalName: 200, businessTypeId: 24, registrationId: 100, phone: 40, email: 254, website: 2048, address: 1000 };

function validateBusiness(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createError(400, 'INVALID_BUSINESS', 'Enter valid business details.');
  }
  const values = {};
  if (Object.hasOwn(input, 'currencyCode')) {
    if (!supportedCurrencies.includes(input.currencyCode)) throw createError(400, 'INVALID_BUSINESS_CURRENCY', 'Choose a supported business currency.');
    values.currencyCode = input.currencyCode;
  }
  if ((!partial && !Object.hasOwn(input, 'businessTypeId')) || (Object.hasOwn(input, 'businessTypeId') && !mongoose.isValidObjectId(input.businessTypeId))) {
    throw createError(400, 'BUSINESS_TYPE_REQUIRED', 'Choose a business type.');
  }
  if (Object.hasOwn(input, 'businessTypeId')) values.businessTypeId = input.businessTypeId;
  if (Object.hasOwn(input, 'gstin')) values.gstin = normalizeGstin(input.gstin);
  for (const field of BUSINESS_FIELDS) {
    if (partial && !Object.hasOwn(input, field)) continue;
    if (!Object.hasOwn(input, field) && field !== 'legalName') continue;
    const value = input[field] ?? '';
    if (typeof value !== 'string') throw createError(400, 'INVALID_BUSINESS', 'Enter valid business details.');
    const normalized = value.trim();
    if (normalized.length > MAX_LENGTHS[field]) throw createError(400, 'INVALID_BUSINESS', 'One or more business details are too long.');
    if (field === 'legalName' && !normalized) throw createError(400, 'INVALID_BUSINESS', 'Business legal name is required.');
    values[field] = normalized;
  }
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    throw createError(400, 'INVALID_BUSINESS_EMAIL', 'Enter a valid business email address.');
  }
  if (values.website) {
    try {
      const url = new URL(values.website);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
    } catch {
      throw createError(400, 'INVALID_BUSINESS_WEBSITE', 'Enter a valid website address beginning with http:// or https://.');
    }
  }
  return values;
}

function assertBusinessId(businessId) {
  if (!mongoose.isValidObjectId(businessId)) throw createError(404, 'BUSINESS_NOT_FOUND', 'Business not found.');
}

async function decorateBusiness(business, ownerUserId) {
  const hasLogo = Boolean(await BusinessLogo.exists({ businessId: business._id, ownerUserId }));
  return {
    id: String(business._id),
    kind: 'business',
    businessTypeId: business.businessTypeId ? String(business.businessTypeId) : null,
    legalName: business.legalName,
    currencyCode: businessCurrency(business),
    registrationId: business.registrationId,
    gstin: business.gstin || '',
    phone: business.phone,
    email: business.email,
    website: business.website,
    address: business.address,
    hasLogo,
    createdAt: business.createdAt,
    updatedAt: business.updatedAt,
  };
}

async function listBusinesses(ownerUserId) {
  assertDatabaseConnected();
  const businesses = await Business.find({ ownerUserId }).sort({ createdAt: 1, _id: 1 }).lean();
  return Promise.all(businesses.map((business) => decorateBusiness(business, ownerUserId)));
}

async function getBusiness(ownerUserId, businessId) {
  assertDatabaseConnected();
  assertBusinessId(businessId);
  const business = await Business.findOne({ _id: businessId, ownerUserId }).lean();
  if (!business) throw createError(404, 'BUSINESS_NOT_FOUND', 'Business not found.');
  return decorateBusiness(business, ownerUserId);
}

async function createBusiness(ownerUserId, input, requestKey) {
  assertDatabaseConnected();
  const values = validateBusiness(input);
  if (!(await BusinessType.exists({ _id: values.businessTypeId, businessId: null }))) throw createError(400, 'BUSINESS_TYPE_NOT_FOUND', 'Choose an available business type.');
  if (typeof requestKey !== 'string' || !/^[A-Za-z0-9-]{16,100}$/.test(requestKey)) throw createError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Retry the request from the business form.');
  let business = await Business.findOne({ ownerUserId, creationRequestKey: requestKey });
  if (business?.catalogCopyState === 'complete') return decorateBusiness(business.toObject(), ownerUserId);
  if (!business) {
    try {
      await assertGstinAvailable(values.gstin);
      business = await Business.create({ ...values, ownerUserId, creationRequestKey: requestKey, catalogCopyState: 'pending' });
    } catch (error) {
      if (error.code !== 11000 && error.code !== 'GSTIN_ALREADY_IN_USE') throw error;
      business = await Business.findOne({ ownerUserId, creationRequestKey: requestKey });
      if (!business) translateGstinConflict(error);
      if (business.catalogCopyState === 'complete') return decorateBusiness(business.toObject(), ownerUserId);
    }
  }
  try {
    const copiedCatalog = await copyBusinessTypeCatalog(business.toObject());
    const completed = await Business.findByIdAndUpdate(business._id, { $set: { catalogCopyState: 'complete', catalogProvenance: copiedCatalog, businessTaxComponentIds: copiedCatalog.businessTaxComponentIds } }, { new: true, runValidators: true }).lean();
    if (!completed) throw createError(500, 'CATALOG_COPY_INCOMPLETE', 'Business catalog copy did not complete.');
    return decorateBusiness(completed, ownerUserId);
  } catch (error) {
    throw error;
  }
}

async function updateBusiness(ownerUserId, businessId, input) {
  assertDatabaseConnected();
  assertBusinessId(businessId);
  const values = validateBusiness(input, { partial: true });
  if (!Object.keys(values).length) throw createError(400, 'EMPTY_BUSINESS_UPDATE', 'Provide business details to update.');
  const context = await authorizeBusiness(businessId, ownerUserId, 'business.details.update');
  if (!context.business.businessTypeId && !values.businessTypeId) throw createError(400, 'BUSINESS_TYPE_REQUIRED', 'Choose a business type before saving this business.');
  if (Object.hasOwn(values, 'businessTypeId') && context.business.businessTypeId && String(context.business.businessTypeId) !== String(values.businessTypeId)) throw createError(409, 'BUSINESS_TYPE_IMMUTABLE', 'The business type cannot be changed after it has been assigned.');
  if (values.gstin !== context.business.gstin) await assertGstinAvailable(values.gstin, businessId);
  const resumeCatalogCopy = context.business.catalogCopyState === 'pending' && Boolean(context.business.businessTypeId);
  if (Object.hasOwn(values, 'businessTypeId') && (!context.business.businessTypeId || resumeCatalogCopy)) {
    if (!resumeCatalogCopy && !(await BusinessType.exists({ _id: values.businessTypeId, businessId: null }))) throw createError(400, 'BUSINESS_TYPE_NOT_FOUND', 'Choose an available business type.');
    const pending = resumeCatalogCopy
      ? await Business.findOneAndUpdate({ _id: businessId, catalogCopyState: 'pending', businessTypeId: context.business.businessTypeId }, { $set: values }, { new: true, runValidators: true }).lean().catch(translateGstinConflict)
      : await Business.findOneAndUpdate({ _id: businessId, $or: [{ businessTypeId: null }, { businessTypeId: { $exists: false } }] }, { $set: { ...values, catalogCopyState: 'pending' } }, { new: true, runValidators: true }).lean().catch(translateGstinConflict);
    if (!pending) throw createError(409, 'BUSINESS_TYPE_IMMUTABLE', 'The business type cannot be changed after it has been assigned.');
    try {
      const copiedCatalog = await copyBusinessTypeCatalog(pending);
      const completed = await Business.findByIdAndUpdate(businessId, { $set: { catalogCopyState: 'complete', catalogProvenance: copiedCatalog, businessTaxComponentIds: copiedCatalog.businessTaxComponentIds } }, { new: true, runValidators: true }).lean();
      if (!completed) throw createError(500, 'CATALOG_COPY_INCOMPLETE', 'Business catalog copy did not complete.');
      return decorateBusiness(completed, context.business.ownerUserId);
    } catch (error) {
      if (error.code !== 'CATALOG_COPY_COMPENSATION_FAILED') await Business.updateOne({ _id: businessId, catalogCopyState: 'pending' }, { $set: { businessTypeId: null, catalogCopyState: 'complete' }, $unset: { catalogProvenance: 1 } });
      throw error;
    }
  }
  const business = await Business.findOneAndUpdate({ _id: businessId }, { $set: values }, { new: true, runValidators: true }).lean().catch(translateGstinConflict);
  if (!business) throw createError(404, 'BUSINESS_NOT_FOUND', 'Business not found.');
  return decorateBusiness(business, context.business.ownerUserId);
}

async function assertOwnedBusiness(ownerUserId, businessId) {
  assertDatabaseConnected();
  assertBusinessId(businessId);
  const business = await Business.findOne({ _id: businessId, ownerUserId }).select('_id');
  if (!business) throw createError(404, 'BUSINESS_NOT_FOUND', 'Business not found.');
  return business;
}

async function listBusinessTypeOptions() {
  assertDatabaseConnected();
  const types = await BusinessType.find({ businessId: null }).select('_id name').sort({ normalizedName: 1, _id: 1 }).lean();
  return types.map(type => ({ id: String(type._id), name: type.name }));
}

module.exports = { listBusinesses, getBusiness, createBusiness, updateBusiness, assertOwnedBusiness, listBusinessTypeOptions };
