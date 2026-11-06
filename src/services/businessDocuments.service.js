'use strict';
const mongoose = require('mongoose');
const Business = require('../DB/models/Business');
const BusinessOrder = require('../DB/models/BusinessOrder');
const BusinessLead = require('../DB/models/BusinessLead');
const BusinessOrderImage = require('../DB/models/BusinessOrderImage');
const BusinessBill = require('../DB/models/BusinessBill');
const BusinessDocumentNumberConfig = require('../DB/models/BusinessDocumentNumberConfig');
const BusinessPaymentAllocation = require('../DB/models/BusinessPaymentAllocation');
const Product = require('../DB/models/BusinessCatalogProduct');
const Unit = require('../DB/models/BusinessCatalogUnit');
const Tax = require('../DB/models/BusinessCatalogTax');
const Pricing = require('../DB/models/BusinessProductPricing');
const User = require('../DB/models/User');
const RateLimitWindow = require('../DB/models/RateLimitWindow');
const { access } = require('./businessPeopleTeams.service');
const { normalizePhone } = require('../utils/phone');

const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code, expose: statusCode < 500 });
const idOk = (id) => mongoose.isValidObjectId(id);
async function cleanupUnlinkedProvisionedUser(userId) {
  const [inOrder, inLead] = await Promise.all([BusinessOrder.exists({ contactUserId: userId }), BusinessLead.exists({ contactUserId: userId })]);
  if (!inOrder && !inLead) await User.deleteOne({ _id: userId, accountStatus: 'provisioned' });
}
const decimal = (value) => mongoose.Types.Decimal128.fromString(String(value));
function normalizeContactPhone(countryCallingCode, phoneNumber) {
  const callingCode = typeof countryCallingCode === 'string' ? countryCallingCode : '';
  const number = typeof phoneNumber === 'string' && callingCode && phoneNumber.startsWith(callingCode) ? phoneNumber.slice(callingCode.length) : phoneNumber;
  return normalizePhone(callingCode, number);
}
function validTimestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-](?:0\d|1[0-4]):[0-5]\d$/.test(value) || Number.isNaN(Date.parse(value))) throw fail(400, 'INVALID_DATE', `Enter a valid ${field} date with its timezone offset.`);
  return value;
}
function cleanContact(value, type) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'CONTACT_REQUIRED', 'Enter contact details.');
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 120) : '';
  if (!name) throw fail(400, 'CONTACT_NAME_REQUIRED', 'Contact name is required.');
  return { type, name, phone: String(value.phone || '').trim().slice(0, 40), address: typeof value.address === 'string' ? value.address.trim().slice(0, 1000) : '', addressParts: value.addressParts && typeof value.addressParts === 'object' ? value.addressParts : null };
}
const SCALE = 1000000n;
const CENT = 10000n;
function micro(value, field, positive = false) {
  const text = String(value ?? '').trim(); const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw fail(400, 'INVALID_AMOUNT', `Enter a valid ${field} with up to 6 decimal places.`);
  const fraction = (match[2] || '').padEnd(6, ''); const result = BigInt(match[1]) * SCALE + BigInt(fraction || '0');
  if (positive && result <= 0n) throw fail(400, 'INVALID_AMOUNT', `Enter a positive ${field}.`);
  return result;
}
function divideRound(numerator, denominator) { return (numerator + denominator / 2n) / denominator; }
function currency(value) { return divideRound(value, CENT) * CENT; }
function moneyText(value) { const cents = divideRound(value, CENT); const whole = cents / 100n; const frac = String(cents % 100n).padStart(2, '0'); return `${whole}.${frac}`; }
function calendarDate(value) { if (typeof value === 'string') return value.slice(0, 10); const date = value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10); }
function discountAmount(base, discount) {
  if (!discount) return { amount: 0n, snapshot: null };
  const type = discount.type; const value = micro(discount.value, 'discount');
  if (!['fixed', 'percentage'].includes(type) || (type === 'percentage' && value > 100n * SCALE)) throw fail(400, 'INVALID_DISCOUNT', 'Enter a valid discount.');
  const applied = currency(type === 'percentage' ? divideRound(base * value, 100n * SCALE) : value);
  if (applied > base) throw fail(400, 'DISCOUNT_EXCEEDS_TOTAL', 'Discount cannot exceed the eligible amount.');
  return { amount: applied, snapshot: { type, value: String(discount.value), amount: moneyText(applied), basis: moneyText(base) } };
}
function calculate(lines, discounts, taxes) {
  const normalized = (lines || []).map(line => {
    const quantity = micro(line.quantity, 'quantity', true); const price = micro(line.unitPrice, 'unit price');
    const gross = currency(divideRound(quantity * price, SCALE)); const lineDiscount = discountAmount(gross, line.discount); const net = gross - lineDiscount.amount;
    return { ...line, quantity: String(line.quantity), unitPrice: String(line.unitPrice), grossTotal: moneyText(gross), discount: lineDiscount.snapshot, lineTotal: moneyText(net) };
  });
  const subtotal = normalized.reduce((sum, line) => sum + micro(line.lineTotal, 'line total'), 0n);
  const documentDiscount = discountAmount(subtotal, discounts?.[0]); const afterDiscount = subtotal - documentDiscount.amount;
  const taxSnapshots = (taxes || []).map(tax => {
    const value = micro(tax.value, 'tax value'); const amount = currency(tax.calculationType === 'percentage' ? divideRound(afterDiscount * value, 100n * SCALE) : value);
    return { ...tax, amount: moneyText(amount), basis: moneyText(afterDiscount) };
  });
  const taxTotal = taxSnapshots.reduce((sum, tax) => sum + micro(tax.amount, 'tax amount'), 0n);
  return { lines: normalized, subtotal: decimal(moneyText(subtotal)), discounts: documentDiscount.snapshot ? [documentDiscount.snapshot] : [], discountTotal: decimal(moneyText(documentDiscount.amount)), afterDiscount: decimal(moneyText(afterDiscount)), taxes: taxSnapshots, taxTotal: decimal(moneyText(taxTotal)), grandTotal: decimal(moneyText(afterDiscount + taxTotal)) };
}
function amountNumber(value, field, min = 0) { const amount = Number(value); if (!Number.isFinite(amount) || amount < min || amount > 1e12) throw fail(400, 'INVALID_AMOUNT', `Enter a valid ${field}.`); return amount; }
async function authorize(businessId, userId, permission) { return access(businessId, userId, permission); }
function pageValues(query) { const page = Math.max(1, Number.parseInt(query.page, 10) || 1); const pageSize = Math.min(50, Math.max(1, Number.parseInt(query.pageSize, 10) || 20)); return { page, pageSize, skip: (page - 1) * pageSize }; }
function serialize(document) {
  const value = document.toObject ? document.toObject() : document;
  for (const field of ['subtotal', 'discountTotal', 'afterDiscount', 'taxTotal', 'grandTotal']) if (value[field]?.toString) value[field] = value[field].toString();
  return { ...value, id: String(value._id), businessId: String(value.businessId), sourceLeadId: value.sourceLeadId ? String(value.sourceLeadId) : null, convertedOrderId: value.convertedOrderId ? String(value.convertedOrderId) : null, imageIds: (value.imageIds || []).map(String) };
}
async function attachBillSummaries(bid, documents, isLead = false) {
  if (!documents.length) return documents;
  const ids = documents.map(item => item._id);
  const filter = isLead ? { businessId: bid, leadId: { $in: ids } } : { businessId: bid, orderId: { $in: ids } };
  const bills = await BusinessBill.find({ ...filter, deletedAt: null }).sort({ createdAt: 1 }).lean();
  if (!bills.length) return documents;
  const billIds = bills.map(bill => bill._id);
  const paidRows = await BusinessPaymentAllocation.aggregate([{ $match: { businessId: new mongoose.Types.ObjectId(bid), billId: { $in: billIds }, reversedAt: null } }, { $group: { _id: '$billId', amount: { $sum: '$amount' } } }]);
  const paid = new Map(paidRows.map(row => [String(row._id), Number(row.amount.toString())]));
  const today = new Date().toISOString().slice(0, 10); const grouped = new Map();
  for (const bill of bills) {
    const key = String(isLead ? bill.leadId : bill.orderId); const amount = Number(bill.grandTotal.toString()); const settled = paid.get(String(bill._id)) || 0; const outstanding = Math.max(0, amount - settled);
    const paymentStatus = bill.status === 'cancelled' ? 'cancelled' : outstanding <= 0 ? 'paid' : settled > 0 ? 'partially_paid' : bill.dueDate < today ? 'overdue' : 'unpaid';
    const view = { id: String(bill._id), number: bill.billNumber || '', deliveryStatus: bill.deliveryStatus, paymentStatus, outstanding: outstanding.toFixed(2), total: amount.toFixed(2) };
    if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(view);
  }
  return documents.map(document => ({ ...document, billSummaries: grouped.get(String(document._id)) || [] }));
}
async function list(model, businessId, userId, permission, query, isLead = false) {
  const ctx = await authorize(businessId, userId, permission); const { page, pageSize, skip } = pageValues(query);
  const filter = { businessId, deletedAt: null };
  if (query.status && ['open', 'confirmed', 'billed', 'delivered', 'ordered', 'completed_billed', 'converted', 'cancelled'].includes(query.status)) filter.status = query.status;
  if (!isLead && query.orderType && ['sales', 'purchase'].includes(query.orderType)) filter.orderType = query.orderType;
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 80) : '';
  if (search) { const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); filter.$or = [isLead ? { leadNumber: rx } : { orderNumber: rx }, { 'contactSnapshot.name': rx }, { 'contactSnapshot.phone': rx }]; }
  const [items, total] = await Promise.all([model.find(filter).sort({ documentDate: -1, createdAt: -1 }).skip(skip).limit(pageSize).lean(), model.countDocuments(filter)]);
  const serialized = items.map(serialize); const withBills = await attachBillSummaries(businessId, items, isLead); const billById = new Map(withBills.map((item, index) => [String(item._id), item.billSummaries]));
  return { items: serialized.map(item => ({ ...item, billSummaries: billById.get(item.id) || [] })), page, pageSize, total, hasNextPage: page * pageSize < total, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function listOrders(bid, uid, query) { const type = ['sales', 'purchase'].includes(query.orderType) ? query.orderType : undefined; if (type) await authorize(bid, uid, 'business.orders.view'); return list(BusinessOrder, bid, uid, 'business.orders.view', query); }
async function listLeads(bid, uid, query) { return list(BusinessLead, bid, uid, 'business.leads.view', query, true); }
async function summary(bid, uid) {
  const ctx = await authorize(bid, uid, 'dashboard.view');
  const [orders, leads] = await Promise.all([
    ctx.keys.has('business.orders.view') ? BusinessOrder.countDocuments({ businessId: bid, deletedAt: null, status: { $in: ['open', 'confirmed', 'billed', 'delivered', 'completed_billed'] } }) : Promise.resolve(null),
    ctx.keys.has('business.leads.view') ? BusinessLead.countDocuments({ businessId: bid, deletedAt: null, status: 'open' }) : Promise.resolve(null),
  ]);
  const billCount = ctx.keys.has('business.bills.view') ? await BusinessBill.countDocuments({ businessId: bid, deletedAt: null, status: { $ne: 'cancelled' } }) : null;
  return { orderCount: orders, leadCount: leads, billCount };
}
async function get(model, bid, uid, id, permission, isLead = false) {
  await authorize(bid, uid, permission); if (!idOk(id)) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
  const document = await model.findOne({ _id: id, businessId: bid, deletedAt: null }).lean(); if (!document) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
  const out = serialize(document);
  const billSummaries = await attachBillSummaries(bid, [document], isLead);
  out.billSummaries = billSummaries[0]?.billSummaries || [];
  if (out.imageIds?.length && !isLead) out.imageMetadata = await BusinessOrderImage.find({ _id: { $in: out.imageIds }, businessId: bid, orderId: id, deletedAt: null }).select('-fileId').sort({ createdAt: 1 }).lean();
  return out;
}
async function taxSnapshot(bid, productIds, documentDate, suppliedIds) {
  const business = await Business.findById(bid).select('businessTaxComponentIds').lean();
  const products = productIds.length ? await Product.find({ businessId: bid, _id: { $in: productIds } }).select('taxMode taxComponentIds').lean() : [];
  if (products.length !== productIds.length) throw fail(400, 'INVALID_PRODUCT', 'One or more products are unavailable.');
  const ids = new Set();
  if (suppliedIds == null) {
    for (const id of business?.businessTaxComponentIds || []) ids.add(String(id));
    for (const product of products) if (product.taxMode === 'specific') for (const id of product.taxComponentIds || []) ids.add(String(id));
  } else {
    for (const id of suppliedIds) { if (!idOk(id)) throw fail(400, 'INVALID_TAX', 'Choose a valid tax component.'); ids.add(String(id)); }
  }
  const orderDate = calendarDate(documentDate);
  const taxes = await Tax.find({ businessId: bid, _id: { $in: [...ids] } }).lean();
  return taxes.filter(tax => calendarDate(tax.effectiveStart) <= orderDate && (!tax.effectiveEnd || calendarDate(tax.effectiveEnd) >= orderDate))
    .map(tax => ({ taxId: String(tax._id), name: tax.name, calculationType: tax.calculationType, value: String(tax.value), currency: tax.currency || '', jurisdiction: tax.jurisdiction || '', description: tax.description || '', effectiveStart: tax.effectiveStart?.toISOString() || null, effectiveEnd: tax.effectiveEnd?.toISOString() || null, revision: tax.updatedAt?.toISOString() || tax.createdAt?.toISOString() }));
}
async function normalizeDocument(bid, uid, body, type, old = null) {
  const entryMode = body.entryMode || old?.entryMode || 'detailed';
  if (!['detailed', 'image_only'].includes(entryMode)) throw fail(400, 'INVALID_ENTRY_MODE', 'Choose a valid order entry mode.');
  const documentDate = validTimestamp(body.documentDate || old?.documentDate, 'order');
  const createdAtClient = old?.createdAtClient || validTimestamp(body.createdAtClient, 'creation');
  const contactType = type === 'purchase' ? 'supplier' : 'customer';
  let contactSnapshot = null; let contactUserId = null;
  let calculated = { lines: [], subtotal: null, discounts: [], discountTotal: null, afterDiscount: null, taxes: [], taxTotal: null, grandTotal: null };
  if (entryMode === 'detailed') {
    contactSnapshot = cleanContact(body.contact || old?.contactSnapshot, contactType);
    const phone = body.contact?.countryCallingCode && body.contact?.phoneNumber ? normalizeContactPhone(body.contact.countryCallingCode, body.contact.phoneNumber) : null;
    if (type === 'sales') {
      if (!phone) throw fail(400, 'INVALID_PHONE', 'Enter a valid customer phone number.');
      const user = await User.findOne({ phoneE164: phone }).select('_id').lean();
      contactUserId = user?._id || null; contactSnapshot.phone = phone;
    } else if (body.contactUserId || old?.contactUserId) {
      const contactId = body.contactUserId || old.contactUserId; if (!idOk(contactId)) throw fail(400, 'INVALID_CONTACT', 'Choose a valid contact.');
      const user = await User.findById(contactId).select('displayName phoneE164').lean(); if (!user) throw fail(400, 'INVALID_CONTACT', 'Choose a valid contact.');
      contactUserId = user._id; contactSnapshot.name = contactSnapshot.name || user.displayName; contactSnapshot.phone = contactSnapshot.phone || user.phoneE164;
    }
    const customerChanged = Boolean(old && (String(old.contactUserId || '') !== String(contactUserId || '') || String(old.contactSnapshot?.phone || '') !== String(contactSnapshot?.phone || '')));
    const linesInput = Array.isArray(body.lines) ? body.lines : (old?.lines || []);
    if (!linesInput.length || linesInput.length > 100) throw fail(400, 'LINES_REQUIRED', 'Add at least one product.');
    const productIds = [...new Set(linesInput.map(x => String(x.productId || '')))];
    if (productIds.some(id => !idOk(id))) throw fail(400, 'INVALID_PRODUCT', 'Choose a valid product.');
    const products = await Product.find({ businessId: bid, _id: { $in: productIds } }).lean(); if (products.length !== productIds.length) throw fail(400, 'INVALID_PRODUCT', 'One or more products are unavailable.');
    const productById = new Map(products.map(x => [String(x._id), x]));
    const lines = [];
    for (const line of linesInput) {
      const product = productById.get(String(line.productId));
      const unitId = String(line.unitId || product.baseUnitId || '');
      if (!idOk(unitId)) throw fail(400, 'INVALID_UNIT', 'Choose a valid product unit.');
      const unit = await Unit.findOne({ _id: unitId, businessId: bid }).lean();
      const unitAllowed = String(product.baseUnitId) === unitId || (product.additionalUnits || []).some(x => String(x.unitId) === unitId);
      if (!unit || !unitAllowed) throw fail(400, 'INVALID_UNIT', 'Choose an available unit for each product.');
      const oldLine = old?.lines?.find(saved => String(saved.productId) === String(line.productId) && String(saved.unitId) === unitId);
      let sourcePrice = null; let sourceRevision = null; let priceOrigin = line.manualOverride || line.priceOrigin === 'manual' ? 'manual' : 'master'; let unitPrice = line.unitPrice;
      const pricing = await Pricing.findOne({ businessId: bid, productId: product._id }).lean();
      if (type === 'sales' && pricing) {
        const matches = (pricing.rules || []).filter(rule => rule.active && (!rule.customerUserId || String(rule.customerUserId) === String(contactUserId)) && (rule.minimumQuantity == null || Number(line.quantity) >= rule.minimumQuantity))
          .sort((a, b) => Number(Boolean(b.customerUserId)) - Number(Boolean(a.customerUserId)) || (b.minimumQuantity || 0) - (a.minimumQuantity || 0));
        const selected = matches[0]; sourcePrice = selected ? selected.sellingPrice?.toString() : pricing.defaultSellingPrice?.toString();
        sourceRevision = selected?._id ? `${pricing.version}:${selected._id}:${selected.updatedAt?.toISOString() || ''}` : `${pricing.version}:default:${pricing.updatedAt?.toISOString() || ''}`;
        if (priceOrigin === 'master' && sourcePrice != null) unitPrice = sourcePrice;
      } else if (type === 'purchase' && pricing?.purchaseCost != null) {
        sourcePrice = pricing.purchaseCost.toString(); sourceRevision = `${pricing.version}:purchase:${pricing.updatedAt?.toISOString() || ''}`;
        if (priceOrigin === 'master') unitPrice = sourcePrice;
      }
      // Saved snapshots remain authoritative on an ordinary edit. Re-resolve only
      // when customer/quantity changed or the row is new; manual overrides survive.
      if (oldLine && !oldLine.manualOverride && !customerChanged && String(oldLine.quantity) === String(line.quantity)) {
        unitPrice = oldLine.unitPrice; sourcePrice = oldLine.sourcePrice; sourceRevision = oldLine.sourcePriceRevision; priceOrigin = oldLine.priceOrigin || 'master';
      }
      if (unitPrice == null || unitPrice === '') throw fail(400, 'PRICE_REQUIRED', `Enter a price for ${product.name}.`);
      lines.push({ ...line, productId: String(product._id), productName: product.name, productCode: product.code || '', productDescription: product.description || '', unitId, unitLabel: unit.name, conversionFactor: String(product.baseUnitId && String(product.baseUnitId) === unitId ? 1 : product.additionalUnits.find(x => String(x.unitId) === unitId)?.conversionFactor || 1), priceOrigin: sourcePrice == null ? 'manual' : priceOrigin, sourcePrice, sourcePriceRevision: sourceRevision, unitPrice: String(unitPrice), manualOverride: priceOrigin === 'manual' });
    }
    const desiredDiscounts = body.discounts ?? old?.discounts ?? [];
    const requestedTaxes = body.taxes;
    const taxSelectionSet = Array.isArray(requestedTaxes) || old?.taxSelectionSet === true;
    const taxIds = Array.isArray(requestedTaxes) ? requestedTaxes.map(tax => String(tax.taxId)) : old?.taxSelectionSet ? (old.taxes || []).map(tax => String(tax.taxId)) : undefined;
    const currentTaxes = await taxSnapshot(bid, products.map(x => x._id), documentDate, taxIds);
    const oldTaxes = new Map((old?.taxes || []).map(tax => [String(tax.taxId), tax]));
    const currentTaxById = new Map(currentTaxes.map(tax => [String(tax.taxId), tax]));
    const selectedTaxIds = taxIds || currentTaxes.map(tax => String(tax.taxId));
    const taxes = [...new Set(selectedTaxIds)].map(id => oldTaxes.get(String(id)) || currentTaxById.get(String(id))).filter(Boolean);
    if (taxIds && taxes.length !== new Set(taxIds).size) throw fail(400, 'INVALID_TAX', 'One or more selected tax components are not effective on the document date.');
    calculated = calculate(lines, desiredDiscounts, taxes);
    calculated.taxSelectionSet = taxSelectionSet;
  }
  return { entryMode, documentDate, createdAtClient, contactType: entryMode === 'detailed' ? contactType : null, contactUserId, contactSnapshot, currencyCode: old?.currencyCode || null, currencyScale: old?.currencyScale ?? null, taxSelectionSet: calculated.taxSelectionSet ?? old?.taxSelectionSet ?? false, ...calculated };
}
async function validateDeliveredOrderStock(bid, orderType, entryMode, lines, deliveryCompleted) {
  if (deliveryCompleted && orderType === 'sales' && entryMode === 'detailed') await require('./businessInventory.service').validateBillStock(bid, { billType: 'sale', lines });
}
async function nextNumber(Model, bid, prefix, field) { const count = await Model.countDocuments({ businessId: bid }); return `${prefix}-${String(count + 1).padStart(5, '0')}`; }
async function createOrder(bid, uid, body, idempotencyKey) {
  if (body?.entryMode === 'image_only') throw fail(400, 'IMAGE_ORDER_UPLOAD_REQUIRED', 'Create an image-only order through the image upload flow.');
  const type = body?.orderType; if (!['sales', 'purchase'].includes(type)) throw fail(400, 'INVALID_ORDER_TYPE', 'Choose Sales Order or Purchase Order.');
  const ctx = await authorize(bid, uid, 'business.orders.create');
  if ((Array.isArray(body.discounts) && body.discounts.length) || (body.lines || []).some(line => line.discount)) await authorize(bid, uid, 'business.orders.discount.manage');
  if (Array.isArray(body.taxes)) await authorize(bid, uid, 'business.orders.tax.manage');
  const key = typeof idempotencyKey === 'string' ? idempotencyKey.slice(0, 120) : null;
  if (key) { const prior = await BusinessOrder.findOne({ businessId: bid, idempotencyKey: key }); if (prior) return serialize(prior); }
  const normalized = await normalizeDocument(bid, uid, body, type);
  const deliveryCompleted = Boolean(body.deliveryCompleted);
  await validateDeliveredOrderStock(bid, type, normalized.entryMode, normalized.lines, deliveryCompleted);
  if (normalized.entryMode === 'image_only' && body.acknowledgedNoStoreChange !== true) throw fail(400, 'IMAGE_ACK_REQUIRED', 'Confirm that uploading an image does not change the store.');
  if (normalized.entryMode === 'image_only' && (!Array.isArray(body.imageIds) || !body.imageIds.length)) throw fail(400, 'ORDER_IMAGE_REQUIRED', 'Upload at least one order image.');
  const numberConfig = await BusinessDocumentNumberConfig.findOne({ businessId: bid }).lean();
  const orderNumber = await nextNumber(BusinessOrder, bid, type === 'sales' ? (numberConfig?.orderSalesPrefix || 'SO') : (numberConfig?.orderPurchasePrefix || 'PO'), 'orderNumber');
  let provisionedUser = null;
  if (type === 'sales' && !normalized.contactUserId) {
    try { provisionedUser = await User.create({ phoneE164: normalized.contactSnapshot.phone, displayName: normalized.contactSnapshot.name, accountStatus: 'provisioned' }); normalized.contactUserId = provisionedUser._id; }
    catch (error) { if (error.code === 11000) normalized.contactUserId = (await User.findOne({ phoneE164: normalized.contactSnapshot.phone }).select('_id').lean())?._id || null; else throw error; }
  }
  try {
    const now = new Date(); const order = await BusinessOrder.create({ businessId: bid, orderNumber, orderType: type, ...normalized, imageIds: body.imageIds || [], imageMetadata: body.imageMetadata || [], deliveryCompleted, deliveredAt: deliveryCompleted ? now : null, status: deliveryCompleted ? 'delivered' : 'open', idempotencyKey: key, createdByUserId: uid, updatedByUserId: uid, lifecycleEvents: [{ action: deliveryCompleted ? 'created_delivered' : 'created', actorUserId: uid, at: now }] });
    return serialize(order);
  } catch (error) { if (provisionedUser) await cleanupUnlinkedProvisionedUser(provisionedUser._id); throw error; }
}
async function createLead(bid, uid, body, idempotencyKey) {
  await authorize(bid, uid, 'business.leads.create');
  if ((Array.isArray(body.discounts) && body.discounts.length) || (body.lines || []).some(line => line.discount)) await authorize(bid, uid, 'business.leads.discount.manage');
  if (Array.isArray(body.taxes)) await authorize(bid, uid, 'business.leads.tax.manage');
  const key = typeof idempotencyKey === 'string' ? idempotencyKey.slice(0, 120) : null;
  if (key) { const prior = await BusinessLead.findOne({ businessId: bid, idempotencyKey: key }); if (prior) return serialize(prior); }
  const normalized = await normalizeDocument(bid, uid, body, 'sales');
  const leadNumber = await nextNumber(BusinessLead, bid, 'LD', 'leadNumber');
  let provisionedUser = null;
  if (!normalized.contactUserId) {
    try { provisionedUser = await User.create({ phoneE164: normalized.contactSnapshot.phone, displayName: normalized.contactSnapshot.name, accountStatus: 'provisioned' }); normalized.contactUserId = provisionedUser._id; }
    catch (error) { if (error.code === 11000) normalized.contactUserId = (await User.findOne({ phoneE164: normalized.contactSnapshot.phone }).select('_id').lean())?._id || null; else throw error; }
  }
  try { const lead = await BusinessLead.create({ businessId: bid, leadNumber, ...normalized, createdByUserId: uid, updatedByUserId: uid, idempotencyKey: key, lifecycleEvents: [{ action: 'created', actorUserId: uid, at: new Date() }] }); return serialize(lead); }
  catch (error) { if (provisionedUser) await cleanupUnlinkedProvisionedUser(provisionedUser._id); throw error; }
}
async function updateDocument(Model, bid, uid, id, body, type, isLead = false) {
  const basePermission = isLead ? 'business.leads.edit' : 'business.orders.edit'; await authorize(bid, uid, basePermission);
  const document = await Model.findOne({ _id: id, businessId: bid, deletedAt: null });
  if (!document) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
  if (document.status !== 'open') throw fail(409, 'DOCUMENT_IMMUTABLE', 'Only open documents can be edited.');
  if (Number(body.version) !== document.version) throw fail(409, 'DOCUMENT_STALE', 'This document changed elsewhere. Reload and try again.');
  if (!isLead && document.entryMode === 'image_only') {
    if (body.entryMode !== 'image_only') throw fail(400, 'INVALID_ENTRY_MODE', 'Image-only orders must remain image-only.');
    if (body.acknowledgedNoStoreChange !== true) throw fail(400, 'IMAGE_ACK_REQUIRED', 'Confirm that the image will not change the store.');
    if (!document.imageIds.length) throw fail(400, 'ORDER_IMAGE_REQUIRED', 'Upload one order image before saving.');
    const imageDate = validTimestamp(body.documentDate, 'order'); const code = String(body.currencyCode || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw fail(409, 'CURRENCY_NOT_CONFIGURED', 'Choose a valid three-letter order currency before saving this order.');
    const taxable = moneyText(micro(body.imageAmounts?.taxableAmount, 'taxable amount')); const tax = moneyText(micro(body.imageAmounts?.taxAmount ?? '0', 'tax amount'));
    const total = moneyText(micro(taxable, 'taxable amount') + micro(tax, 'tax amount'));
    const contactType = type === 'purchase' ? 'supplier' : 'customer'; const phone = normalizeContactPhone(body.contact?.countryCallingCode, body.contact?.phoneNumber);
    if (!phone) throw fail(400, 'INVALID_PHONE', 'Enter a valid customer or supplier phone number.');
    const contactSnapshot = cleanContact({ ...body.contact, phone }, contactType);
    let contactUserId = (await User.findOne({ phoneE164: phone }).select('_id').lean())?._id || null; let provisionedUser = null;
    if (type === 'sales' && !contactUserId) {
      try { provisionedUser = await User.create({ phoneE164: phone, displayName: contactSnapshot.name, accountStatus: 'provisioned' }); contactUserId = provisionedUser._id; }
      catch (error) { if (error.code === 11000) contactUserId = (await User.findOne({ phoneE164: phone }).select('_id').lean())?._id || null; else throw error; }
    }
    const imageAmounts = { taxableAmount: taxable, taxAmount: tax, taxDescription: String(body.imageAmounts?.taxDescription || '').trim().slice(0, 120) };
    const delivered = Boolean(body.deliveryCompleted); const now = new Date();
    Object.assign(document, { documentDate: imageDate, contactType, contactUserId, contactSnapshot, currencyCode: code, currencyScale: 2, imageAmounts, subtotal: decimal(taxable), discountTotal: decimal('0.00'), afterDiscount: decimal(taxable), taxTotal: decimal(tax), grandTotal: decimal(total), deliveryCompleted: delivered, deliveredAt: delivered ? now : null, status: delivered ? 'delivered' : 'open', updatedByUserId: uid, version: document.version + 1 });
    document.lifecycleEvents.push({ action: 'updated_image_only', actorUserId: uid, at: now });
    try { await document.save(); return serialize(document); }
    catch (error) { if (provisionedUser) await cleanupUnlinkedProvisionedUser(provisionedUser._id); throw error; }
  }
  const discountSelection = value => JSON.stringify({ order: (value.discounts || []).map(item => ({ type: item.type, value: String(item.value) })), lines: (value.lines || []).map(line => ({ productId: String(line.productId), unitId: String(line.unitId), type: line.discount?.type || null, value: line.discount ? String(line.discount.value) : null })).sort((a, b) => `${a.productId}:${a.unitId}`.localeCompare(`${b.productId}:${b.unitId}`)) });
  const taxSelection = value => JSON.stringify((value.taxes || []).map(tax => String(tax.taxId)).sort());
  const beforeDiscount = discountSelection(document); const beforeTaxes = taxSelection(document);
  const normalized = await normalizeDocument(bid, uid, body, type || 'sales', document.toObject());
  const deliveryCompleted = !isLead && Boolean(body.deliveryCompleted);
  await validateDeliveredOrderStock(bid, type || 'sales', normalized.entryMode, normalized.lines, deliveryCompleted);
  const discountKey = isLead ? 'business.leads.discount.manage' : 'business.orders.discount.manage';
  const taxKey = isLead ? 'business.leads.tax.manage' : 'business.orders.tax.manage';
  if (discountSelection(normalized) !== beforeDiscount) await authorize(bid, uid, discountKey);
  if (taxSelection(normalized) !== beforeTaxes) await authorize(bid, uid, taxKey);
  const now = new Date(); Object.assign(document, normalized, { updatedByUserId: uid, version: document.version + 1 });
  if (!isLead) { document.deliveryCompleted = deliveryCompleted; document.deliveredAt = deliveryCompleted ? (document.deliveredAt || now) : null; if (deliveryCompleted) document.status = 'delivered'; }
  document.lifecycleEvents.push({ action: deliveryCompleted ? 'updated_delivered' : 'updated', actorUserId: uid, at: now });
  await document.save(); if (!isLead && deliveryCompleted) await syncLeadOrderStatus(document, uid, 'source_order_marked_delivered'); return serialize(document);
}
async function updateOrder(bid, uid, id, body) {
  if (!idOk(id)) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
  const found = await BusinessOrder.findOne({ _id: id, businessId: bid, deletedAt: null }).select('orderType').lean(); if (!found) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
  return updateDocument(BusinessOrder, bid, uid, id, body, found.orderType);
}
async function updateLead(bid, uid, id, body) { if (!idOk(id)) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Document not found.'); return updateDocument(BusinessLead, bid, uid, id, body, 'sales', true); }
async function softDelete(Model, bid, uid, id, isLead = false) {
  await authorize(bid, uid, isLead ? 'business.leads.delete' : 'business.orders.delete');
  const document = await Model.findOne({ _id: id, businessId: bid, deletedAt: null }); if (!document) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
  if (document.status !== 'open') throw fail(409, 'DOCUMENT_IMMUTABLE', 'Only open documents can be deleted.');
  if (!isLead && document.entryMode === 'image_only') {
    const images = await BusinessOrderImage.find({ businessId: bid, orderId: id, deletedAt: null }).lean();
    for (const image of images) { await imageBucket().delete(image.fileId).catch(() => undefined); await BusinessOrderImage.updateOne({ _id: image._id }, { $set: { deletedAt: new Date() } }); }
  }
  document.deletedAt = new Date(); document.deletedByUserId = uid; document.lifecycleEvents.push({ action: 'deleted', actorUserId: uid, at: new Date() }); await document.save(); return { deleted: true };
}
async function convertLead(bid, uid, id, mode, version, idempotencyKey, deliveryCompleted = false) {
  await authorize(bid, uid, mode === 'bill' ? 'business.leads.convertToBill' : 'business.leads.convert'); await authorize(bid, uid, 'business.orders.create');
  if (!idOk(id) || !['order', 'bill'].includes(mode)) throw fail(400, 'INVALID_CONVERSION', 'Choose a valid Lead conversion.');
  const lead = await BusinessLead.findOne({ _id: id, businessId: bid, deletedAt: null }); if (!lead) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Lead not found.');
  if (lead.convertedOrderId) {
    const existingOrder = await BusinessOrder.findOne({ _id: lead.convertedOrderId, businessId: bid, deletedAt: null });
    if (!existingOrder) throw fail(404, 'DOCUMENT_NOT_FOUND', 'The Lead order could not be found.');
    if (mode === 'bill' && !existingOrder.billStatus && ['open', 'confirmed'].includes(existingOrder.status)) {
      if (Number(version) !== lead.version) throw fail(409, 'DOCUMENT_STALE', 'This Lead changed elsewhere. Reload and try again.');
      deliveryCompleted = Boolean(deliveryCompleted); await validateDeliveredOrderStock(bid, existingOrder.orderType, existingOrder.entryMode, existingOrder.lines, deliveryCompleted);
      const now = new Date(); existingOrder.billStatus = deliveryCompleted ? 'delivered' : 'draft'; existingOrder.billGeneratedAt = now; existingOrder.confirmedAt ||= now; existingOrder.deliveryCompleted = deliveryCompleted; existingOrder.status = deliveryCompleted ? 'delivered' : 'billed'; if (deliveryCompleted) existingOrder.deliveredAt = now; existingOrder.version += 1; existingOrder.updatedByUserId = uid; existingOrder.lifecycleEvents.push({ action: deliveryCompleted ? 'bill_generated_and_delivered_from_lead' : 'bill_generated_from_lead', sourceLeadId: lead._id, actorUserId: uid, at: now }); await existingOrder.save();
      lead.status = deliveryCompleted ? 'delivered' : 'billed'; lead.orderStatus = existingOrder.status; lead.billStatus = existingOrder.billStatus; lead.billGeneratedAt = now; lead.deliveryCompleted = deliveryCompleted; lead.version += 1; lead.updatedByUserId = uid; lead.lifecycleEvents.push({ action: deliveryCompleted ? 'bill_generated_and_delivered' : 'bill_generated', orderId: existingOrder._id, actorUserId: uid, at: now }); await lead.save();
    } else if (mode === 'bill' && deliveryCompleted && existingOrder.billStatus && existingOrder.status !== 'delivered') {
      if (Number(version) !== lead.version) throw fail(409, 'DOCUMENT_STALE', 'This Lead changed elsewhere. Reload and try again.');
      await validateDeliveredOrderStock(bid, existingOrder.orderType, existingOrder.entryMode, existingOrder.lines, true);
      const now = new Date(); existingOrder.billStatus = 'delivered'; existingOrder.deliveryCompleted = true; existingOrder.deliveredAt = now; existingOrder.status = 'delivered'; existingOrder.version += 1; existingOrder.updatedByUserId = uid; existingOrder.lifecycleEvents.push({ action: 'bill_delivered_from_lead', sourceLeadId: lead._id, actorUserId: uid, at: now }); await existingOrder.save();
      lead.status = 'delivered'; lead.orderStatus = existingOrder.status; lead.billStatus = existingOrder.billStatus; lead.deliveryCompleted = true; lead.version += 1; lead.updatedByUserId = uid; lead.lifecycleEvents.push({ action: 'bill_delivered', orderId: existingOrder._id, actorUserId: uid, at: now }); await lead.save();
    }
    return serialize(existingOrder);
  }
  if (lead.status !== 'open' || Number(version) !== lead.version) throw fail(409, 'DOCUMENT_STALE', 'This Lead changed elsewhere. Reload and try again.');
  const numberConfig = await BusinessDocumentNumberConfig.findOne({ businessId: bid }).lean();
  const number = await nextNumber(BusinessOrder, bid, numberConfig?.orderSalesPrefix || 'SO', 'orderNumber');
  const now = new Date(); deliveryCompleted = mode === 'bill' && Boolean(deliveryCompleted);
  await validateDeliveredOrderStock(bid, 'sales', 'detailed', lead.lines, deliveryCompleted);
  const orderStatus = mode === 'bill' ? (deliveryCompleted ? 'delivered' : 'billed') : 'open';
  const billStatus = mode === 'bill' ? (deliveryCompleted ? 'delivered' : 'draft') : null;
  const order = await BusinessOrder.create({ businessId: bid, orderNumber: number, orderType: 'sales', entryMode: 'detailed', status: orderStatus, billStatus, billGeneratedAt: mode === 'bill' ? now : null, confirmedAt: mode === 'bill' ? now : null, deliveredAt: deliveryCompleted ? now : null, deliveryCompleted, sourceLeadId: lead._id, conversionMode: mode, contactType: 'customer', contactUserId: lead.contactUserId, contactSnapshot: lead.contactSnapshot, documentDate: lead.documentDate, createdAtClient: lead.createdAtClient, currencyCode: lead.currencyCode, currencyScale: lead.currencyScale, lines: lead.lines, subtotal: lead.subtotal, discounts: lead.discounts, discountTotal: lead.discountTotal, afterDiscount: lead.afterDiscount, taxes: lead.taxes, taxSelectionSet: lead.taxSelectionSet, taxTotal: lead.taxTotal, grandTotal: lead.grandTotal, createdByUserId: uid, updatedByUserId: uid, idempotencyKey: idempotencyKey || null, lifecycleEvents: [{ action: `lead_converted_${mode}`, sourceLeadId: lead._id, actorUserId: uid, at: now }] });
  lead.status = mode === 'order' ? 'ordered' : (deliveryCompleted ? 'delivered' : 'billed'); lead.convertedOrderId = order._id; lead.conversionMode = mode; lead.orderStatus = orderStatus; lead.billStatus = billStatus; lead.billGeneratedAt = mode === 'bill' ? now : null; lead.deliveryCompleted = deliveryCompleted; lead.version += 1; lead.updatedByUserId = uid; lead.lifecycleEvents.push({ action: `converted_${mode}`, orderId: order._id, actorUserId: uid, at: now }); await lead.save();
  return serialize(order);
}
async function syncLeadOrderStatus(order, uid, action) {
  if (!order.sourceLeadId) return;
  const leadStatus = order.status === 'delivered' ? 'delivered' : order.billStatus ? 'billed' : 'ordered';
  await BusinessLead.updateOne({ _id: order.sourceLeadId, businessId: order.businessId, deletedAt: null }, { $set: { status: leadStatus, orderStatus: order.status, billStatus: order.billStatus || null, billGeneratedAt: order.billGeneratedAt || null, deliveryCompleted: Boolean(order.deliveryCompleted), updatedByUserId: uid }, $inc: { version: 1 }, $push: { lifecycleEvents: { action, orderId: order._id, actorUserId: uid, at: new Date() } } });
}
async function transitionOrder(bid, uid, id, body) {
  if (body?.action === 'cancel') return require('./businessBillsPayments.service').cancelOrder(bid, uid, id, body.version);
  if (!idOk(id)) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Order not found.');
  const action = body?.action; await authorize(bid, uid, action === 'generate_bill' ? 'business.orders.generateBill' : action === 'mark_delivered' ? 'business.bills.delivery.manage' : 'business.orders.edit');
  const order = await BusinessOrder.findOne({ _id: id, businessId: bid, deletedAt: null }); if (!order) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Order not found.');
  if (Number(body.version) !== order.version) throw fail(409, 'DOCUMENT_STALE', 'This order changed elsewhere. Reload and try again.');
  if (action === 'mark_delivered') {
    const bill = await BusinessBill.findOne({ businessId: bid, orderId: order._id, status: 'issued', deliveryStatus: 'in_transit', deletedAt: null }).select('_id').lean();
    if (!bill) throw fail(409, 'BILL_NOT_IN_TRANSIT', 'Mark delivery from an issued bill that is currently in transit.');
    await require('./businessBillsPayments.service').changeDelivery(bid, uid, String(bill._id), { deliveryStatus: order.orderType === 'purchase' ? 'received' : 'delivered', completionSource: `Order ${order.orderNumber}` });
    const updatedOrder = await BusinessOrder.findOne({ _id: order._id, businessId: bid }).lean();
    return serialize(updatedOrder);
  }
  const now = new Date();
  if (action === 'confirm') {
    if (order.status !== 'open') throw fail(409, 'INVALID_ORDER_TRANSITION', 'Only an open order can be confirmed.');
    order.status = 'confirmed'; order.confirmedAt = now;
  } else if (action === 'generate_bill') {
    if (!['open', 'confirmed'].includes(order.status) || order.billStatus) throw fail(409, 'INVALID_ORDER_TRANSITION', 'A bill can only be generated once for an open or confirmed order.');
    if (order.entryMode === 'image_only') throw fail(409, 'IMAGE_ORDER_NO_BILL', 'Image-only orders cannot generate bills.');
    const delivered = Boolean(body.deliveryCompleted); await validateDeliveredOrderStock(bid, order.orderType, order.entryMode, order.lines, delivered); order.confirmedAt ||= now; order.billGeneratedAt = now; order.billStatus = delivered ? 'delivered' : 'draft'; order.deliveryCompleted = delivered; order.status = delivered ? 'delivered' : 'billed'; if (delivered) order.deliveredAt = now;
  } else throw fail(400, 'INVALID_ORDER_TRANSITION', 'Choose a supported order action.');
  order.version += 1; order.updatedByUserId = uid; order.lifecycleEvents.push({ action: action === 'generate_bill' ? (order.deliveryCompleted ? 'bill_generated_and_delivered' : 'bill_generated') : action, actorUserId: uid, at: now });
  await order.save(); await syncLeadOrderStatus(order, uid, `source_order_${action}`); return serialize(order);
}
async function getOptions(bid, uid, permission = 'business.orders.view') {
  await authorize(bid, uid, permission);
  const [products, units, taxes] = await Promise.all([Product.find({ businessId: bid }).lean(), Unit.find({ businessId: bid }).lean(), Tax.find({ businessId: bid }).lean()]);
  const prices = await Pricing.find({ businessId: bid }).lean(); const priceByProduct = new Map(prices.map(x => [String(x.productId), x]));
  return { products: products.map(product => { const price = priceByProduct.get(String(product._id)); return { id: String(product._id), name: product.name, code: product.code || '', description: product.description || '', baseUnitId: product.baseUnitId ? String(product.baseUnitId) : null, additionalUnits: (product.additionalUnits || []).map(unit => ({ unitId: String(unit.unitId), conversionFactor: unit.conversionFactor })), taxMode: product.taxMode, taxComponentIds: (product.taxComponentIds || []).map(String), price: price ? { defaultSellingPrice: price.defaultSellingPrice?.toString() || null, purchaseCost: price.purchaseCost?.toString() || null, rules: (price.rules || []).map(r => ({ id: String(r._id), customerUserId: r.customerUserId ? String(r.customerUserId) : null, minimumQuantity: r.minimumQuantity, sellingPrice: r.sellingPrice.toString(), active: r.active })), version: price.version } : null }; }), units: units.map(unit => ({ id: String(unit._id), name: unit.name, symbol: unit.symbol })), taxes: taxes.map(tax => ({ id: String(tax._id), name: tax.name, calculationType: tax.calculationType, value: Number(tax.value), currency: tax.currency || '', jurisdiction: tax.jurisdiction || '', effectiveStart: tax.effectiveStart?.toISOString() || null, effectiveEnd: tax.effectiveEnd?.toISOString() || null, description: tax.description || '', revision: tax.updatedAt?.toISOString() || tax.createdAt?.toISOString() || '' })) };
}
async function lookupContact(bid, uid, query, permission = 'business.orders.create') {
  await authorize(bid, uid, permission); const phone = normalizeContactPhone(query.countryCallingCode, query.phoneNumber); if (!phone) throw fail(400, 'INVALID_PHONE', 'Enter a valid phone number.');
  const now = new Date(); const key = `f015-contact-lookup:${uid}`;
  let window = await RateLimitWindow.findOneAndUpdate({ key, resetAt: { $gt: now } }, { $inc: { count: 1 } }, { new: true });
  if (!window) window = await RateLimitWindow.findOneAndUpdate({ key }, { $set: { count: 1, resetAt: new Date(now.getTime() + 60 * 60 * 1000) } }, { upsert: true, new: true, setDefaultsOnInsert: true }).catch(async error => { if (error.code !== 11000) throw error; return RateLimitWindow.findOneAndUpdate({ key }, { $inc: { count: 1 } }, { new: true }); });
  if (window.count > 30) throw Object.assign(fail(429, 'RATE_LIMITED', 'Too many contact lookups. Try again later.'), { retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) });
  const user = await User.findOne({ phoneE164: phone }).select('_id displayName phoneE164').lean(); return user ? { exists: true, userId: String(user._id), name: user.displayName, phone: user.phoneE164 } : { exists: false };
}
async function addTax(bid, uid, body) {
  await authorize(bid, uid, 'business.catalog.taxes.manage');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''; const type = body.calculationType;
  if (!name || !['percentage', 'fixed'].includes(type)) throw fail(400, 'INVALID_TAX', 'Enter valid tax component details.');
  const value = amountNumber(body.value, 'tax value');
  const tax = await Tax.create({ businessId: bid, name, normalizedName: name.toLowerCase(), calculationType: type, value, currency: body.currency || '', effectiveStart: new Date(), jurisdiction: body.jurisdiction || '', description: body.description || '' });
  await Business.updateOne({ _id: bid }, { $addToSet: { businessTaxComponentIds: tax._id } }); return { id: String(tax._id), name: tax.name, calculationType: tax.calculationType, value: Number(tax.value), description: tax.description || '' };
}

const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_COUNT = 1;
const imageBucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'businessOrderImages' });
function imageInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > IMAGE_MAX_BYTES) throw fail(413, 'ORDER_IMAGE_TOO_LARGE', 'Each order image must be 20 MiB or smaller.');
  if (bytes.length >= 24 && bytes.toString('hex', 0, 8) === '89504e470d0a1a0a') return { contentType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunk = bytes.toString('ascii', offset, offset + 4); const length = bytes.readUInt32LE(offset + 4); const data = offset + 8;
      if (chunk === 'VP8X' && data + 10 <= bytes.length) return { contentType: 'image/webp', width: 1 + bytes.readUIntLE(data + 4, 3), height: 1 + bytes.readUIntLE(data + 7, 3) };
      offset = data + length + (length % 2);
    }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1]; const length = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { contentType: 'image/jpeg', height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      if (length < 2) break; offset += length + 2;
    }
  }
  throw fail(400, 'INVALID_ORDER_IMAGE', 'Upload a valid JPEG, PNG, or WebP image.');
}
function safeFilename(value) { const name = String(value || 'order-image').replace(/[\\/\r\n\0]/g, '_').trim().slice(0, 180); return name || 'order-image'; }
async function storeImage(bid, uid, order, bytes, filename) {
  const info = imageInfo(bytes);
  if (!info.width || !info.height || info.width > 30000 || info.height > 30000) throw fail(400, 'INVALID_IMAGE_DIMENSIONS', 'Image dimensions are not supported.');
  if (order.imageIds.length >= IMAGE_MAX_COUNT) throw fail(409, 'ORDER_IMAGE_LIMIT_REACHED', 'An order can contain only one image.');
  const fileId = new mongoose.Types.ObjectId(); const hash = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  // GridFSBucket's upload option is `id` (not Mongo's document field `_id`).
  // Using `_id` silently generated a different GridFS id from BusinessOrderImage.fileId,
  // leaving uploaded binaries unreachable from the image endpoint.
  const bucket = imageBucket(); const upload = bucket.openUploadStream(safeFilename(filename), { id: fileId, contentType: info.contentType, metadata: { businessId: String(bid), orderId: String(order._id), checksum: hash } });
  await new Promise((resolve, reject) => { upload.once('error', reject); upload.once('finish', resolve); upload.end(bytes); });
  const metadata = await BusinessOrderImage.create({ businessId: bid, orderId: order._id, fileId, filename: safeFilename(filename), contentType: info.contentType, size: bytes.length, width: info.width, height: info.height, checksum: hash, uploadedByUserId: uid });
  order.imageIds.push(metadata._id); order.imageMetadata.push({ id: String(metadata._id), filename: metadata.filename, contentType: metadata.contentType, size: metadata.size, width: metadata.width, height: metadata.height, createdAt: metadata.createdAt });
  order.version += 1; order.updatedByUserId = uid; await order.save();
  return { id: String(metadata._id), filename: metadata.filename, contentType: metadata.contentType, size: metadata.size, width: metadata.width, height: metadata.height };
}
async function createImageOrder(bid, uid, body, bytes, filename, idempotencyKey) {
  await authorize(bid, uid, 'business.orders.create');
  if (body.acknowledgedNoStoreChange !== true) throw fail(400, 'IMAGE_ACK_REQUIRED', 'Confirm that the image will not change the store.');
  const type = body.orderType; if (!['sales', 'purchase'].includes(type)) throw fail(400, 'INVALID_ORDER_TYPE', 'Choose Sales Order or Purchase Order.');
  const documentDate = validTimestamp(body.documentDate, 'order'); const createdAtClient = validTimestamp(body.createdAtClient, 'creation');
  const currencyCode = String(body.currencyCode || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw fail(409, 'CURRENCY_NOT_CONFIGURED', 'Choose a valid three-letter order currency before saving this order.');
  const taxable = micro(body.imageAmounts?.taxableAmount, 'taxable amount'); const tax = micro(body.imageAmounts?.taxAmount ?? '0', 'tax amount');
  const taxableText = moneyText(taxable); const taxText = moneyText(tax); const totalText = moneyText(taxable + tax);
  const imageAmounts = { taxableAmount: taxableText, taxAmount: taxText, taxDescription: String(body.imageAmounts?.taxDescription || '').trim().slice(0, 120) };
  const phone = normalizeContactPhone(body.contact?.countryCallingCode, body.contact?.phoneNumber);
  if (!phone) throw fail(400, 'INVALID_PHONE', 'Enter a valid customer or supplier phone number.');
  const contactType = type === 'purchase' ? 'supplier' : 'customer';
  const contactSnapshot = cleanContact({ ...body.contact, phone }, contactType);
  let contactUserId = (await User.findOne({ phoneE164: phone }).select('_id').lean())?._id || null;
  let provisionedUser = null;
  if (type === 'sales' && !contactUserId) {
    try { provisionedUser = await User.create({ phoneE164: phone, displayName: contactSnapshot.name, accountStatus: 'provisioned' }); contactUserId = provisionedUser._id; }
    catch (error) { if (error.code === 11000) contactUserId = (await User.findOne({ phoneE164: phone }).select('_id').lean())?._id || null; else throw error; }
  }
  const numberConfig = await BusinessDocumentNumberConfig.findOne({ businessId: bid }).lean();
  const orderNumber = await nextNumber(BusinessOrder, bid, type === 'sales' ? (numberConfig?.orderSalesPrefix || 'SO') : (numberConfig?.orderPurchasePrefix || 'PO'), 'orderNumber');
  let order;
  try {
    const deliveryCompleted = Boolean(body.deliveryCompleted); const createdAt = new Date();
    order = await BusinessOrder.create({ businessId: bid, orderNumber, orderType: type, entryMode: 'image_only', status: deliveryCompleted ? 'delivered' : 'open', deliveryCompleted, deliveredAt: deliveryCompleted ? createdAt : null, contactType, contactUserId, contactSnapshot, documentDate, createdAtClient, currencyCode, currencyScale: 2, imageAmounts, subtotal: decimal(taxableText), discountTotal: decimal('0.00'), afterDiscount: decimal(taxableText), taxTotal: decimal(taxText), grandTotal: decimal(totalText), imageIds: [], imageMetadata: [], createdByUserId: uid, updatedByUserId: uid, idempotencyKey: idempotencyKey || null, lifecycleEvents: [{ action: 'created_image_only', actorUserId: uid, at: createdAt }] });
    await storeImage(bid, uid, order, bytes, filename); return serialize(order);
  } catch (error) {
    if (order) await BusinessOrder.deleteOne({ _id: order._id, businessId: bid });
    if (provisionedUser) await cleanupUnlinkedProvisionedUser(provisionedUser._id);
    throw error;
  }
}
async function attachImage(bid, uid, orderId, bytes, filename) {
  await authorize(bid, uid, 'business.orders.edit'); if (!idOk(orderId)) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Order not found.');
  const order = await BusinessOrder.findOne({ _id: orderId, businessId: bid, deletedAt: null });
  if (!order || order.status !== 'open' || order.entryMode !== 'image_only') throw fail(404, 'DOCUMENT_NOT_FOUND', 'Open image order not found.');
  return storeImage(bid, uid, order, bytes, filename);
}
async function imageStreamInfo(bid, uid, orderId, imageId) {
  await authorize(bid, uid, 'business.orders.view'); if (!idOk(orderId) || !idOk(imageId)) throw fail(404, 'ORDER_IMAGE_NOT_FOUND', 'Image not found.');
  const order = await BusinessOrder.findOne({ _id: orderId, businessId: bid, deletedAt: null }).select('_id status imageIds').lean();
  if (!order || !order.imageIds.some(id => String(id) === String(imageId))) throw fail(404, 'ORDER_IMAGE_NOT_FOUND', 'Image not found.');
  const image = await BusinessOrderImage.findOne({ _id: imageId, orderId, businessId: bid, deletedAt: null }); if (!image) throw fail(404, 'ORDER_IMAGE_NOT_FOUND', 'Image not found.');
  const bucket = imageBucket();
  let fileId = image.fileId;
  // Older uploads may have a metadata fileId that differs from GridFS because the
  // upload option was previously named `_id`. Recover the matching saved binary
  // using the integrity metadata written alongside it, then repair the reference.
  const storedFile = await mongoose.connection.db.collection('businessOrderImages.files').findOne({ _id: fileId }, { projection: { _id: 1 } });
  if (!storedFile) {
    const recovered = await mongoose.connection.db.collection('businessOrderImages.files').findOne({
      'metadata.businessId': String(bid),
      'metadata.orderId': String(orderId),
      'metadata.checksum': image.checksum,
    }, { projection: { _id: 1 } });
    if (!recovered) throw fail(404, 'ORDER_IMAGE_BINARY_NOT_FOUND', 'The saved image file could not be found.');
    fileId = recovered._id;
    image.fileId = fileId;
    await image.save();
  }
  return { image: image.toObject(), stream: bucket.openDownloadStream(fileId) };
}
async function removeImage(bid, uid, orderId, imageId) {
  await authorize(bid, uid, 'business.orders.edit');
  const order = await BusinessOrder.findOne({ _id: orderId, businessId: bid, status: 'open', entryMode: 'image_only', deletedAt: null });
  if (!order) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Open image order not found.');
  const metadata = await BusinessOrderImage.findOne({ _id: imageId, businessId: bid, orderId, deletedAt: null }); if (!metadata) throw fail(404, 'ORDER_IMAGE_NOT_FOUND', 'Image not found.');
  await imageBucket().delete(metadata.fileId); metadata.deletedAt = new Date(); await metadata.save();
  order.imageIds = order.imageIds.filter(id => String(id) !== String(metadata._id)); order.imageMetadata = order.imageMetadata.filter(item => String(item.id) !== String(metadata._id)); order.version += 1; await order.save();
  return { removed: true };
}
async function abortImageOrder(bid, uid, orderId) {
  await authorize(bid, uid, 'business.orders.create');
  const order = await BusinessOrder.findOne({ _id: orderId, businessId: bid, createdByUserId: uid, status: 'open', entryMode: 'image_only', deletedAt: null });
  if (!order) return { removed: true };
  const images = await BusinessOrderImage.find({ businessId: bid, orderId, deletedAt: null }).lean();
  for (const image of images) { await imageBucket().delete(image.fileId).catch(() => undefined); await BusinessOrderImage.deleteOne({ _id: image._id }); }
  await BusinessOrder.deleteOne({ _id: order._id, businessId: bid, createdByUserId: uid });
  return { removed: true };
}

module.exports = { listOrders, listLeads, summary, getOrder: (b,u,id) => get(BusinessOrder,b,u,id,'business.orders.view'), getLead: (b,u,id) => get(BusinessLead,b,u,id,'business.leads.view',true), createOrder, createLead, updateOrder, updateLead, deleteOrder: (b,u,id) => softDelete(BusinessOrder,b,u,id), deleteLead: (b,u,id) => softDelete(BusinessLead,b,u,id,true), convertLead, transitionOrder, getOptions, lookupContact, addTax, createImageOrder, attachImage, imageStreamInfo, removeImage, abortImageOrder };
