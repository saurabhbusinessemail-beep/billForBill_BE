'use strict';
const { randomUUID } = require('node:crypto');
const { serviceModes } = require('../serviceMeasurement');

const mongoose = require('mongoose');
const productUnits = require('../productUnits');
const Movement = require('../../DB/models/BusinessInventoryMovement');
const { assertDatabaseConnected } = require('../../DB/connection');
const Business = require('../../DB/models/Business');
const BusinessType = require('../../DB/models/BusinessType');
const Product = require('../../DB/models/CatalogProduct');
const Category = require('../../DB/models/ProductCategory');
const Attribute = require('../../DB/models/ProductAttribute');
const Unit = require('../../DB/models/CatalogUnit');
const Tax = require('../../DB/models/TaxComponent');
const ProductImage = require('../../DB/models/ProductImage');
const BusinessProduct = require('../../DB/models/BusinessCatalogProduct');
const BusinessCategory = require('../../DB/models/BusinessCatalogCategory');
const BusinessAttribute = require('../../DB/models/BusinessCatalogAttribute');
const BusinessUnit = require('../../DB/models/BusinessCatalogUnit');
const BusinessTax = require('../../DB/models/BusinessCatalogTax');

const config = {
  'business-types': { model: BusinessType, refs: { productIds: Product, taxComponentIds: Tax }, unique: true },
  products: { model: Product, refs: { categoryIds: Category, attributeIds: Attribute, taxComponentIds: Tax } },
  categories: { model: Category, refs: { parentId: Category, unitIds: Unit }, siblings: true },
  attributes: { model: Attribute, refs: { unitIds: Unit }, unique: true },
  units: { model: Unit, unique: true },
  taxes: { model: Tax, unique: true },
};
function scopedConfig(kind, businessId) {
  if (!businessId) return config[kind];
  const models = { products: BusinessProduct, categories: BusinessCategory, attributes: BusinessAttribute, units: BusinessUnit, taxes: BusinessTax };
  const Model = models[kind];
  if (!Model) throw error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  const refs = kind === 'products' ? { categoryIds: BusinessCategory, attributeIds: BusinessAttribute, taxComponentIds: BusinessTax }
    : kind === 'categories' ? { parentId: BusinessCategory, unitIds: BusinessUnit }
      : kind === 'attributes' ? { unitIds: BusinessUnit } : {};
  return { model: Model, refs, unique: ['attributes', 'units', 'taxes'].includes(kind), siblings: kind === 'categories' };
}
function relatedModels(businessId) { return businessId ? { Product: BusinessProduct, Category: BusinessCategory, Attribute: BusinessAttribute, Unit: BusinessUnit, Tax: BusinessTax } : { Product, Category, Attribute, Unit, Tax }; }
const modelFor = (kind, businessId = null) => scopedConfig(kind, businessId).model;
const error = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const validId = (value) => mongoose.isValidObjectId(value);
const nameValue = (value, label, max = 100) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw error(400, 'INVALID_CATALOG', `Enter a valid ${label}.`);
  return value.trim();
};
const normalized = (value) => value.trim().toLocaleLowerCase('en-IN');
function canonicalProductType(value) {
  if (value === 'Physical' || value === 'Goods') return 'Goods';
  if (value === 'Service' || value === 'Services') return 'Services';
  return '';
}
function normalizeGtin(value) {
  if (value == null || value === '') return '';
  const gtin = typeof value === 'string' ? value.trim() : String(value);
  if (!gtin) return '';
  if (!/^\d+$/.test(gtin) || ![8, 12, 13, 14].includes(gtin.length)) throw error(400, 'INVALID_GTIN', 'Enter a valid 8, 12, 13, or 14 digit barcode / GTIN.');
  const digits = [...gtin].map(Number); const check = digits.pop();
  const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  if ((10 - (sum % 10)) % 10 !== check) throw error(400, 'INVALID_GTIN', 'The barcode / GTIN check digit is invalid.');
  return gtin;
}

function normalizeVariationMetadata(input) {
  const fields = {};
  for (const [key, max] of Object.entries({ barcode: 80 })) {
    if (!Object.hasOwn(input, key)) continue;
    if (input[key] != null && (typeof input[key] !== 'string' || input[key].trim().length > max)) throw error(400, 'INVALID_VARIANT_METADATA', `Enter a valid variation ${key}.`);
    fields[key] = input[key]?.trim() || '';
  }
  if (Object.hasOwn(input, 'gtin')) fields.gtin = normalizeGtin(input.gtin);
  if (Object.hasOwn(input, 'mrp')) {
    const amount = String(input.mrp ?? '').trim();
    if (amount && !/^\d{1,12}(?:\.\d{1,4})?$/.test(amount)) throw error(400, 'INVALID_MRP', 'Enter a valid nonnegative MRP.');
    fields.mrp = amount ? mongoose.Types.Decimal128.fromString(amount) : null;
  }
  return fields;
}

