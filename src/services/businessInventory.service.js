'use strict';
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { access } = require('./businessPeopleTeams.service');
const Product = require('../DB/models/BusinessCatalogProduct');
const Category = require('../DB/models/BusinessCatalogCategory');
const Unit = require('../DB/models/BusinessCatalogUnit');
const Movement = require('../DB/models/BusinessInventoryMovement');
const Lock = require('../DB/models/BusinessInventoryLock');
const { assertDatabaseConnected } = require('../DB/connection');
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const decimal = value => mongoose.Types.Decimal128.fromString(value);
const number = value => Number(value?.toString?.() || 0);
function scaled(value, places = 4) {
  const match = String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) throw fail(400, 'INVALID_QUANTITY', 'Enter a valid decimal quantity.');
  const sign = match[1] === '-' ? -1n : 1n; const fraction = match[3] || ''; const exponent = Number(match[4] || 0);
  let result = BigInt(`${match[2]}${fraction}`) * sign; const shift = places + exponent - fraction.length;
  if (shift >= 0) return result * (10n ** BigInt(shift));
  const divisor = 10n ** BigInt(-shift); const abs = result < 0n ? -result : result; const rounded = (abs + divisor / 2n) / divisor;
  return result < 0n ? -rounded : rounded;
}
function decimalString(value, places = 4) {
  const negative = value < 0n; const absolute = negative ? -value : value; const scale = 10n ** BigInt(places);
  const whole = absolute / scale; const remainder = String(absolute % scale).padStart(places, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${remainder ? `.${remainder}` : ''}`;
}
async function currentStock(businessId, productId) {
  const match = { businessId: new mongoose.Types.ObjectId(businessId) };
  if (productId) match.productId = new mongoose.Types.ObjectId(productId);
  const negativeOne = mongoose.Types.Decimal128.fromString('-1');
  const rows = await Movement.aggregate([{ $match: match }, { $group: { _id: '$productId', quantity: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$stockQuantity', { $multiply: ['$stockQuantity', negativeOne] }] } } } }]);
  return new Map(rows.map(row => [String(row._id), scaled(row.quantity.toString())]));
}
const validId = id => mongoose.isValidObjectId(id);
const quantityText = value => {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text) || text.length > 24 || Number(text) > 10000000000) throw fail(400, 'INVALID_QUANTITY', 'Enter a positive quantity up to 10 billion using at most four decimal places.');
  if (scaled(text) <= 0n) throw fail(400, 'INVALID_QUANTITY', 'Quantity must be greater than zero.');
  return text;
};
async function authorize(businessId, userId, permission) {
  assertDatabaseConnected();
  const ctx = await access(businessId, userId);
  if (!ctx.owner && !ctx.keys.has(permission)) throw fail(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.');
  return ctx;
}
function unitChoices(product, units) {
  const baseId = String(product.baseUnitId || '');
  const factors = new Map([[baseId, 1], ...(product.additionalUnits || []).map(item => [String(item.unitId), Number(item.conversionFactor)])]);
  return [...factors.entries()].map(([id, factor]) => {
    const unit = units.find(item => String(item._id) === id);
    return unit && Number.isFinite(factor) && factor > 0 ? { id, name: unit.name, symbol: unit.symbol, factor } : null;
  }).filter(Boolean);
}
function dateOnly(input, field) {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) throw fail(400, 'INVALID_DATE', `Choose a valid ${field}.`);
  const [year, month, day] = input.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) throw fail(400, 'INVALID_DATE', `Choose a valid ${field}.`);
  return value;
}
function isoDate(value) { return new Date(value).toISOString().slice(0, 10); }
async function withProductLock(businessId, productId, work) {
  const lockId = crypto.randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const lock = await Lock.findOneAndUpdate({ businessId, productId, $or: [{ expiresAt: { $lte: new Date() } }, { lockId }] }, { $set: { businessId, productId, lockId, expiresAt: new Date(Date.now() + 5 * 60 * 1000) } }, { upsert: true, new: true, setDefaultsOnInsert: true });
      if (lock?.lockId === lockId) { acquired = true; break; }
    } catch (error) { if (error.code !== 11000) throw error; }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  if (!acquired) throw fail(409, 'INVENTORY_BUSY', 'Another inventory adjustment is being saved. Try again.');
  const renewal = setInterval(() => { Lock.updateOne({ businessId, productId, lockId }, { $set: { expiresAt: new Date(Date.now() + 5 * 60 * 1000) } }).catch(error => console.error('[inventory] lock renewal failed:', error.code || error.name)); }, 60 * 1000);
  renewal.unref();
  try { return await work(); } finally { clearInterval(renewal); await Lock.deleteOne({ businessId, productId, lockId }).catch(error => console.error('[inventory] lock release failed:', error.code || error.name)); }
}
async function list(businessId, userId, query = {}) {
  const ctx = await authorize(businessId, userId, 'business.inventory.view');
  const products = await Product.find({ businessId }).sort({ normalizedName: 1 }).lean();
  const categories = await Category.find({ businessId }).select('_id name').lean();
  const units = await Unit.find({ businessId }).select('_id name symbol').lean();
  const balances = await currentStock(businessId);
  const movements = await Movement.aggregate([{ $match: { businessId: new mongoose.Types.ObjectId(businessId) } }, { $sort: { effectiveDate: -1, _id: -1 } }, { $group: { _id: '$productId', movement: { $first: '$$ROOT' } } }]);
  const lastByProduct = new Map(movements.map(row => [String(row._id), row.movement]));
  const stockFilter = ['in', 'low', 'out'].includes(query.stockLevel) ? query.stockLevel : '';
  const categoryId = validId(query.categoryId) ? String(query.categoryId) : '';
  const search = String(query.search || '').trim().slice(0, 80).toLocaleLowerCase();
  const items = products.map(product => {
    const id = String(product._id); const quantityScaled = balances.get(id) || 0n; const qty = Number(quantityScaled) / 10000;
    const unitsForProduct = unitChoices(product, units); const baseUnit = unitsForProduct.find(unit => unit.id === String(product.baseUnitId)) || unitsForProduct[0];
    const reorder = product.reorderLevel == null ? null : number(product.reorderLevel);
    const status = quantityScaled <= 0n ? 'out' : reorder !== null && quantityScaled <= scaled(product.reorderLevel.toString()) ? 'low' : 'in';
    const movement = lastByProduct.get(id);
    return { id, name: product.name, code: product.code || '', description: product.description || '', categoryIds: (product.categoryIds || []).map(String), categories: categories.filter(c => (product.categoryIds || []).some(id2 => String(id2) === String(c._id))).map(c => c.name), baseUnitId: baseUnit?.id || '', baseUnitName: baseUnit?.name || '', baseUnitSymbol: baseUnit?.symbol || '', units: unitsForProduct, quantity: String(qty), reorderLevel: reorder == null ? '' : String(product.reorderLevel), status, lastMovementDate: movement?.effectiveDate || null, lastMovementQuantity: movement ? `${movement.direction === 'out' ? '−' : '+'}${movement.stockQuantity}` : '', lastMovementUnit: movement?.stockUnitName || '' };
  }).filter(item => (!search || `${item.name} ${item.code}`.toLocaleLowerCase().includes(search)) && (!categoryId || item.categoryIds.includes(categoryId)) && (!stockFilter || item.status === stockFilter));
  const trackedItems = products;
  const from = new Date(Date.now() - 30 * 86400000);
  const recentMovements = await Movement.countDocuments({ businessId, effectiveDate: { $gte: from } });
  return { items, products: products.map(product => ({ id: String(product._id), name: product.name, code: product.code || '', baseUnitId: String(product.baseUnitId || ''), units: unitChoices(product, units) })), categories: categories.map(item => ({ id: String(item._id), name: item.name })), summary: { productsTracked: trackedItems.length, lowStock: trackedItems.filter(product => { const quantity = balances.get(String(product._id)) || 0n; return quantity > 0n && product.reorderLevel != null && quantity <= scaled(product.reorderLevel.toString()); }).length, outOfStock: trackedItems.filter(product => (balances.get(String(product._id)) || 0n) <= 0n).length, movementsLast30Days: recentMovements }, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function productUnits(businessId, productId) {
  if (!validId(productId)) throw fail(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  const product = await Product.findOne({ _id: productId, businessId }).lean();
  if (!product) throw fail(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  const unitIds = [product.baseUnitId, ...(product.additionalUnits || []).map(item => item.unitId)].filter(Boolean);
  const units = await Unit.find({ businessId, _id: { $in: unitIds } }).lean();
  const choices = unitChoices(product, units);
  if (!choices.length) throw fail(409, 'PRODUCT_UNIT_REQUIRED', 'Configure a valid product stock unit before adjusting inventory.');
  return { product, choices, baseUnit: choices.find(item => item.id === String(product.baseUnitId)) || choices[0] };
}
async function adjust(businessId, userId, body = {}) {
  await authorize(businessId, userId, 'business.inventory.adjust');
  if (!validId(body.productId)) throw fail(400, 'PRODUCT_REQUIRED', 'Choose a product.');
  const productId = String(body.productId); const direction = body.direction;
  if (!['in', 'out'].includes(direction)) throw fail(400, 'INVALID_DIRECTION', 'Choose add stock or remove stock.');
  const quantity = quantityText(body.quantity); const effectiveDate = dateOnly(body.effectiveDate, 'effective date');
  const reasons = ['opening', 'damage', 'count', 'correction', 'other'];
  if (!reasons.includes(body.reason)) throw fail(400, 'INVALID_REASON', 'Choose a valid adjustment reason.');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (body.reason === 'other' && !note) throw fail(400, 'NOTE_REQUIRED', 'Add a note when the reason is Other.');
  if (body.reason === 'opening' && direction !== 'in') throw fail(400, 'INVALID_REASON', 'Opening stock must add stock.');
  const { product, choices, baseUnit } = await productUnits(businessId, productId);
  const selected = choices.find(unit => unit.id === String(body.unitId));
  if (!selected) throw fail(400, 'INVALID_UNIT', 'Choose a unit configured for this product.');
  const entered = scaled(quantity); const conversion = scaled(selected.factor, 8); const stockValue = (entered * conversion + 50000000n) / 100000000n;
  if (stockValue <= 0n || stockValue > 100000000000000n) throw fail(400, 'INVALID_CONVERSION', 'This quantity cannot be represented accurately in the product stock unit.');
  return withProductLock(businessId, productId, async () => {
    const stockMap = await currentStock(businessId, productId);
    const quantityOnHand = stockMap.get(productId) || 0n;
    const next = quantityOnHand + (direction === 'in' ? stockValue : -stockValue);
    if (next < 0n) throw fail(409, 'INSUFFICIENT_STOCK', 'The removal is greater than the stock currently available.');
    if (next > 100000000000000n) throw fail(400, 'INVALID_QUANTITY', 'The resulting stock cannot exceed 10 billion units.');
    const movementId = new mongoose.Types.ObjectId();
    await Movement.create({ _id: movementId, businessId, productId, productName: product.name, direction, quantity: decimal(quantity), unitId: selected.id, unitName: selected.name, unitSymbol: selected.symbol, conversionFactor: selected.factor, stockQuantity: decimal(decimalString(stockValue)), stockUnitId: baseUnit.id, stockUnitName: baseUnit.name, effectiveDate, reason: body.reason, note, source: 'adjustment', actorUserId: userId });
    return { id: String(movementId), quantity, direction, stockQuantity: decimalString(stockValue), balance: decimalString(next), unit: selected.name, stockUnit: baseUnit.name, effectiveDate: isoDate(effectiveDate) };
  });
}
function presentMovement(row, balance) {
  const amount = String(row.stockQuantity);
  return { id: String(row._id), productId: String(row.productId), productName: row.productName, direction: row.direction, quantity: String(row.quantity), unitName: row.unitName, unitSymbol: row.unitSymbol, stockQuantity: amount, stockUnitName: row.stockUnitName, date: isoDate(row.effectiveDate), reason: row.reason, note: row.note || '', source: row.source, actorUserId: String(row.actorUserId), createdAt: row.createdAt, balance: balance === undefined ? '' : String(balance) };
}
async function ledger(businessId, userId, productId) {
  await authorize(businessId, userId, 'business.inventory.view');
  const { product } = await productUnits(businessId, productId);
  const rows = await Movement.find({ businessId, productId }).sort({ effectiveDate: 1, _id: 1 }).lean();
  let balance = 0;
  return { product: { id: String(product._id), name: product.name }, items: rows.map(row => { balance += (row.direction === 'in' ? 1 : -1) * number(row.stockQuantity); return presentMovement(row, Math.max(0, Math.round(balance * 10000) / 10000)); } ) };
}
async function report(businessId, userId, query = {}) {
  const ctx = await authorize(businessId, userId, 'business.reports.view');
  if (!query.productId) {
    const products = await Product.find({ businessId }).sort({ normalizedName: 1 }).lean();
    const units = await Unit.find({ businessId }).lean();
    return { products: products.map(product => ({ id: String(product._id), name: product.name, code: product.code || '', baseUnitId: String(product.baseUnitId || ''), units: unitChoices(product, units) })), authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
  }
  if (!validId(query.productId)) throw fail(400, 'PRODUCT_REQUIRED', 'Choose a product for this report.');
  const start = dateOnly(query.startDate, 'start date'); const endDay = dateOnly(query.endDate, 'end date');
  if (endDay < start) throw fail(400, 'INVALID_DATE_RANGE', 'The start date must be on or before the end date.');
  const endExclusive = new Date(endDay.getTime() + 86400000);
  const { product, choices, baseUnit } = await productUnits(businessId, query.productId);
  const displayUnit = choices.find(unit => unit.id === String(query.unitId || baseUnit.id));
  if (!displayUnit) throw fail(400, 'INVALID_UNIT', 'Choose a unit configured for this product.');
  const rows = await Movement.find({ businessId, productId: product._id, effectiveDate: { $lt: endExclusive } }).sort({ effectiveDate: 1, _id: 1 }).lean();
  const factor = displayUnit.factor;
  let opening = 0; const entries = [];
  for (const row of rows) {
    const quantity = number(row.stockQuantity);
    if (row.effectiveDate < start) opening += row.direction === 'in' ? quantity : -quantity;
    else entries.push(row);
  }
  opening = Math.round(opening / factor * 10000) / 10000;
  let running = opening; let totalIn = 0; let totalOut = 0;
  const movements = entries.map(row => {
    const qty = Math.round(number(row.stockQuantity) / factor * 10000) / 10000;
    if (row.direction === 'in') { totalIn += qty; running += qty; } else { totalOut += qty; running -= qty; }
    return { ...presentMovement(row), quantity: String(Math.round(number(row.quantity) * row.conversionFactor / factor * 10000) / 10000), unitName: displayUnit.name, unitSymbol: displayUnit.symbol, stockQuantity: String(qty), balance: String(Math.round(running * 10000) / 10000) };
  });
  return { product: { id: String(product._id), name: product.name, code: product.code || '' }, unit: displayUnit, startDate: isoDate(start), endDate: isoDate(endDay), opening: String(opening), totalIn: String(Math.round(totalIn * 10000) / 10000), totalOut: String(Math.round(totalOut * 10000) / 10000), closing: String(Math.max(0, Math.round(running * 10000) / 10000)), movements, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function setReorderLevel(businessId, userId, productId, input = {}) {
  await authorize(businessId, userId, 'business.inventory.adjust');
  if (!validId(productId)) throw fail(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  const text = input.reorderLevel === null || input.reorderLevel === '' ? null : String(input.reorderLevel).trim();
  if (text !== null && (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text) || text.length > 24 || Number(text) > 10000000000)) throw fail(400, 'INVALID_REORDER_LEVEL', 'Enter a non-negative reorder level up to 10 billion using at most four decimal places.');
  const product = await Product.findOneAndUpdate({ _id: productId, businessId }, { $set: { reorderLevel: text === null ? null : decimal(text) } }, { new: true }).lean();
  if (!product) throw fail(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  return { id: String(product._id), reorderLevel: text || '' };
}
async function validateBillStock(businessId, bill) {
  if (bill.billType !== 'sale') return;
  const requiredByProduct = new Map();
  for (let index = 0; index < (bill.lines || []).length; index += 1) {
    const line = bill.lines[index]; const productId = String(line.productId || '');
    if (!validId(productId)) throw fail(409, 'BILL_STOCK_PRODUCT_INVALID', 'A billed product is no longer available for stock movement.');
    const { product, choices } = await productUnits(businessId, productId);
    const selected = choices.find(unit => unit.id === String(line.unitId || ''));
    if (!selected) throw fail(409, 'BILL_STOCK_UNIT_INVALID', `The stock unit for ${product.name} is no longer configured.`);
    const quantity = quantityText(String(line.quantity || ''));
    const stockValue = (scaled(quantity) * scaled(selected.factor, 8) + 50000000n) / 100000000n;
    if (stockValue <= 0n || stockValue > 100000000000000n) throw fail(409, 'INVALID_CONVERSION', 'This quantity cannot be represented accurately in the product stock unit.');
    const current = requiredByProduct.get(productId) || { productName: product.name, quantity: 0n };
    current.quantity += stockValue; requiredByProduct.set(productId, current);
  }
  for (const [productId, required] of [...requiredByProduct.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    await withProductLock(businessId, productId, async () => {
      const available = (await currentStock(businessId, productId)).get(productId) || 0n;
      if (available < required.quantity) throw fail(409, 'INSUFFICIENT_STOCK', `The order would make ${required.productName} stock negative.`);
    });
  }
}
async function recordBillMovement(businessId, userId, bill, line, direction, eventKey, compensation = false) {
  const productId = String(line.productId || '');
  if (!validId(productId)) throw fail(409, 'BILL_STOCK_PRODUCT_INVALID', 'A billed product is no longer available for stock movement.');
  const { product, choices, baseUnit } = await productUnits(businessId, productId);
  const selected = choices.find(unit => unit.id === String(line.unitId || ''));
  if (!selected) throw fail(409, 'BILL_STOCK_UNIT_INVALID', `The stock unit for ${product.name} is no longer configured.`);
  const quantity = quantityText(String(line.quantity || ''));
  const stockValue = (scaled(quantity) * scaled(selected.factor, 8) + 50000000n) / 100000000n;
  return withProductLock(businessId, productId, async () => {
    if (await Movement.exists({ businessId, sourceEventKey: eventKey })) return { duplicate: true };
    const stockMap = await currentStock(businessId, productId); const onHand = stockMap.get(productId) || 0n; const next = onHand + (direction === 'in' ? stockValue : -stockValue);
    if (next < 0n) throw fail(409, 'INSUFFICIENT_STOCK', `The bill would make ${product.name} stock negative.`);
    const row = await Movement.create({ businessId, productId, productName: product.name, direction, quantity: decimal(quantity), unitId: selected.id, unitName: selected.name, unitSymbol: selected.symbol, conversionFactor: selected.factor, stockQuantity: decimal(decimalString(stockValue)), stockUnitId: baseUnit.id, stockUnitName: baseUnit.name, effectiveDate: dateOnly(bill.billDate, 'bill date'), reason: direction === 'in' ? 'purchase' : 'sale', note: `Bill ${bill.billNumber || bill._id}`, source: compensation ? 'bill_compensation' : 'bill', sourceBillId: bill._id, sourceBillLineId: String(line.lineId || line._id || ''), sourceEventKey: eventKey, actorUserId: userId });
    return { id: String(row._id), balance: decimalString(next) };
  });
}
module.exports = { list, adjust, ledger, report, setReorderLevel, validateBillStock, recordBillMovement };
