'use strict';

const mongoose = require('mongoose');
const { assertDatabaseConnected } = require('../DB/connection');
const User = require('../DB/models/User');
const Business = require('../DB/models/Business');
const BusinessType = require('../DB/models/BusinessType');
const Plan = require('../DB/models/Plan');
const ExtraCreditPack = require('../DB/models/ExtraCreditPack');
const PlanOffer = require('../DB/models/PlanOffer');

const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code, expose: statusCode < 500 });
const models = { plans: Plan, credits: ExtraCreditPack, offers: PlanOffer };
function integer(value, fallback, max) { const number = Number(value); return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback; }
function pageArgs(query = {}) { return { page: integer(query.page, 1, 1000000), limit: integer(query.limit, 20, 100) }; }
function validMoney(value, label) {
  if (value === null || value === undefined || value === '') throw fail(400, 'INVALID_AMOUNT', `${label} is required.`);
  const amount = Number(value);
  const [coefficient, exponentText] = String(value).toLowerCase().split('e');
  const decimalPlaces = (coefficient.split('.')[1] || '').length - Number(exponentText || 0);
  if (!Number.isFinite(amount) || amount < 0 || decimalPlaces > 2) throw fail(400, 'INVALID_AMOUNT', `${label} must be a non-negative number with at most two decimal places.`);
  return amount;
}
function idList(input, field) {
  const values = input == null ? [] : Array.isArray(input) ? input : [input];
  if (values.some(value => !mongoose.isValidObjectId(value))) throw fail(400, 'INVALID_REFERENCE', `Choose valid ${field}.`);
  return [...new Set(values.map(String))];
}
function dateOnly(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw fail(400, 'INVALID_VALID_TILL', 'Choose a valid date.');
  return date;
}
function validate(kind, input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'INVALID_RECORD', 'Enter valid details.');
  const out = {};
  const take = (key, fn) => { if (Object.hasOwn(input, key)) out[key] = fn(input[key]); else if (!partial) throw fail(400, 'REQUIRED_FIELD', `${key} is required.`); };
  const text = (value, label, max) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw fail(400, 'INVALID_FIELD', `Enter a valid ${label}.`); return value.trim(); };
  const count = (value, label, allowZero = false) => { if (value === null || value === undefined || value === '') throw fail(400, 'INVALID_COUNT', `${label} is required.`); const number = Number(value); if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) throw fail(400, 'INVALID_COUNT', `${label} must be a whole number.`); return number; };
  if (kind === 'plans') {
    take('name', value => text(value, 'plan name', 120)); take('monthlyPrice', value => validMoney(value, 'Monthly price'));
    take('includedBills', value => count(value, 'Included bills', true));
  } else if (kind === 'credits') {
    take('name', value => text(value, 'pack name', 120)); take('code', value => text(value, 'code', 40));
    take('price', value => validMoney(value, 'Price')); take('billCount', value => count(value, 'Bill count'));
  } else {
    take('name', value => text(value, 'offer name', 120)); take('code', value => text(value, 'code', 40));
    if (Object.hasOwn(input, 'discountType')) out.discountType = input.discountType === '' && !partial ? 'percent' : (() => { if (!['percent', 'flat'].includes(input.discountType)) throw fail(400, 'INVALID_DISCOUNT_TYPE', 'Choose a valid discount type.'); return input.discountType; })();
    else if (!partial) out.discountType = 'percent';
    if (Object.hasOwn(input, 'amount')) out.amount = input.amount === null || input.amount === '' ? null : validMoney(input.amount, 'Discount amount');
    else if (!partial) out.amount = null;
    for (const [key, label] of [['planIds', 'plans'], ['userIds', 'users'], ['businessIds', 'businesses']]) if (Object.hasOwn(input, key)) out[key] = idList(input[key], label); else if (!partial) out[key] = [];
    if (Object.hasOwn(input, 'businessTypeIds')) out.businessTypeIds = idList(input.businessTypeIds, 'business types');
    else if (!partial) out.businessTypeIds = [];
    if (Object.hasOwn(input, 'validTill')) out.validTill = input.validTill === null || input.validTill === '' ? null : dateOnly(input.validTill);
    else if (!partial) out.validTill = null;
    if (!partial && !out.businessTypeIds.length) throw fail(400, 'BUSINESS_TYPE_REQUIRED', 'Choose at least one business type.');
  }
  if (Object.hasOwn(input, 'isActive')) {
    if (typeof input.isActive !== 'boolean') throw fail(400, 'INVALID_ACTIVE_STATUS', 'Active status must be true or false.');
    out.isActive = input.isActive;
  } else if (!partial) out.isActive = true;
  if (!Object.keys(out).length) throw fail(400, 'EMPTY_UPDATE', 'Provide at least one field to update.');
  return out;
}
async function validateReferences(values) {
  const [plans, users, businesses, types] = await Promise.all([
    values.planIds ? Plan.countDocuments({ _id: { $in: values.planIds } }) : 0,
    values.userIds ? User.countDocuments({ _id: { $in: values.userIds } }) : 0,
    values.businessIds ? Business.countDocuments({ _id: { $in: values.businessIds } }) : 0,
    values.businessTypeIds ? BusinessType.countDocuments({ _id: { $in: values.businessTypeIds }, businessId: null }) : 0,
  ]);
  if (values.planIds && plans !== values.planIds.length) throw fail(400, 'INVALID_REFERENCE', 'One or more selected plans no longer exist.');
  if (values.userIds && users !== values.userIds.length) throw fail(400, 'INVALID_REFERENCE', 'One or more selected users do not exist.');
  if (values.businessIds && businesses !== values.businessIds.length) throw fail(400, 'INVALID_REFERENCE', 'One or more selected businesses do not exist.');
  if (values.businessTypeIds && types !== values.businessTypeIds.length) throw fail(400, 'INVALID_REFERENCE', 'One or more selected business types are invalid.');
}
function serialize(row) {
  const value = row.toObject ? row.toObject() : row;
  const result = { ...value, id: String(value._id) };
  for (const key of ['planIds', 'userIds', 'businessIds', 'businessTypeIds']) if (result[key]) result[key] = result[key].map(String);
  delete result._id; delete result.__v;
  return result;
}
async function decorateOffers(rows) {
  if (!rows.length) return [];
  const planIds = [...new Set(rows.flatMap(row => (row.planIds || []).map(String)))];
  const userIds = [...new Set(rows.flatMap(row => (row.userIds || []).map(String)))];
  const businessIds = [...new Set(rows.flatMap(row => (row.businessIds || []).map(String)))];
  const businessTypeIds = [...new Set(rows.flatMap(row => (row.businessTypeIds || []).map(String)))];
  const [plans, users, businesses, businessTypes] = await Promise.all([
    planIds.length ? Plan.find({ _id: { $in: planIds } }).select('name').lean() : [],
    userIds.length ? User.find({ _id: { $in: userIds } }).select('displayName phoneE164').lean() : [],
    businessIds.length ? Business.find({ _id: { $in: businessIds } }).select('legalName').lean() : [],
    businessTypeIds.length ? BusinessType.find({ _id: { $in: businessTypeIds } }).select('name').lean() : [],
  ]);
  const names = (records, key) => new Map(records.map(record => [String(record._id), record[key]]));
  const planNames = names(plans, 'name'); const userNames = names(users, 'displayName'); const businessNames = names(businesses, 'legalName'); const businessTypeNames = names(businessTypes, 'name');
  return rows.map(row => ({ ...serialize(row), planNames: (row.planIds || []).map(id => planNames.get(String(id)) || String(id)), userNames: (row.userIds || []).map(id => userNames.get(String(id)) || String(id)), businessNames: (row.businessIds || []).map(id => businessNames.get(String(id)) || String(id)), businessTypeNames: (row.businessTypeIds || []).map(id => businessTypeNames.get(String(id)) || String(id)) }));
}
async function list(kind, query = {}) {
  assertDatabaseConnected(); const Model = models[kind]; if (!Model) throw fail(404, 'NOT_FOUND', 'Catalog not found.');
  const { page, limit } = pageArgs(query); const filter = {};
  if (query.isActive === 'true' || query.isActive === 'false') filter.isActive = query.isActive === 'true';
  if (kind === 'offers') {
    const search = String(query.q || '').trim().slice(0, 80);
    if (search) { const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); filter.$or = [{ name: new RegExp(safe, 'i') }, { code: new RegExp(safe, 'i') }]; }
    if (query.planId && mongoose.isValidObjectId(query.planId)) filter.planIds = query.planId;
  }
  const [rows, total] = await Promise.all([Model.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), Model.countDocuments(filter)]);
  let items = kind === 'offers' ? await decorateOffers(rows) : rows.map(serialize);
  if (kind === 'plans') {
    const counts = await PlanOffer.aggregate([{ $match: { planIds: { $in: rows.map(row => row._id) } } }, { $unwind: '$planIds' }, { $match: { planIds: { $in: rows.map(row => row._id) } } }, { $group: { _id: '$planIds', count: { $sum: 1 } } }]);
    const byId = new Map(counts.map(row => [String(row._id), row.count])); items = items.map(row => ({ ...row, offerCount: byId.get(row.id) || 0 }));
  }
  return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
}
async function get(kind, id) { assertDatabaseConnected(); if (!mongoose.isValidObjectId(id)) throw fail(404, 'RECORD_NOT_FOUND', 'Record not found.'); const row = await models[kind].findById(id).lean(); if (!row) throw fail(404, 'RECORD_NOT_FOUND', 'Record not found.'); return serialize(row); }
async function create(kind, input) { assertDatabaseConnected(); const values = validate(kind, input); if (kind === 'offers') await validateReferences(values); return serialize(await models[kind].create(values)); }
async function update(kind, id, input) { assertDatabaseConnected(); if (!mongoose.isValidObjectId(id)) throw fail(404, 'RECORD_NOT_FOUND', 'Record not found.'); const values = validate(kind, input, true); if (kind === 'offers') { const existing = await PlanOffer.findById(id).select('businessTypeIds'); if (!existing) throw fail(404, 'RECORD_NOT_FOUND', 'Record not found.'); const businessTypeIds = values.businessTypeIds || existing.businessTypeIds.map(String); if (!businessTypeIds.length) throw fail(400, 'BUSINESS_TYPE_REQUIRED', 'Choose at least one business type.'); await validateReferences(values); } const row = await models[kind].findByIdAndUpdate(id, { $set: values }, { new: true, runValidators: true }); if (!row) throw fail(404, 'RECORD_NOT_FOUND', 'Record not found.'); return serialize(row); }
async function setActive(kind, id, isActive) { if (typeof isActive !== 'boolean') throw fail(400, 'INVALID_ACTIVE_STATUS', 'Active status must be true or false.'); return update(kind, id, { isActive }); }
async function planOffers(planId) { assertDatabaseConnected(); if (!mongoose.isValidObjectId(planId)) throw fail(404, 'RECORD_NOT_FOUND', 'Plan not found.'); const [plan, offers] = await Promise.all([Plan.exists({ _id: planId }), PlanOffer.find({ planIds: planId }).sort({ createdAt: -1, _id: -1 }).lean()]); if (!plan) throw fail(404, 'RECORD_NOT_FOUND', 'Plan not found.'); return decorateOffers(offers); }
async function lookups(kind, query = {}) {
  assertDatabaseConnected(); const q = String(query.q || '').trim().slice(0, 80); const limit = 20;
  const ids = String(query.ids || '').split(',').filter(value => value && mongoose.isValidObjectId(value)).slice(0, 50);
  if (kind === 'plans') { const filter = ids.length ? { _id: { $in: ids } } : q ? { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } : {}; return (await Plan.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).lean()).map(serialize); }
  if (kind === 'users') { if (q.length < 2 && !ids.length) return []; const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const filter = ids.length ? { _id: { $in: ids } } : { $or: [{ displayName: new RegExp(safe, 'i') }, { phoneE164: new RegExp(safe, 'i') }] }; const rows = await User.find(filter).select('displayName phoneE164').sort({ displayName: 1 }).limit(limit).lean(); return rows.map(row => ({ id: String(row._id), name: row.displayName || '', phone: row.phoneE164 })); }
  if (kind === 'businesses') {
    if (q.length < 2 && !ids.length) return [];
    if (ids.length) { const rows = await Business.find({ _id: { $in: ids } }).populate('ownerUserId', 'phoneE164').limit(limit).lean(); return rows.map(row => ({ id: String(row._id), name: row.legalName, phone: row.phone || '', ownerPhone: row.ownerUserId?.phoneE164 || '' })); }
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const re = new RegExp(safe, 'i');
    const users = await User.find({ phoneE164: re }).select('_id').limit(50).lean(); const ownerIds = users.map(user => user._id);
    const rows = await Business.find({ $or: [{ legalName: re }, { phone: re }, ...(ownerIds.length ? [{ ownerUserId: { $in: ownerIds } }] : [])] }).populate('ownerUserId', 'phoneE164').sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
    return rows.map(row => ({ id: String(row._id), name: row.legalName, phone: row.phone || '', ownerPhone: row.ownerUserId?.phoneE164 || '' }));
  }
  if (kind === 'business-types') return (await BusinessType.find({ businessId: null }).sort({ name: 1 }).lean()).map(row => ({ id: String(row._id), name: row.name }));
  throw fail(404, 'NOT_FOUND', 'Lookup not found.');
}

module.exports = { list, get, create, update, setActive, planOffers, lookups };