function prepareVariantIdentifiers(variations) {
  const keys = new Set();
  for (const variant of variations) {
    let barcodeGtin = '';
    if (variant.barcode) {
      try { barcodeGtin = normalizeGtin(variant.barcode); } catch (cause) { if (cause.code !== 'INVALID_GTIN') throw cause; }
    }
    variant.gtin = normalizeGtin(variant.gtin) || barcodeGtin;
    variant.barcode ||= variant.gtin;
    variant.normalizedGtin = variant.gtin ? variant.gtin.padStart(14, '0') : '';
    const barcodeKey = barcodeGtin ? `gtin:${barcodeGtin.padStart(14, '0')}` : variant.barcode ? `barcode:${variant.barcode.toUpperCase()}` : null;
    const gtinKey = variant.normalizedGtin ? `gtin:${variant.normalizedGtin}` : null;
    for (const key of new Set([barcodeKey, gtinKey].filter(Boolean))) {
      if (keys.has(key)) throw error(409, 'PRODUCT_GTIN_EXISTS', 'Each variation must have its own barcode or GTIN.');
      keys.add(key);
    }
  }
  return [...keys].sort();
}

function normalizeVariations(attributes, variations) {
  const invalid = () => error(400, 'INVALID_PRODUCT_VARIANTS', 'Enter unique attribute names and variant combinations.');
  if (!Array.isArray(attributes) || attributes.length > 20 || !Array.isArray(variations) || !variations.length || variations.length > 100) throw invalid();
  const names = attributes.map(value => {
    if (typeof value !== 'string') throw invalid();
    const name = value.trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u.test(name) || /^(constructor|prototype|__proto__)$/i.test(name)) throw invalid();
    return name;
  });
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw invalid();
  const combinations = new Set();
  const keys = new Set();
  const normalized = variations.map(variant => {
    if (!variant || !variant.values || typeof variant.values !== 'object' || Array.isArray(variant.values)) throw invalid();
    const key = variant.key ?? randomUUID();
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(key) || keys.has(key)) throw invalid();
    keys.add(key);
    const values = Object.entries(variant.values).map(([name, value]) => {
      if (!names.includes(name) || typeof value !== 'string' || value.trim().length > 160) throw invalid();
      return [name, value.trim()];
    }).filter(([, value]) => value);
    const byName = new Map(values);
    const combination = JSON.stringify(names.map(name => (byName.get(name) || '').toLowerCase()));
    if (combinations.has(combination)) throw invalid();
    combinations.add(combination);
    return { key, values: Object.fromEntries(values), ...normalizeVariationMetadata(variant),
      baseUnit: variant.baseUnit, additionalUnits: variant.additionalUnits ?? variant.units, quantityVariants: variant.quantityVariants };
  });
  return { attributes: names, variations: normalized };
}

function embedUnits(data, current) {
  if (!data.variations && !data.baseUnit && !productUnits.variationMetadataFields.some(field => Object.hasOwn(data, field))) return;
  const existing = current ? productUnits.variations(current.toObject ? current.toObject({ flattenMaps: true }) : current) : [];
  const legacyKey = current ? productUnits.legacyVariantKey(current) : data.variations?.[0]?.key || 'default';
  const variations = data.variations || (existing.length ? existing : [{ key: legacyKey, values: {} }]);
  data.variations = variations.map(variant => {
    const previous = existing.find(item => item.key === variant.key);
    const legacyEdit = data.baseUnit && variant.key === legacyKey && (!data.variations || !variant.baseUnit);
    const config = legacyEdit ? data : variant.baseUnit ? variant : previous || data;
    const units = config.units ?? config.additionalUnits ?? [];
    const unitByKey = new Map(Array.isArray(units) ? [config.baseUnit, ...units].filter(Boolean).map(unit => [unit.key, unit]) : []);
    const quantityVariants = config.quantityVariants ?? previous?.quantityVariants?.flatMap(pack => {
      const unit = unitByKey.get(pack.unitKey);
      return unit ? [{ ...pack, amountInBase: unit.factorToBase, active: unit.active !== false }] : [];
    });
    const legacyReorderLevel = Object.hasOwn(data, 'reorderLevel') ? data.reorderLevel : previous?.reorderLevel ?? current?.reorderLevel;
    const metadata = Object.fromEntries(productUnits.variationMetadataFields.map(field => [field,
      variant[field] === undefined ? previous?.[field] : variant[field]]));
    if (variant.key === legacyKey) Object.assign(metadata, normalizeVariationMetadata(Object.fromEntries(productUnits.variationMetadataFields
      .filter(field => Object.hasOwn(data, field)).map(field => [field, data[field]]))));
    return productUnits.storeVariation({ key: variant.key, values: variant.values, ...metadata,
      ...productUnits.normalize({ ...config, quantityVariants }),
      reorderLevel: variant.key === legacyKey ? legacyReorderLevel : previous?.reorderLevel });
  });
  if (!current) data.variations = productUnits.withEmptyVariation(data.variations);
  if (data.variations.length > 100) throw error(400, 'INVALID_PRODUCT_VARIANTS', 'Keep at most 100 variations, including the default.');
  data.variantIdentifierKeys = prepareVariantIdentifiers(data.variations);
  for (const field of productUnits.variationMetadataFields) delete data[field];
  data.legacyStockVariantKey = legacyKey;
  if (current && !Object.hasOwn(data, 'brand')) data.brand = productUnits.productBrand(current);
  delete data.baseUnit;
  delete data.units;
  delete data.quantityVariants;
  delete data.needsUnit;
  delete data.reorderLevel;
}

