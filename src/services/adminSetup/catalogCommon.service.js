'use strict';

const mongoose = require('mongoose');
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
  products: { model: Product, refs: { categoryIds: Category, baseUnitId: Unit, additionalUnits: Unit, attributeIds: Attribute, taxComponentIds: Tax } },
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
  const refs = kind === 'products' ? { categoryIds: BusinessCategory, baseUnitId: BusinessUnit, additionalUnits: BusinessUnit, attributeIds: BusinessAttribute, taxComponentIds: BusinessTax }
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
    take('name', (v) => nameValue(v, 'product name', 160)); take('type', (v) => nameValue(v, 'product type', 50));
    optional('description', (v) => typeof v === 'string' ? v.trim().slice(0, 1000) : '');
    optional('code', (v) => { if (v === null || v === '') return ''; if (typeof v !== 'string' || v.trim().length > 40) throw error(400, 'INVALID_PRODUCT_CODE', 'Enter a product code up to 40 characters.'); return v.trim(); });
    if (Object.hasOwn(output, 'code')) output.normalizedCode = output.code.toLocaleUpperCase('en-IN');
    optional('reorderLevel', (v) => { if (v === null || v === '') return null; const text = String(v).trim(); if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text) || text.length > 24 || Number(text) > 10000000000) throw error(400, 'INVALID_REORDER_LEVEL', 'Enter a valid reorder level up to 10 billion using at most four decimal places.'); return mongoose.Types.Decimal128.fromString(text); });
    optional('categoryIds', (v) => ids(v, 'categories')); optional('attributeIds', (v) => ids(v, 'attributes')); optional('taxComponentIds', (v) => ids(v, 'tax components'));
    optional('baseUnitId', (v) => { if (!validId(v)) throw error(400, 'PRODUCT_UNIT_REQUIRED', 'Choose a base unit.'); return v; });
    optional('additionalUnits', (v) => {
      if (!Array.isArray(v) || v.length > 30) throw error(400, 'INVALID_REFERENCE', 'Choose valid additional units.');
      return v.map((item) => { if (!item || !validId(item.unitId) || !Number.isFinite(item.conversionFactor) || item.conversionFactor <= 0) throw error(400, 'INVALID_REFERENCE', 'Enter valid unit conversions.'); return { unitId: item.unitId, conversionFactor: item.conversionFactor }; });
    });
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
  if (kind === 'products') {
    if (!data.baseUnitId) throw error(400, 'PRODUCT_UNIT_REQUIRED', 'Choose a base unit.');
    const ids = [data.baseUnitId, ...(data.additionalUnits || []).map((item) => item.unitId)];
    const units = await scopedConfig('units', businessId).model.find({ ...scopeFilter(businessId), _id: { $in: ids } }).select('_id dimension').lean();
    const base = units.find((unit) => String(unit._id) === String(data.baseUnitId));
    if (!base || units.some((unit) => unit.dimension !== base.dimension)) throw error(400, 'INCOMPATIBLE_UNIT', 'Product units must use the same dimension.');
  }
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
  const row = doc.toObject ? doc.toObject() : doc;
  const result = { ...row, id: String(row._id) }; delete result._id; delete result.__v;
  if (kind === 'business-types') { result.productCount = (row.productIds || []).length; result.taxCount = (row.taxComponentIds || []).length; }
  if (kind === 'products') {
    const ownImage = Boolean(await ProductImage.exists({ productId: row._id }));
    const sourceImage = Boolean(!ownImage && row.sourceProductId && await ProductImage.exists({ productId: row.sourceProductId }));
    result.hasImage = ownImage || sourceImage;
    result.imageId = String(sourceImage ? row.sourceProductId : row._id);
    result.unitCount = (row.baseUnitId ? 1 : 0) + (row.additionalUnits || []).length;
  }
  return result;
}

