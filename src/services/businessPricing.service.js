'use strict';
const mongoose = require('mongoose');
const { access } = require('./businessPeopleTeams.service');
const Product = require('../DB/models/BusinessCatalogProduct');
const Category = require('../DB/models/BusinessCatalogCategory');
const Tax = require('../DB/models/BusinessCatalogTax');
const User = require('../DB/models/User');
const RateLimitWindow = require('../DB/models/RateLimitWindow');
const Pricing = require('../DB/models/BusinessProductPricing');
const { normalizePhone } = require('../utils/phone');
const productUnits = require('./productUnits');
const { rateModes } = require('./serviceMeasurement');
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const decimal = (value, field, required = false) => {
  if ((value === null || value === undefined || value === '') && !required) return null;
  const input = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(input) || input.length > 24) throw fail(400, 'INVALID_PRICE', `Enter a valid ${field} using up to four decimal places.`);
  return mongoose.Types.Decimal128.fromString(input);
};
const value = (amount) => amount == null ? null : amount.toString();
function present(product, pricing) {
  const p = product.toObject ? product.toObject({ flattenMaps: true }) : product;
  const baseUnit = productUnits.dto(p).baseUnit;
  const row = pricing?.toObject ? pricing.toObject() : pricing;
  const rules = (row?.rules || []).map((r) => ({ id: String(r._id), customerUserId: r.customerUserId ? String(r.customerUserId) : null, minimumQuantity: r.minimumQuantity ?? null, sellingPrice: value(r.sellingPrice), active: r.active }));
  return {
    id: String(p._id), name: p.name, type: p.type, baseUnitName: baseUnit?.name || '', baseUnitSymbol: baseUnit?.symbol || '', categoryIds: (p.categoryIds || []).map(String),
    purchaseCost: value(row?.purchaseCost), taxInclusive: row?.taxInclusive ?? true,
    separateTaxAmount: value(row?.separateTaxAmount), separateTaxId: row?.separateTaxId ? String(row.separateTaxId) : null,
    defaultSellingPrice: value(row?.defaultSellingPrice), rules, version: row?.version || 0,
    variations: productUnits.variations(p).map(({ key, values }) => ({ key, values })),
    variantPrices: (row?.variantPrices || []).map(price => ({ variantKey: price.variantKey, basis: price.basis, sellingPrice: value(price.sellingPrice), purchaseCost: value(price.purchaseCost) })),
    updatedAt: row?.updatedAt || null,
  };
}
async function list(businessId, userId, query = {}) {
  const ctx = await access(businessId, userId, 'business.pricing.view');
  const filter = { businessId };
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 80) : '';
  if (search) filter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (query.categoryId && mongoose.isValidObjectId(query.categoryId)) filter.categoryIds = query.categoryId;
  const page = Math.max(1, parseInt(query.page, 10) || 1); const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 50));
  const products = await Product.find(filter).sort({ normalizedName: 1, _id: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean();
  const ids = products.map(p => p._id);
  const prices = await Pricing.find({ businessId, productId: { $in: ids } }).lean();
  const byProduct = new Map(prices.map(x => [String(x.productId), x]));
  const categories = await Category.find({ businessId }).select('_id name parentId').sort({ normalizedName: 1 }).lean();
  const count = await Product.countDocuments(filter);
  const customerRuleSets = await Pricing.find({ businessId, 'rules.customerUserId': { $ne: null } }).select('rules.customerUserId').lean();
  const userIds = [...new Set(customerRuleSets.flatMap(p => (p.rules || []).filter(rule => rule.active !== false).map(rule => rule.customerUserId).filter(Boolean).map(String)))];
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select('_id displayName').lean() : [];
  const names = new Map(users.map(u => [String(u._id), u.displayName || '']));
  const customers = users.map(user => ({ id: String(user._id), name: user.displayName || '' })).sort((a, b) => a.name.localeCompare(b.name));
  return { items: products.map(p => { const item = present(p, byProduct.get(String(p._id))); item.rules = item.rules.map(rule => ({ ...rule, customerName: rule.customerUserId ? names.get(rule.customerUserId) || '' : '' })); return item; }), categories: categories.map(c => ({ id: String(c._id), name: c.name, parentId: c.parentId ? String(c.parentId) : null })), customers, page, pageSize, total: count, hasNextPage: page * pageSize < count, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function lookupCustomer(bid, uid, query) {
  await access(bid, uid, 'business.pricing.manage');
  const phoneE164 = normalizePhone(query.countryCallingCode, query.phoneNumber);
  if (!phoneE164) throw fail(400, 'INVALID_PHONE', 'Enter a valid phone number and calling code.');
  const key = `f012-customer-lookup:${uid}`; const now = new Date();
  let window = await RateLimitWindow.findOneAndUpdate({ key, resetAt: { $gt: now } }, { $inc: { count: 1 } }, { new: true });
  if (!window) window = await RateLimitWindow.findOneAndUpdate({ key }, { $set: { count: 1, resetAt: new Date(now.getTime() + 60 * 60 * 1000) } }, { upsert: true, new: true, setDefaultsOnInsert: true }).catch(async e => { if (e.code !== 11000) throw e; return RateLimitWindow.findOneAndUpdate({ key }, { $inc: { count: 1 } }, { new: true }); });
  if (window.count > 30) throw Object.assign(fail(429, 'RATE_LIMITED', 'Too many lookup requests. Try again later.'), { retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) });
  const user = await User.findOne({ phoneE164 }).select('_id displayName').lean();
  return user ? { exists: true, userId: String(user._id), name: user.displayName || '' } : { exists: false };
}
async function getContext(bid, uid, pid, permission = 'business.pricing.manage') {
  if (!mongoose.isValidObjectId(pid)) throw fail(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  const ctx = await access(bid, uid, permission);
  const product = await Product.findOne({ _id: pid, businessId: bid }).lean();
  if (!product) throw fail(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  return { ctx, product };
}
function normalizeRules(rules) {
  if (!Array.isArray(rules) || rules.length > 250) throw fail(400, 'INVALID_RULES', 'Enter valid selling-price rules.');
  const seen = new Set();
  return rules.map((rule) => {
    if (!rule || typeof rule !== 'object') throw fail(400, 'INVALID_RULE', 'Enter a valid price rule.');
    const customerUserId = rule.customerUserId || null;
    const minimumQuantity = rule.minimumQuantity === '' || rule.minimumQuantity == null ? null : Number(rule.minimumQuantity);
    if (customerUserId && !mongoose.isValidObjectId(customerUserId)) throw fail(400, 'INVALID_CUSTOMER', 'Choose a valid customer.');
    if (minimumQuantity !== null && (!Number.isInteger(minimumQuantity) || minimumQuantity < 1 || minimumQuantity > 1000000000)) throw fail(400, 'INVALID_QUANTITY', 'Minimum quantity must be a whole number of at least one.');
    if (!customerUserId && minimumQuantity === null) throw fail(400, 'DEFAULT_RULE_NOT_ALLOWED', 'The default selling price is managed separately.');
    const condition = `${customerUserId || '*'}:${minimumQuantity ?? '*'}`;
    if (seen.has(condition)) throw fail(409, 'PRICE_RULE_OVERLAP', 'Two rules have the same customer and minimum quantity.');
    seen.add(condition);
    return { ...(rule.id && mongoose.isValidObjectId(rule.id) ? { _id: rule.id } : {}), customerUserId, minimumQuantity, sellingPrice: decimal(rule.sellingPrice, 'selling price', true), active: rule.active !== false };
  });
}
async function save(bid, uid, pid, body) {
  const { product } = await getContext(bid, uid, pid);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'INVALID_PRICING', 'Enter valid price details.');
  const patch = {};
  if (Object.hasOwn(body, 'purchaseCost')) patch.purchaseCost = decimal(body.purchaseCost, 'purchase cost');
  if (Object.hasOwn(body, 'taxInclusive')) {
    if (typeof body.taxInclusive !== 'boolean') throw fail(400, 'INVALID_TAX_INCLUSIVE', 'Choose whether the purchase price includes tax.');
    patch.taxInclusive = body.taxInclusive;
  }
  if (Object.hasOwn(body, 'separateTaxAmount')) patch.separateTaxAmount = decimal(body.separateTaxAmount, 'separate tax');
  if (Object.hasOwn(body, 'separateTaxId')) patch.separateTaxId = body.separateTaxId || null;
  if (Object.hasOwn(body, 'defaultSellingPrice')) patch.defaultSellingPrice = decimal(body.defaultSellingPrice, 'default selling price');
  if (Object.hasOwn(body, 'rules')) patch.rules = normalizeRules(body.rules);
  if (Object.hasOwn(body, 'variantPrices')) {
    const keys = new Set(productUnits.variations(product).map(variant => variant.key));
    const seen = new Set();
    const service = ['Services', 'Service'].includes(product.type);
    if (!Array.isArray(body.variantPrices) || body.variantPrices.length > keys.size) throw fail(400, 'INVALID_VARIANT_PRICE', 'Choose valid variant prices.');
    patch.variantPrices = body.variantPrices.map(price => {
      if (!price || !keys.has(price.variantKey) || seen.has(price.variantKey) || !rateModes.includes(price.basis) || (!service && price.basis !== 'fixed')) {
        throw fail(400, 'INVALID_VARIANT_PRICE', 'Choose a valid variant and rate basis.');
      }
      seen.add(price.variantKey);
      return { variantKey: price.variantKey, basis: price.basis, sellingPrice: decimal(price.sellingPrice, 'variant selling price'), purchaseCost: decimal(price.purchaseCost, 'variant purchase cost') };
    });
  }
  const nextTaxInclusive = patch.taxInclusive ?? (await Pricing.findOne({ businessId: bid, productId: pid }).select('taxInclusive').lean())?.taxInclusive ?? true;
  if (!nextTaxInclusive && patch.separateTaxAmount === undefined && patch.separateTaxId === undefined) {
    const old = await Pricing.findOne({ businessId: bid, productId: pid }).select('separateTaxAmount separateTaxId').lean();
    if (!old?.separateTaxAmount && !old?.separateTaxId) throw fail(400, 'SEPARATE_TAX_REQUIRED', 'Enter or select the separate tax when the purchase price excludes tax.');
  }
  if (patch.taxInclusive === true) { patch.separateTaxAmount = null; patch.separateTaxId = null; }
  if (patch.taxInclusive === false) {
    const taxId = patch.separateTaxId;
    if (taxId && (!mongoose.isValidObjectId(taxId) || !await Tax.exists({ _id: taxId, businessId: bid }))) throw fail(400, 'INVALID_TAX', 'Choose a tax from this business.');
    const amount = patch.separateTaxAmount;
    if (!taxId && amount == null) {
      const old = await Pricing.findOne({ businessId: bid, productId: pid }).select('separateTaxAmount').lean();
      if (!old?.separateTaxAmount) throw fail(400, 'SEPARATE_TAX_REQUIRED', 'Enter or select the separate tax.');
    }
  }
  if (patch.rules) {
    const customers = [...new Set(patch.rules.map(r => r.customerUserId).filter(Boolean))];
    if (customers.length && await User.countDocuments({ _id: { $in: customers } }) !== customers.length) throw fail(400, 'INVALID_CUSTOMER', 'One or more selected customers do not exist.');
  }
  const existing = await Pricing.findOne({ businessId: bid, productId: product._id });
  const expectedVersion = body.version;
  if (existing && expectedVersion !== undefined && expectedVersion !== existing.version) throw fail(409, 'PRICING_STALE', 'Pricing changed since it was opened. Reload and try again.');
  let saved;
  try {
    saved = await Pricing.findOneAndUpdate({ businessId: bid, productId: product._id, ...(existing && expectedVersion !== undefined ? { version: expectedVersion } : {}) }, existing
      ? { $set: { ...patch, updatedByUserId: uid }, $inc: { version: 1 } }
      : { $set: { ...patch, updatedByUserId: uid }, $setOnInsert: { businessId: bid, productId: product._id, createdByUserId: uid, version: 1 } }, { new: true, upsert: !existing, runValidators: true, setDefaultsOnInsert: false });
  } catch (error) { if (error.code === 11000) throw fail(409, 'PRICING_STALE', 'Pricing changed while this update was being saved. Reload and try again.'); throw error; }
  if (!saved) throw fail(409, 'PRICING_STALE', 'Pricing changed while this update was being saved. Reload and try again.');
  return present(product, saved);
}
async function saveWorkbook(bid, uid, pid, body) {
  const { product } = await getContext(bid, uid, pid);
  const existing = await Pricing.findOne({ businessId: bid, productId: product._id });
  if (existing && body.version !== undefined && body.version !== existing.version) throw fail(409, 'PRICING_STALE', 'Pricing changed since this workbook was validated. Validate it again.');
  const changes = body.ruleChanges || [];
  const normalized = normalizeRules(changes.map(rule => ({ id: rule.ruleId || undefined, customerUserId: rule.customerUserId, minimumQuantity: rule.minimumQuantity, sellingPrice: rule.sellingPrice, active: rule.active })));
  const customerIds = [...new Set(normalized.map(rule => rule.customerUserId).filter(Boolean).map(String))];
  if (customerIds.length && await User.countDocuments({ _id: { $in: customerIds } }) !== customerIds.length) throw fail(400, 'INVALID_CUSTOMER', 'One or more selected customers do not exist.');
  const doc = existing || new Pricing({ businessId: bid, productId: product._id, createdByUserId: uid, version: 1 });
  if (Object.hasOwn(body, 'defaultSellingPrice')) doc.defaultSellingPrice = decimal(body.defaultSellingPrice, 'default selling price');
  for (const rule of normalized) {
    if (rule._id) {
      const current = doc.rules.id(rule._id);
      if (!current) throw fail(404, 'RULE_NOT_FOUND', 'Price rule not found. Validate this workbook again.');
      current.customerUserId = rule.customerUserId; current.minimumQuantity = rule.minimumQuantity; current.sellingPrice = rule.sellingPrice; current.active = rule.active;
    } else doc.rules.push(rule);
  }
  doc.updatedByUserId = uid;
  if (existing) doc.version += 1;
  await doc.save();
  return present(product, doc);
}
async function bulk(bid, uid, body) {
  await access(bid, uid, 'business.pricing.manage');
  if (!body || !Array.isArray(body.productIds) || body.productIds.length < 1 || body.productIds.length > 500 || body.productIds.some(id => !mongoose.isValidObjectId(id))) throw fail(400, 'INVALID_BULK_SELECTION', 'Select between one and 500 products.');
  const products = await Product.find({ businessId: bid, _id: { $in: [...new Set(body.productIds)] } }).lean();
  if (products.length !== new Set(body.productIds).size) throw fail(404, 'PRODUCT_NOT_FOUND', 'One or more products were not found.');
  const { preview = false, ...values } = body;
  if (preview) {
    if (Object.hasOwn(values, 'defaultSellingPrice')) decimal(values.defaultSellingPrice, 'default selling price', true);
    if (Object.hasOwn(values, 'purchaseCost')) decimal(values.purchaseCost, 'purchase cost', true);
    if (Object.hasOwn(values, 'taxInclusive') && typeof values.taxInclusive !== 'boolean') throw fail(400, 'INVALID_TAX_INCLUSIVE', 'Choose whether the purchase price includes tax.');
    const before = await Pricing.find({ businessId: bid, productId: { $in: products.map(p => p._id) } }).lean();
    const byId = new Map(before.map(x => [String(x.productId), x]));
    return { items: products.map(p => ({ productId: String(p._id), name: p.name, oldValue: value(byId.get(String(p._id))?.[Object.hasOwn(values, 'purchaseCost') ? 'purchaseCost' : 'defaultSellingPrice']), newValue: Object.hasOwn(values, 'purchaseCost') ? String(values.purchaseCost) : String(values.defaultSellingPrice), changes: Object.keys(values).filter(k => ['defaultSellingPrice', 'purchaseCost', 'taxInclusive', 'separateTaxAmount'].includes(k)) })) };
  }
  const results = [];
  for (const product of products) {
    try { results.push({ productId: String(product._id), success: true, pricing: await save(bid, uid, String(product._id), values) }); }
    catch (error) { results.push({ productId: String(product._id), success: false, code: error.code || 'SAVE_FAILED' }); }
  }
  return { items: results, succeeded: results.filter(x => x.success).length, failed: results.filter(x => !x.success).length };
}
function resolveSellingPrice(defaultPrice, rules, customerId, quantity) {
  const matching = (rules || []).filter(rule => rule.active !== false
    && (!rule.customerUserId || String(rule.customerUserId) === String(customerId))
    && (rule.minimumQuantity == null || quantity >= rule.minimumQuantity))
    .sort((a, b) => Number(Boolean(b.customerUserId)) - Number(Boolean(a.customerUserId)) || (b.minimumQuantity || 0) - (a.minimumQuantity || 0));
  return matching.length ? matching[0].sellingPrice : defaultPrice;
}
module.exports = { list, save, saveWorkbook, bulk, present, resolveSellingPrice, lookupCustomer };