function normalize(kind, input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error(400, 'INVALID_CATALOG', 'Enter valid catalog details.');
  const output = {};
  const take = (key, transform, required = false) => {
    if (!partial || Object.hasOwn(input, key)) output[key] = transform(input[key], required);
  };
  const optional = (key, transform) => { if (Object.hasOwn(input, key)) output[key] = transform(input[key]); };
  const ids = (value, label) => {
    if (!Array.isArray(value) || value.length > 200 || value.some((id) => !validId(id))) throw error(400, 'INVALID_REFERENCE', `Choose valid ${label}.`);
    return [...new Set(value.map(String))];
  };
  if (kind === 'business-types') {
    take('name', (v) => nameValue(v, 'business type name'));
    optional('description', (v) => typeof v === 'string' ? v.trim().slice(0, 500) : '');
    optional('productIds', (v) => ids(v, 'products')); optional('taxComponentIds', (v) => ids(v, 'tax components'));
  } else if (kind === 'products') {
    take('name', (v) => nameValue(v, 'product name', 160));
    optional('title', value => value == null || value === '' ? '' : nameValue(value, 'product title', 160));
    optional('brand', value => value == null || value === '' ? '' : nameValue(value, 'product brand', 120));
    if (!partial) {
      output.title ||= output.name;
      output.brand ??= '';
    }
    take('type', (value) => {
      const type = canonicalProductType(value);
      if (!type) throw error(400, 'INVALID_PRODUCT_TYPE', 'Choose Goods or Services.');
      return type;
    });
    optional('description', (v) => typeof v === 'string' ? v.trim().slice(0, 1000) : '');
    optional('serviceMeasurement', mode => {
      if (mode == null || mode === '') return null;
      if (!serviceModes.includes(mode)) throw error(400, 'INVALID_SERVICE_MODE', 'Choose a valid service measurement mode.');
      return mode;
    });
    Object.assign(output, normalizeVariationMetadata(input));
    if (Object.hasOwn(input, 'attributes') || Object.hasOwn(input, 'variations') || Object.hasOwn(input, 'variants')) {
      Object.assign(output, normalizeVariations(input.attributes, input.variations ?? input.variants));
    }
    optional('code', (v) => { if (v === null || v === '') return ''; if (typeof v !== 'string' || v.trim().length > 40) throw error(400, 'INVALID_PRODUCT_CODE', 'Enter a product code up to 40 characters.'); return v.trim(); });
    if (Object.hasOwn(output, 'code')) output.normalizedCode = output.code.toLocaleUpperCase('en-IN');
    optional('reorderLevel', (v) => { if (v === null || v === '') return null; const text = String(v).trim(); if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text) || text.length > 24 || Number(text) > 10000000000) throw error(400, 'INVALID_REORDER_LEVEL', 'Enter a valid reorder level up to 10 billion using at most four decimal places.'); return mongoose.Types.Decimal128.fromString(text); });
    optional('categoryIds', (v) => ids(v, 'categories')); optional('attributeIds', (v) => ids(v, 'attributes')); optional('taxComponentIds', (v) => ids(v, 'tax components'));
    if ((!partial && !output.variations) || ['baseUnit', 'units', 'quantityVariants'].some(key => Object.hasOwn(input, key))) Object.assign(output, productUnits.normalize(input));
    optional('taxMode', (v) => { if (!['inherit', 'specific'].includes(v)) throw error(400, 'INVALID_TAX_MODE', 'Choose a tax mode.'); return v; });
  } else if (kind === 'categories') {
    take('name', (v) => nameValue(v, 'category name'));
    optional('parentId', (v) => { if (v === null || v === '') return null; if (!validId(v)) throw error(400, 'INVALID_REFERENCE', 'Choose a valid parent category.'); return v; });
    optional('unitIds', (v) => ids(v, 'units'));
  } else if (kind === 'attributes') {
    take('name', (v) => nameValue(v, 'attribute name')); optional('unitIds', (v) => ids(v, 'units'));
  } else if (kind === 'units') {
    take('name', (v) => nameValue(v, 'unit name')); take('symbol', (v) => nameValue(v, 'unit symbol', 24));
    optional('dimension', (v) => typeof v === 'string' ? v.trim().slice(0, 50) : 'other');
  } else if (kind === 'taxes') {
    take('name', (v) => nameValue(v, 'tax name')); take('calculationType', (v) => { if (!['percentage', 'fixed'].includes(v)) throw error(400, 'INVALID_TAX_TYPE', 'Choose percentage or fixed amount.'); return v; });
    take('value', (v) => { if (!Number.isFinite(v) || v < 0 || v > 100000000) throw error(400, 'INVALID_TAX_VALUE', 'Enter a valid tax amount or rate.'); return v; });
    take('effectiveStart', (v) => { const d = new Date(v); if (!v || Number.isNaN(d.getTime())) throw error(400, 'INVALID_TAX_DATE', 'Choose an effective start date.'); return d; });
    optional('effectiveEnd', (v) => { if (!v) return null; const d = new Date(v); if (Number.isNaN(d.getTime())) throw error(400, 'INVALID_TAX_DATE', 'Choose a valid end date.'); return d; });
    optional('currency', (v) => typeof v === 'string' ? v.trim().toUpperCase() : '');
    optional('jurisdiction', (v) => typeof v === 'string' ? v.trim().slice(0, 100) : ''); optional('description', (v) => typeof v === 'string' ? v.trim().slice(0, 500) : '');
  }
  if (output.name) output.normalizedName = normalized(output.name);
  if (kind === 'taxes') {
    const calculationType = output.calculationType || input.calculationType;
    const value = output.value ?? input.value;
    const start = output.effectiveStart || input.effectiveStart;
    const end = Object.hasOwn(output, 'effectiveEnd') ? output.effectiveEnd : input.effectiveEnd;
    const currency = (output.currency ?? input.currency ?? '').toUpperCase();
    if (calculationType === 'percentage' && value > 100) throw error(400, 'INVALID_TAX_VALUE', 'Percentage must be between 0 and 100.');
    if (calculationType === 'fixed' && !/^[A-Z]{3}$/.test(currency)) throw error(400, 'CURRENCY_REQUIRED', 'Choose a three-letter currency for a fixed amount.');
    if (calculationType === 'fixed') output.currency = currency;
    if (end && start && new Date(end) < new Date(start)) throw error(400, 'INVALID_TAX_DATE', 'The end date must be on or after the start date.');
  }
  return output;
}