async function list(kind, query = {}, businessId = null) {
  assertDatabaseConnected();
  const Model = scopedConfig(kind, businessId).model;
  const filter = scopeFilter(businessId);
  if (query.q) filter.name = { $regex: String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80), $options: 'i' };
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
  assertDatabaseConnected(); const data = normalize(kind, input); await validateRefs(kind, data, businessId); const Model = scopedConfig(kind, businessId).model;
  await assertUnique(kind, Model, data, null, businessId); if (kind === 'products') { await assertProductNameUnique(data, null, businessId); await assertProductCodeUnique(data, null, businessId); }
  if (kind === 'categories') await assertCategoryTree(null, data.parentId, businessId);
  try { return present(kind, await Model.create({ ...data, businessId: businessId || null })); }
  catch (e) { if (e.code === 11000) throw error(409, 'CATALOG_NAME_EXISTS', 'An item with this name already exists.'); throw e; }
}
async function update(kind, id, input, businessId = null) {
  assertDatabaseConnected(); if (!validId(id)) throw error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  const Model = scopedConfig(kind, businessId).model; const current = await Model.findOne({ ...scopeFilter(businessId), _id: id }); if (!current) throw error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  const data = normalize(kind, input, true); if (!Object.keys(data).length) throw error(400, 'EMPTY_CATALOG_UPDATE', 'Provide catalog details.');
  if (kind === 'categories' && !Object.hasOwn(data, 'parentId')) data.parentId = current.parentId || null;
  await validateRefs(kind, data, businessId); await assertUnique(kind, Model, data, id, businessId);
  if (kind === 'categories' && Object.hasOwn(data, 'parentId')) await assertCategoryTree(id, data.parentId, businessId);
  if (kind === 'products') {
    await assertProductNameUnique({ normalizedName: data.normalizedName || current.normalizedName, categoryIds: data.categoryIds || current.categoryIds }, id, businessId);
    await assertProductCodeUnique({ normalizedCode: Object.hasOwn(data, 'normalizedCode') ? data.normalizedCode : current.normalizedCode }, id, businessId);
    if (current.needsUnit && !data.baseUnitId) throw error(400, 'PRODUCT_UNIT_REQUIRED', 'Choose a replacement base unit.');
    if (!(await ProductImage.exists({ productId: id })) && !(current.sourceProductId && await ProductImage.exists({ productId: current.sourceProductId }))) throw error(400, 'PRODUCT_IMAGE_REQUIRED', 'Upload a product image before saving this product.');
  }
  try { return present(kind, await Model.findOneAndUpdate({ ...scopeFilter(businessId), _id: id }, { $set: data }, { new: true, runValidators: true })); }
  catch (e) { if (e.code === 11000) throw error(409, 'CATALOG_NAME_EXISTS', 'An item with this name already exists.'); throw e; }
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
      ProductModel.updateMany({ ...scope, baseUnitId: id }, { $set: { baseUnitId: null, needsUnit: true } }),
      ProductModel.updateMany({ ...scope, 'additionalUnits.unitId': id }, { $pull: { additionalUnits: { unitId: id } } }),
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
    await add('productUnits', (record.baseUnitId ? 1 : 0) + (record.additionalUnits || []).length, 'unitAssociationRemoved');
  }
  if (kind === 'categories') {
    await add('products', ProductModel.countDocuments({ ...scope, categoryIds: id }), 'categoryAssociationRemoved');
    await add('subcategories', CategoryModel.countDocuments({ ...scope, parentId: id }), 'subcategoriesReparented');
    await add('categoryUnits', (record.unitIds || []).length, 'unitAssociationRemoved');
  }
  if (kind === 'attributes') await add('products', ProductModel.countDocuments({ ...scope, attributeIds: id }), 'attributeAssociationRemoved');
  if (kind === 'units') {
    await add('productsUsingAsBaseUnit', ProductModel.countDocuments({ ...scope, baseUnitId: id }), 'productsMarkedNeedsUnit');
    await add('productConversions', ProductModel.countDocuments({ ...scope, 'additionalUnits.unitId': id }), 'conversionRemoved');
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

module.exports = { list, get, create, update, remove, deleteImpact, normalize, validateRefs, assertProductNameUnique, present, error, modelFor };
