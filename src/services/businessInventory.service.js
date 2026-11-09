'use strict';
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { access } = require('./businessPeopleTeams.service');
const Product = require('../DB/models/BusinessCatalogProduct');
const Category = require('../DB/models/BusinessCatalogCategory');
const productUnitsConfig = require('./productUnits');
const Movement = require('../DB/models/BusinessInventoryMovement');
const Lock = require('../DB/models/BusinessInventoryLock');
const { assertDatabaseConnected } = require('../DB/connection');
const { serviceTypes, isServiceType, isServiceLine } = require('./serviceProducts');
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
  const rows = await Movement.aggregate([{ $match: match }, { $group: { _id: stockGroup, quantity: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$stockQuantity', { $multiply: ['$stockQuantity', negativeOne] }] } } } }]);
  return new Map(rows.map(row => [stockKey(row._id.productId || row._id, row._id.variantKey), scaled(row.quantity.toString())]));
}
const stockGroup = { productId: '$productId', variantKey: { $ifNull: ['$variantKey', null] } };
const stockKey = (productId, variantKey) => `${productId}:${variantKey || ''}`;
const legacyKey = productUnitsConfig.legacyVariantKey;
function stockBalance(balances, product, variantKey) {
  return (balances.get(stockKey(product._id, variantKey)) || 0n)
    + (variantKey === legacyKey(product) ? balances.get(stockKey(product._id)) || 0n : 0n);
}
function movementFilter(product, variantKey) {
  return { productId: product._id, variantKey: variantKey === legacyKey(product) ? { $in: [variantKey, null] } : variantKey };
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
function unitChoices(product, variantKey) { return productUnitsConfig.options(product, variantKey).map(u => ({ ...u, id: u.key, factor: u.factorToBase })); }
function variationOptions(product) {
  return productUnitsConfig.variations(product).map(variant => {
    const productId = String(product._id);
    const label = Object.entries(variant.values).map(([name, value]) => `${name}: ${value}`).join(', ');
    return { id: stockKey(productId, variant.key), productId, variantKey: variant.key,
      name: label ? `${product.name} · ${label}` : product.name, code: product.code || '',
      baseUnitKey: variant.baseUnit?.key || '', units: unitChoices(product, variant.key),
      reorderLevel: variant.reorderLevel ?? (variant.key === legacyKey(product) ? product.reorderLevel : null) };
  });
}
function lineQuantity(value) { if (!/^\d{1,11}(?:\.\d{1,6})?$/.test(String(value))) throw fail(400, 'INVALID_QUANTITY', 'Enter a valid line quantity with up to six decimal places.'); productUnitsConfig.fixed(value); return String(value); }
function lineUnit(line, product, choices) {
  const base = productUnitsConfig.dto(product, line.variantKey || legacyKey(product)).baseUnit;
  if (line.baseUnitKey && (!base || line.baseUnitKey !== base.key || line.baseUnitSymbol !== base.symbol || line.baseUnitName !== base.name)) throw fail(409, 'PRODUCT_UNIT_CONFIG_STALE', 'The saved line uses a different stock base unit.');
  const factor = line.factorToBase || line.conversionFactor;
  if (!factor) throw fail(409, 'INVALID_CONVERSION', 'The saved line has no conversion snapshot.');
  productUnitsConfig.fixed(factor);
  return { id: line.unitKey || String(line.unitId || ''), name: line.unitLabel || base.name, symbol: line.unitSymbol || base.symbol, factor: String(factor) };
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
  const products = await Product.find({ businessId, type: { $nin: serviceTypes } }).sort({ normalizedName: 1 }).lean();
  const categories = await Category.find({ businessId }).select('_id name').lean();
  const balances = await currentStock(businessId);
  const movements = await Movement.aggregate([{ $match: { businessId: new mongoose.Types.ObjectId(businessId) } }, { $sort: { effectiveDate: -1, _id: -1 } }, { $group: { _id: stockGroup, movement: { $first: '$$ROOT' } } }]);
  const lastByVariation = new Map(movements.map(row => [stockKey(row._id.productId, row._id.variantKey), row.movement]));
  const stockFilter = ['in', 'low', 'out'].includes(query.stockLevel) ? query.stockLevel : '';
  const categoryId = validId(query.categoryId) ? String(query.categoryId) : '';
  const search = String(query.search || '').trim().slice(0, 80).toLocaleLowerCase();
  const tracked = products.flatMap(product => variationOptions(product).map(option => {
    const quantity = stockBalance(balances, product, option.variantKey);
    const base = option.units[0];
    const reorderLevel = option.reorderLevel == null ? '' : String(option.reorderLevel);
    const status = quantity <= 0n ? 'out' : reorderLevel && quantity <= scaled(reorderLevel) ? 'low' : 'in';
    const tagged = lastByVariation.get(option.id);
    const legacy = option.variantKey === legacyKey(product) && lastByVariation.get(stockKey(option.productId));
    const movement = legacy && (!tagged || legacy.effectiveDate > tagged.effectiveDate || (+legacy.effectiveDate === +tagged.effectiveDate && String(legacy._id) > String(tagged._id))) ? legacy : tagged;
    const categoryIds = (product.categoryIds || []).map(String);
    return { ...option, description: product.description || '', categoryIds, categories: categories.filter(category => categoryIds.includes(String(category._id))).map(category => category.name),
      baseUnitName: base?.name || '', baseUnitSymbol: base?.symbol || '', quantity: decimalString(quantity), reorderLevel, status,
      lastMovementDate: movement?.effectiveDate || null, lastMovementQuantity: movement ? `${movement.direction === 'out' ? '−' : '+'}${movement.stockQuantity}` : '', lastMovementUnit: movement?.stockUnitName || '' };
  }));
  const items = tracked.filter(item => (!search || `${item.name} ${item.code}`.toLocaleLowerCase().includes(search)) && (!categoryId || item.categoryIds.includes(categoryId)) && (!stockFilter || item.status === stockFilter));
  const from = new Date(Date.now() - 30 * 86400000);
  const recentMovements = await Movement.countDocuments({ businessId, productId: { $in: products.map(product => product._id) }, effectiveDate: { $gte: from } });
  return { items, products: products.flatMap(variationOptions), categories: categories.map(item => ({ id: String(item._id), name: item.name })),
    summary: { productsTracked: tracked.length, lowStock: tracked.filter(item => item.status === 'low').length, outOfStock: tracked.filter(item => item.status === 'out').length, movementsLast30Days: recentMovements },
    authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function productUnits(businessId, productId, requestedVariant, stockLine) {
  if (!validId(productId)) throw fail(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  const product = await Product.findOne({ _id: productId, businessId }).lean();
  if (!product) throw fail(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  if (isServiceType(product.type) && stockLine?.productType !== 'Goods') {
    if (stockLine) return null;
    throw fail(400, 'SERVICE_HAS_NO_INVENTORY', 'Services do not have stock to manage.');
  }
  const variantKey = requestedVariant ?? legacyKey(product);
  const variant = productUnitsConfig.variations(product).find(item => item.key === variantKey);
  if (!variant) throw fail(404, 'PRODUCT_VARIANT_NOT_FOUND', 'Choose an available product variation.');
  const choices = unitChoices(product, variantKey);
  if (!choices.length) throw fail(409, 'PRODUCT_UNIT_MIGRATION_REQUIRED', 'Configure a valid product stock unit before adjusting inventory.');
  return { product, variant, choices, baseUnit: choices[0] };
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
  return withProductLock(businessId, productId, async () => {
    const { product, variant, choices, baseUnit } = await productUnits(businessId, productId, body.variantKey);
    const selected = choices.find(unit => unit.id === String(body.unitKey));
    if (!selected) throw fail(400, 'INVALID_UNIT', 'Choose a unit configured for this product.');
    const stockValue = scaled(productUnitsConfig.multiply(quantity, selected.factor, 4));
    if (stockValue <= 0n || stockValue > 100000000000000n) throw fail(400, 'INVALID_CONVERSION', 'This quantity cannot be represented accurately in the product stock unit.');
    const stockMap = await currentStock(businessId, productId);
    const quantityOnHand = stockBalance(stockMap, product, variant.key);
    const next = quantityOnHand + (direction === 'in' ? stockValue : -stockValue);
    if (next < 0n) throw fail(409, 'INSUFFICIENT_STOCK', 'The removal is greater than the stock currently available.');
    if (next > 100000000000000n) throw fail(400, 'INVALID_QUANTITY', 'The resulting stock cannot exceed 10 billion units.');
    const movementId = new mongoose.Types.ObjectId();
    await Movement.create({ _id: movementId, businessId, productId, variantKey: variant.key, variantValues: variant.values, productName: product.name, direction, quantity: decimal(quantity), unitKey: selected.id, factorToBase: selected.factor, unitName: selected.name, unitSymbol: selected.symbol, stockQuantity: decimal(decimalString(stockValue)), stockUnitKey: baseUnit.id, stockUnitSymbol: baseUnit.symbol, stockUnitName: baseUnit.name, effectiveDate, reason: body.reason, note, source: 'adjustment', actorUserId: userId });
    return { id: String(movementId), quantity, direction, stockQuantity: decimalString(stockValue), balance: decimalString(next), unit: selected.name, stockUnit: baseUnit.name, effectiveDate: isoDate(effectiveDate) };
  });
}
function presentMovement(row, balance) {
  const amount = String(row.stockQuantity);
  return { id: String(row._id), productId: String(row.productId), variantKey: row.variantKey, variantValues: row.variantValues, productName: row.productName, direction: row.direction, quantity: String(row.quantity), unitName: row.unitName, unitSymbol: row.unitSymbol, unitKey: row.unitKey || '', factorToBase: String(row.factorToBase || row.conversionFactor || ''), stockUnitKey: row.stockUnitKey || '', stockUnitSymbol: row.stockUnitSymbol || '', stockQuantity: amount, stockUnitName: row.stockUnitName, date: isoDate(row.effectiveDate), reason: row.reason, note: row.note || '', source: row.source, actorUserId: String(row.actorUserId), createdAt: row.createdAt, balance: balance === undefined ? '' : String(balance) };
}
async function ledger(businessId, userId, productId, variantKey) {
  await authorize(businessId, userId, 'business.inventory.view');
  const { product, variant } = await productUnits(businessId, productId, variantKey);
  const rows = await Movement.find({ businessId, ...movementFilter(product, variant.key) }).sort({ effectiveDate: 1, _id: 1 }).lean();
  let balance = 0;
  return { product: variationOptions(product).find(item => item.variantKey === variant.key), items: rows.map(row => { balance += (row.direction === 'in' ? 1 : -1) * number(row.stockQuantity); return presentMovement(row, Math.max(0, Math.round(balance * 10000) / 10000)); } ) };
}
async function report(businessId, userId, query = {}, sourceBillIds) {
  const ctx = await authorize(businessId, userId, 'business.reports.view');
  if (!query.productId) {
    const products = await Product.find({ businessId, type: { $nin: serviceTypes } }).sort({ normalizedName: 1 }).lean();
    return { products: products.flatMap(variationOptions), authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
  }
  if (!validId(query.productId)) throw fail(400, 'PRODUCT_REQUIRED', 'Choose a product for this report.');
  const start = dateOnly(query.startDate, 'start date'); const endDay = dateOnly(query.endDate, 'end date');
  if (endDay < start) throw fail(400, 'INVALID_DATE_RANGE', 'The start date must be on or before the end date.');
  const endExclusive = new Date(endDay.getTime() + 86400000);
  const { product, variant, choices, baseUnit } = await productUnits(businessId, query.productId, query.variantKey);
  const displayUnit = choices.find(unit => unit.id === String(query.unitKey || baseUnit.id));
  if (!displayUnit) throw fail(400, 'INVALID_UNIT', 'Choose a unit configured for this product.');
  const filter = { businessId, ...movementFilter(product, variant.key), effectiveDate: { $lt: endExclusive } };
  if (sourceBillIds) {
    filter.sourceBillId = { $in: sourceBillIds };
    filter.source = { $in: ['bill', 'bill_compensation'] };
  }
  const rows = await Movement.find(filter).sort({ effectiveDate: 1, _id: 1 }).lean();
  const factor = Number(displayUnit.factor);
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
    return { ...presentMovement(row), quantity: String(Math.round(number(row.stockQuantity) / factor * 10000) / 10000), unitName: displayUnit.name, unitSymbol: displayUnit.symbol, stockQuantity: String(qty), balance: String(Math.round(running * 10000) / 10000) };
  });
  const closing = Math.round(running * 10000) / 10000;
  return { product: variationOptions(product).find(item => item.variantKey === variant.key), unit: displayUnit, startDate: isoDate(start), endDate: isoDate(endDay), opening: String(opening), totalIn: String(Math.round(totalIn * 10000) / 10000), totalOut: String(Math.round(totalOut * 10000) / 10000), closing: String(sourceBillIds ? closing : Math.max(0, closing)), movements, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function setReorderLevel(businessId, userId, productId, input = {}) {
  await authorize(businessId, userId, 'business.inventory.adjust');
  if (!validId(productId)) throw fail(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  const text = input.reorderLevel === null || input.reorderLevel === '' ? null : String(input.reorderLevel).trim();
  if (text !== null && (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text) || text.length > 24 || Number(text) > 10000000000)) throw fail(400, 'INVALID_REORDER_LEVEL', 'Enter a non-negative reorder level up to 10 billion using at most four decimal places.');
  return withProductLock(businessId, productId, async () => {
    const { product, variant } = await productUnits(businessId, productId, input.variantKey);
    const variations = productUnitsConfig.variations(product);
    variations.find(item => item.key === variant.key).reorderLevel = text === null ? null : decimal(text);
    const update = { $set: { variations, legacyStockVariantKey: legacyKey(product) } };
    if (variant.key === legacyKey(product)) update.$unset = { reorderLevel: '' };
    await Product.updateOne({ _id: productId, businessId }, update);
    return { id: stockKey(productId, variant.key), reorderLevel: text || '' };
  });
}
async function validateBillStock(businessId, bill) {
  if (bill.billType !== 'sale') return;
  const requiredByProduct = new Map();
  for (let index = 0; index < (bill.lines || []).length; index += 1) {
    const line = bill.lines[index];
    if (isServiceLine(line)) continue;
    const productId = String(line.productId || '');
    if (!validId(productId)) throw fail(409, 'BILL_STOCK_PRODUCT_INVALID', 'A billed product is no longer available for stock movement.');
    const stock = await productUnits(businessId, productId, line.variantKey, line);
    if (!stock) continue;
    const { product, variant, choices } = stock;
    const selected = lineUnit(line, product, choices);
    if (!selected) throw fail(409, 'BILL_STOCK_UNIT_INVALID', `The stock unit for ${product.name} is no longer configured.`);
    const quantity = lineQuantity(line.quantity);
    const stockValue = scaled(productUnitsConfig.multiply(quantity, selected.factor, 4));
    if (stockValue <= 0n || stockValue > 100000000000000n) throw fail(409, 'INVALID_CONVERSION', 'This quantity cannot be represented accurately in the product stock unit.');
    const key = stockKey(productId, variant.key);
    const current = requiredByProduct.get(key) || { product, variantKey: variant.key, quantity: 0n };
    current.quantity += stockValue; requiredByProduct.set(key, current);
  }
  for (const [, required] of [...requiredByProduct.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const productId = String(required.product._id);
    await withProductLock(businessId, productId, async () => {
      const available = stockBalance(await currentStock(businessId, productId), required.product, required.variantKey);
      if (available < required.quantity) throw fail(409, 'INSUFFICIENT_STOCK', `The order would make ${required.product.name} variation stock negative.`);
    });
  }
}
async function recordBillMovement(businessId, userId, bill, line, direction, eventKey, compensation = false) {
  if (isServiceLine(line)) return { duplicate: true };
  const productId = String(line.productId || '');
  if (!validId(productId)) throw fail(409, 'BILL_STOCK_PRODUCT_INVALID', 'A billed product is no longer available for stock movement.');
  return withProductLock(businessId, productId, async () => {
    if (await Movement.exists({ businessId, sourceEventKey: eventKey })) return { duplicate: true };
    const original = compensation ? await Movement.findOne({ businessId, sourceBillId: bill._id, sourceBillLineId: String(line.lineId || line._id || ''), source: 'bill', ...(eventKey.endsWith(':rollback') ? { sourceEventKey: eventKey.slice(0, -9) } : {}) }).sort({ createdAt: -1 }).lean() : null;
    const stock = await productUnits(businessId, productId, original ? original.variantKey : line.variantKey, original ? { productType: 'Goods' } : line);
    if (!stock) return { duplicate: true };
    const { product, variant, choices, baseUnit } = stock;
    const selected = original ? { id: original.unitKey || String(original.unitId || ''), name: original.unitName, symbol: original.unitSymbol, factor: String(original.factorToBase || original.conversionFactor) } : lineUnit(line, product, choices);
    const quantity = original ? String(original.quantity) : lineQuantity(line.quantity);
    const stockValue = original ? scaled(String(original.stockQuantity)) : scaled(productUnitsConfig.multiply(quantity, selected.factor, 4));
    const onHand = stockBalance(await currentStock(businessId, productId), product, variant.key); const next = onHand + (direction === 'in' ? stockValue : -stockValue);
    if (next > 100000000000000n) throw fail(400, 'INVALID_CONVERSION', 'The resulting stock exceeds the supported range.');
    if (next < 0n) throw fail(409, 'INSUFFICIENT_STOCK', `The bill would make ${product.name} stock negative.`);
    const row = await Movement.create({ businessId, productId, variantKey: variant.key, variantValues: original?.variantValues || variant.values, productName: product.name, direction, quantity: decimal(quantity), unitKey: selected.id, factorToBase: selected.factor, unitName: selected.name, unitSymbol: selected.symbol, stockQuantity: decimal(decimalString(stockValue)), stockUnitKey: baseUnit.id, stockUnitSymbol: baseUnit.symbol, stockUnitName: baseUnit.name, effectiveDate: dateOnly(bill.billDate, 'bill date'), reason: direction === 'in' ? 'purchase' : 'sale', note: `Bill ${bill.billNumber || bill._id}`, source: compensation ? 'bill_compensation' : 'bill', sourceBillId: bill._id, sourceBillLineId: String(line.lineId || line._id || ''), sourceEventKey: eventKey, actorUserId: userId });
    return { id: String(row._id), balance: decimalString(next) };
  });
}
module.exports = { list, adjust, ledger, report, setReorderLevel, withProductLock, validateBillStock, recordBillMovement };