const scopeFilter = (businessId) => ({ businessId: businessId || null });
async function validateRefs(kind, data, businessId = null) {
  const current = scopedConfig(kind, businessId);
  for (const [field, Model] of Object.entries(current.refs || {})) {
    const value = data[field]; if (value === undefined || value === null) continue;
    const ids = field === 'additionalUnits' ? value.map((item) => item.unitId) : Array.isArray(value) ? value : [value];
    if (ids.length && await Model.countDocuments({ ...scopeFilter(businessId), _id: { $in: ids } }) !== new Set(ids.map(String)).size) throw error(400, 'INVALID_REFERENCE', `One or more ${field} do not exist.`);
  }
  if (kind === 'products' && data.baseUnit) productUnits.normalize(data);
}

async function assertUnique(kind, Model, data, id, businessId = null) {
  if (!config[kind].unique && kind !== 'categories') return;
  const filter = { ...scopeFilter(businessId), normalizedName: data.normalizedName };
  if (id) filter._id = { $ne: id };
  if (kind === 'categories') filter.parentId = Object.hasOwn(data, 'parentId') ? data.parentId : null;
  if (await Model.exists(filter)) throw error(409, 'CATALOG_NAME_EXISTS', 'An item with this name already exists.');
}

async function assertProductNameUnique(data, id, businessId = null) {
  if (!data.normalizedName) return;
  const filter = { ...scopeFilter(businessId), normalizedName: data.normalizedName };
  if (id) filter._id = { $ne: id };
  const products = await scopedConfig('products', businessId).model.find(filter).select('_id categoryIds').lean();
  const selected = new Set((data.categoryIds || []).map(String));
  if (products.some((product) => {
    const existing = (product.categoryIds || []).map(String);
    return !selected.size ? !existing.length : existing.some((categoryId) => selected.has(categoryId));
  })) throw error(409, 'PRODUCT_NAME_EXISTS', 'A product with this name already exists in one of the selected categories.');
}
async function assertProductCodeUnique(data, id, businessId = null) {
  const normalizedCode = data.normalizedCode;
  if (!normalizedCode || !businessId) return;
  const filter = { ...scopeFilter(businessId), normalizedCode };
  if (id) filter._id = { $ne: id };
  if (await BusinessProduct.exists(filter)) throw error(409, 'PRODUCT_CODE_EXISTS', 'This product code is already used in this business.');
}
async function assertProductGtinUnique(data, id, businessId = null) {
  const keys = data.variantIdentifierKeys || [];
  if (!keys.length) return;
  const Model = scopedConfig('products', businessId).model;
  const legacyGtins = keys.filter(key => key.startsWith('gtin:')).flatMap(key =>
    [8, 12, 13, 14].map(length => key.slice(5).slice(-length)).filter(gtin => gtin.padStart(14, '0') === key.slice(5)));
  const filter = { ...scopeFilter(businessId), $or: [
    { variantIdentifierKeys: { $in: keys } },
    { normalizedGtin: { $in: legacyGtins } },
    { gtin: { $in: legacyGtins } },
  ] };
  if (id) filter._id = { $ne: id };
  if (await Model.exists(filter)) throw error(409, 'PRODUCT_GTIN_EXISTS', 'This barcode / GTIN is already used in this catalog.');
}

async function assertCategoryTree(id, parentId, businessId = null) {
  if (!parentId) return;
  if (id && String(id) === String(parentId)) throw error(400, 'CATEGORY_CYCLE', 'A category cannot be its own parent.');
  const CategoryModel = scopedConfig('categories', businessId).model;
  let cursor = await CategoryModel.findOne({ ...scopeFilter(businessId), _id: parentId }).select('_id parentId').lean();
  while (cursor) {
    if (id && String(cursor._id) === String(id)) throw error(400, 'CATEGORY_CYCLE', 'A category cannot be placed under its own descendant.');
    cursor = cursor.parentId ? await CategoryModel.findOne({ ...scopeFilter(businessId), _id: cursor.parentId }).select('_id parentId').lean() : null;
  }
}

async function present(kind, doc) {
  const row = doc.toObject ? doc.toObject({ flattenMaps: true }) : doc;
  const result = { ...row, id: String(row._id) }; delete result._id; delete result.__v;
  if (kind === 'business-types') { result.productCount = (row.productIds || []).length; result.taxCount = (row.taxComponentIds || []).length; delete result.openFoodFactsConfig; }
  if (kind === 'products') {
    for (const field of ['externalSource', 'externalProductId', 'externalProductUrl', 'externalUpdatedAt', 'lastSyncedAt', 'pendingAttributes']) delete result[field];
    const ownImage = Boolean(await ProductImage.exists({ productId: row._id }));
    result.type = canonicalProductType(row.type);
    if (result.type === 'Services') result.serviceMeasurement = row.serviceMeasurement || 'date_time';
    if (result.type === 'Goods') delete result.serviceMeasurement;
    const sourceImage = Boolean(!ownImage && row.sourceProductId && await ProductImage.exists({ productId: row.sourceProductId }));
    result.hasImage = ownImage || sourceImage;
    result.imageId = String(sourceImage ? row.sourceProductId : row._id);
    result.canEditImage = !row.businessId || !row.sourceProductId;
    for (const field of productUnits.variationMetadataFields) delete result[field];
    result.attributes = row.attributes || [];
    result.businessId = row.businessId ? String(row.businessId) : null;
    result.title = row.title || row.name;
    result.brand = productUnits.productBrand(row);
    result.variations = productUnits.variations(row).map(({ quantityVariants, reorderLevel, needsUnit, ...variant }) =>
      ({ ...variant, mrp: variant.mrp?.toString() ?? null }));
    result.needsUnit = result.variations.some(variant => !variant.baseUnit);
    result.unitCount = result.variations.reduce((count, variant) => count + productUnits.options(row, variant.key).length, 0);
    for (const field of ['variants', 'baseUnit', 'units', 'quantityVariants', 'baseUnitId', 'additionalUnits',
      'elid', 'mrp', 'normalizedName', 'normalizedCode', 'legacyStockVariantKey', 'variantIdentifierKeys',
      'sourceProductId', 'reorderLevel', 'description']) delete result[field];
  }
  return result;
}

async function list(kind, query = {}, businessId = null) {
  assertDatabaseConnected();
  const Model = scopedConfig(kind, businessId).model;
  const filter = scopeFilter(businessId);
  if (query.q) {
    const term = { $regex: String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80), $options: 'i' };
    if (kind === 'products') filter.$or = [{ name: term }, { title: term }, { brand: term }];
    else filter.name = term;
  }
  if (kind === 'categories' && query.parentId !== undefined) filter.parentId = query.parentId === 'root' ? null : query.parentId;
  const limit = Math.max(1, Math.min(Number.parseInt(query.limit, 10) || 200, 200));
  const rows = await Model.find(filter).sort({ name: 1, _id: 1 }).limit(limit).lean();
  return Promise.all(rows.map((row) => present(kind, row)));
}
async function get(kind, id, businessId = null) {
  assertDatabaseConnected(); if (!validId(id)) throw error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  const row = await scopedConfig(kind, businessId).model.findOne({ ...scopeFilter(businessId), _id: id }).lean(); if (!row) throw error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  return present(kind, row);
}
async function create(kind, input, businessId = null) {
  assertDatabaseConnected(); const data = normalize(kind, input); if (kind === 'products') embedUnits(data); await validateRefs(kind, data, businessId); const Model = scopedConfig(kind, businessId).model;
  await assertUnique(kind, Model, data, null, businessId); if (kind === 'products') { await assertProductNameUnique(data, null, businessId); await assertProductCodeUnique(data, null, businessId); await assertProductGtinUnique(data, null, businessId); }
  if (kind === 'categories') await assertCategoryTree(null, data.parentId, businessId);
  try {
    const row = await Model.create({ ...data, businessId: businessId || null });
    if (kind === 'business-types' && !businessId) await require('../businessCatalogCopy.service').pushBusinessTypeProducts(row._id, row.productIds || []);
    return present(kind, row);
  }
  catch (e) { if (e.code === 11000 && kind === 'products' && e.keyPattern?.variantIdentifierKeys) throw error(409, 'PRODUCT_GTIN_EXISTS', 'This barcode / GTIN is already used in this catalog.'); if (e.code === 11000) throw error(409, 'CATALOG_NAME_EXISTS', 'An item with this name already exists.'); throw e; }
}
async function update(kind, id, input, businessId = null, locked = false) {
  if (kind === 'products' && businessId && !locked) return require('../businessInventory.service').withProductLock(businessId, id, () => update(kind, id, input, businessId, true));
  assertDatabaseConnected(); if (!validId(id)) throw error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  const Model = scopedConfig(kind, businessId).model; const current = await Model.findOne({ ...scopeFilter(businessId), _id: id }); if (!current) throw error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  const data = normalize(kind, input, true); if (!Object.keys(data).length) throw error(400, 'EMPTY_CATALOG_UPDATE', 'Provide catalog details.');
  if (kind === 'products') embedUnits(data, current);
  if (kind === 'products' && data.variations && businessId) {
    for (const variant of productUnits.variations(current)) {
      const next = data.variations.find(item => item.key === variant.key);
      const base = variant.baseUnit;
      if (next && base && ['key', 'name', 'symbol', 'dimension'].every(field => base[field] === next.baseUnit[field])) continue;
      const variantFilter = variant.key === data.legacyStockVariantKey ? { $in: [variant.key, null] } : variant.key;
      if (!await Movement.exists({ businessId, productId: id, variantKey: variantFilter })) continue;
      const legacyBase = !base && current.baseUnitId && await BusinessUnit.findOne({ _id: current.baseUnitId, businessId }).select('name symbol dimension').lean();
      if (next && legacyBase && ['name', 'symbol', 'dimension'].every(field => legacyBase[field] === next.baseUnit[field])) continue;
      throw error(409, 'PRODUCT_BASE_UNIT_IN_USE', 'A variation with inventory history cannot be removed or change its base unit.');
    }
  }
  if (data.variations && !data.variations.some(item => item.key === data.legacyStockVariantKey)) {
    data.legacyStockVariantKey = data.variations[0].key;
  }
  if (kind === 'categories' && !Object.hasOwn(data, 'parentId')) data.parentId = current.parentId || null;
  await validateRefs(kind, data, businessId); await assertUnique(kind, Model, data, id, businessId);
  if (kind === 'categories' && Object.hasOwn(data, 'parentId')) await assertCategoryTree(id, data.parentId, businessId);
  if (kind === 'products') {
    await assertProductNameUnique({ normalizedName: data.normalizedName || current.normalizedName, categoryIds: data.categoryIds || current.categoryIds }, id, businessId);
    await assertProductCodeUnique({ normalizedCode: Object.hasOwn(data, 'normalizedCode') ? data.normalizedCode : current.normalizedCode }, id, businessId);
    await assertProductGtinUnique(data, id, businessId);
  }
  try {
    const retiredUnits = kind === 'products' && data.variations ? { $unset: { variants: '', baseUnit: '', units: '', quantityVariants: '', needsUnit: '', baseUnitId: '', additionalUnits: '', ...Object.fromEntries(productUnits.variationMetadataFields.map(field => [field, ''])), ...(businessId ? { reorderLevel: '' } : {}) } } : {};
    const row = await Model.findOneAndUpdate({ ...scopeFilter(businessId), _id: id }, { $set: data, ...retiredUnits }, { new: true, runValidators: true });
    if (kind === 'business-types' && !businessId && (Object.hasOwn(data, 'productIds') || Object.hasOwn(data, 'taxComponentIds'))) {
      await require('../businessCatalogCopy.service').pushBusinessTypeProducts(row._id, row.productIds || []);
    }
    return present(kind, row);
  }
  catch (e) { if (e.code === 11000 && kind === 'products' && e.keyPattern?.variantIdentifierKeys) throw error(409, 'PRODUCT_GTIN_EXISTS', 'This barcode / GTIN is already used in this catalog.'); if (e.code === 11000) throw error(409, 'CATALOG_NAME_EXISTS', 'An item with this name already exists.'); throw e; }
}

async function remove(kind, id, businessId = null, options = {}) {
  assertDatabaseConnected(); if (!validId(id)) throw error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  const Model = scopedConfig(kind, businessId).model; const { Product: ProductModel, Category: CategoryModel, Attribute: AttributeModel, Unit: UnitModel } = relatedModels(businessId); const scope = scopeFilter(businessId); const row = await Model.findOne({ ...scope, _id: id }).select('_id parentId sourceProductId').lean(); if (!row) throw error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  let removedLinks = 0; const idFilter = { _id: id };
  if (kind === 'business-types') {
    if (await Business.exists({ businessTypeId: id })) throw error(409, 'BUSINESS_TYPE_IN_USE', 'A business is already assigned to this type, so it cannot be deleted.');
  }
  if (kind === 'products') {
    if (businessId) {
      await ProductImage.deleteOne({ productId: id });
      if (row.sourceProductId && !(await BusinessProduct.exists({ businessId: { $ne: businessId }, sourceProductId: row.sourceProductId })) && !(await Product.exists({ _id: row.sourceProductId }))) await ProductImage.deleteOne({ productId: row.sourceProductId });
    } else {
      const copyFilter = { sourceProductId: id };
      const businessIds = await BusinessProduct.distinct('businessId', copyFilter);
      const copiesExist = businessIds.length > 0;
      if (copiesExist && options.scope !== 'admin-only' && options.scope !== 'all-copies') throw error(409, 'PRODUCT_COPIES_REQUIRE_CHOICE', 'Choose whether to delete this product from Admin Setup only or from all copied business catalogs.');
      if (options.scope === 'all-copies' && copiesExist) {
        const copiedIds = await BusinessProduct.find(copyFilter).distinct('_id');
        await ProductImage.deleteMany({ productId: { $in: copiedIds } });
        removedLinks += (await BusinessProduct.deleteMany(copyFilter)).deletedCount || 0;
        await ProductImage.deleteOne({ productId: id });
      } else if (!copiesExist) await ProductImage.deleteOne({ productId: id });
      removedLinks += (await BusinessType.updateMany({ productIds: id, businessId: null }, { $pull: { productIds: id } })).modifiedCount;
    }
  }
  if (kind === 'categories') {
    await CategoryModel.updateMany({ ...scope, parentId: id }, { $set: { parentId: row.parentId || null } });
    removedLinks = (await ProductModel.updateMany({ ...scope, categoryIds: id }, { $pull: { categoryIds: id } })).modifiedCount;
  }
  if (kind === 'attributes') removedLinks = (await ProductModel.updateMany({ ...scope, attributeIds: id }, { $pull: { attributeIds: id } })).modifiedCount;
  if (kind === 'units') {
    const results = await Promise.all([
      ProductModel.updateMany({ ...scope, baseUnit: null, baseUnitId: id }, { $set: { baseUnitId: null, needsUnit: true } }),
      ProductModel.updateMany({ ...scope, baseUnit: null, 'additionalUnits.unitId': id }, { $pull: { additionalUnits: { unitId: id } } }),
      CategoryModel.updateMany({ ...scope, unitIds: id }, { $pull: { unitIds: id } }),
      AttributeModel.updateMany({ ...scope, unitIds: id }, { $pull: { unitIds: id } }),
    ]); removedLinks = results.reduce((sum, item) => sum + item.modifiedCount, 0);
  }
  if (kind === 'taxes') {
    const results = await Promise.all([ProductModel.updateMany({ ...scope, taxComponentIds: id }, { $pull: { taxComponentIds: id } }), ...(businessId ? [Business.updateOne({ _id: businessId }, { $pull: { businessTaxComponentIds: id } })] : [BusinessType.updateMany({ businessId: null, taxComponentIds: id }, { $pull: { taxComponentIds: id } })])]);
    removedLinks = results.reduce((sum, item) => sum + item.modifiedCount, 0);
  }
  await Model.deleteOne({ ...scope, ...idFilter }); return { id: String(id), removedLinks };
}

async function deleteImpact(kind, id, businessId = null) {
  assertDatabaseConnected(); if (!validId(id)) throw error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  const Model = scopedConfig(kind, businessId).model; const { Product: ProductModel, Category: CategoryModel, Attribute: AttributeModel } = relatedModels(businessId); const scope = scopeFilter(businessId); const record = await Model.findOne({ ...scope, _id: id }).lean(); if (!record) throw error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  const affected = [];
  let businessCopyCount = 0;
  const add = async (label, promise, action) => { const count = await promise; if (count) affected.push({ label, count, action }); };
  if (kind === 'business-types') {
    await add('businesses', Business.countDocuments({ businessTypeId: id }), 'businessTypeUnset');
    await add('includedProducts', (record.productIds || []).length, 'associationRemoved');
    await add('includedTaxes', (record.taxComponentIds || []).length, 'taxAssociationRemoved');
  }
  if (kind === 'products') {
    if (!businessId) {
      const copies = await BusinessProduct.find({ sourceProductId: id }).select('businessId').lean();
      const businesses = new Set(copies.map((product) => String(product.businessId)));
      businessCopyCount = businesses.size;
      if (businesses.size) affected.push({ label: 'businessCatalogs', count: businesses.size, action: 'deleteChoiceRequired' });
    }
    await add('businessTypes', businessId ? 0 : BusinessType.countDocuments({ businessId: null, productIds: id }), 'associationRemoved');
    await add('productCategories', (record.categoryIds || []).length, 'categoryAssociationRemoved');
    await add('productAttributes', (record.attributeIds || []).length, 'attributeAssociationRemoved');
    await add('productTaxes', (record.taxComponentIds || []).length, 'taxAssociationRemoved');

  }
  if (kind === 'categories') {
    await add('products', ProductModel.countDocuments({ ...scope, categoryIds: id }), 'categoryAssociationRemoved');
    await add('subcategories', CategoryModel.countDocuments({ ...scope, parentId: id }), 'subcategoriesReparented');
    await add('categoryUnits', (record.unitIds || []).length, 'unitAssociationRemoved');
  }
  if (kind === 'attributes') await add('products', ProductModel.countDocuments({ ...scope, attributeIds: id }), 'attributeAssociationRemoved');
  if (kind === 'units') {
    await add('productsUsingAsBaseUnit', ProductModel.countDocuments({ ...scope, baseUnit: null, baseUnitId: id }), 'productsMarkedNeedsUnit');
    await add('productConversions', ProductModel.countDocuments({ ...scope, baseUnit: null, 'additionalUnits.unitId': id }), 'conversionRemoved');
    await add('categories', CategoryModel.countDocuments({ ...scope, unitIds: id }), 'unitAssociationRemoved');
    await add('attributes', AttributeModel.countDocuments({ ...scope, unitIds: id }), 'unitAssociationRemoved');
  }
  if (kind === 'taxes') {
    await add('products', ProductModel.countDocuments({ ...scope, taxComponentIds: id }), 'taxAssociationRemoved');
    await add('businessTypes', businessId ? 0 : BusinessType.countDocuments({ businessId: null, taxComponentIds: id }), 'taxAssociationRemoved');
    if (businessId) await add('businesses', Business.countDocuments({ _id: businessId, businessTaxComponentIds: id }), 'taxAssociationRemoved');
  }
  return { id: String(id), affected, ...(kind === 'products' && !businessId ? { businessCopyCount } : {}) };
}

module.exports = { list, get, create, update, remove, deleteImpact, normalize, embedUnits, validateRefs, assertProductNameUnique, assertProductCodeUnique, assertProductGtinUnique, canonicalProductType, normalizeGtin, prepareVariantIdentifiers, present, error, modelFor };
