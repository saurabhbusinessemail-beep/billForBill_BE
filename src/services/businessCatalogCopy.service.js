'use strict';

const mongoose = require('mongoose');
const crypto = require('node:crypto');
const BusinessMutationLock = require('../DB/models/BusinessMutationLock');
const SourceProduct = require('../DB/models/CatalogProduct');
const SourceCategory = require('../DB/models/ProductCategory');
const SourceAttribute = require('../DB/models/ProductAttribute');
const SourceUnit = require('../DB/models/CatalogUnit');
const SourceTax = require('../DB/models/TaxComponent');
const Product = require('../DB/models/BusinessCatalogProduct');
const Category = require('../DB/models/BusinessCatalogCategory');
const Attribute = require('../DB/models/BusinessCatalogAttribute');
const Unit = require('../DB/models/BusinessCatalogUnit');
const Tax = require('../DB/models/BusinessCatalogTax');
const ProductImage = require('../DB/models/ProductImage');
const BusinessType = require('../DB/models/BusinessType');

const key = (value) => String(value);
const ids = (list) => [...new Set((list || []).filter(Boolean).map(key))];
function mapped(value, map) { return value ? map.get(key(value)) || null : null; }
function mappedList(list, map) { return (list || []).map((value) => mapped(value, map)).filter(Boolean); }
function stableId(businessId, kind, sourceId) { return new mongoose.Types.ObjectId(crypto.createHash('sha256').update(`${businessId}:${kind}:${sourceId}`).digest('hex').slice(0, 24)); }

async function copyCatalogUnlocked(business) {
  const type = await BusinessType.findOne({ _id: business.businessTypeId, businessId: null }).lean();
  if (!type) throw Object.assign(new Error('Choose an available business type.'), { statusCode: 400, code: 'BUSINESS_TYPE_NOT_FOUND' });
  const products = await SourceProduct.find({ _id: { $in: type.productIds || [] }, businessId: null }).lean();
  if (products.length !== (type.productIds || []).length) throw Object.assign(new Error('The selected business type references missing products.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  const taxIds = ids([...(type.taxComponentIds || []), ...products.flatMap((p) => p.taxComponentIds || [])]);
  const taxes = await SourceTax.find({ _id: { $in: taxIds }, businessId: null }).lean();
  if (taxes.length !== taxIds.length) throw Object.assign(new Error('The selected business type references missing tax components.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  const categories = await SourceCategory.find({ businessId: null }).lean();
  const productCategoryIds = ids(products.flatMap((p) => p.categoryIds || []));
  const categorySet = new Set(productCategoryIds);
  if (categories.filter((c) => categorySet.has(key(c._id))).length !== categorySet.size) throw Object.assign(new Error('A product references a missing category.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  let changed = true;
  while (changed) {
    changed = false;
    for (const category of categories) {
      if (categorySet.has(key(category._id)) && category.parentId && !categorySet.has(key(category.parentId))) { categorySet.add(key(category.parentId)); changed = true; }
    }
  }
  const selectedCategories = categories.filter((c) => categorySet.has(key(c._id)));
  const attributeIds = ids(products.flatMap((p) => p.attributeIds || []));
  const attributes = await SourceAttribute.find({ _id: { $in: attributeIds }, businessId: null }).lean();
  if (attributes.length !== attributeIds.length) throw Object.assign(new Error('A product references a missing attribute.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  const unitIds = ids([
    ...products.flatMap((p) => [p.baseUnitId, ...(p.additionalUnits || []).map((u) => u.unitId)]),
    ...selectedCategories.flatMap((c) => c.unitIds || []), ...attributes.flatMap((a) => a.unitIds || []),
  ]);
  const units = await SourceUnit.find({ _id: { $in: unitIds }, businessId: null }).lean();
  if (units.length !== unitIds.length) throw Object.assign(new Error('The catalog references a missing unit.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  if (products.some((product) => !product.baseUnitId)) throw Object.assign(new Error('A product is missing its required base unit.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  const images = await ProductImage.find({ productId: { $in: products.map((p) => p._id) } }).select('productId').lean();
  if (images.length !== products.length) throw Object.assign(new Error('The selected business type has products without images.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  const maps = Object.fromEntries(['products', 'categories', 'attributes', 'units', 'taxes'].map((name) => [name, new Map()]));
  for (const [name, rows] of Object.entries({ products, categories: selectedCategories, attributes, units, taxes })) for (const row of rows) maps[name].set(key(row._id), stableId(business._id, name, row._id));
  const ownedIds = { products: [...maps.products.values()], categories: [...maps.categories.values()], attributes: [...maps.attributes.values()], units: [...maps.units.values()], taxes: [...maps.taxes.values()] };
  const writeRows = async (Model, rows) => { if (rows.length) await Model.bulkWrite(rows.map((row) => ({ replaceOne: { filter: { _id: row._id, businessId: business._id }, replacement: row, upsert: true } })), { ordered: true }); };
  try {
    await writeRows(Unit, units.map((x) => ({ ...x, _id: maps.units.get(key(x._id)), businessId: business._id })));
    await writeRows(Category, selectedCategories.map((x) => ({ ...x, _id: maps.categories.get(key(x._id)), businessId: business._id, parentId: mapped(x.parentId, maps.categories), unitIds: mappedList(x.unitIds, maps.units) })));
    await writeRows(Attribute, attributes.map((x) => ({ ...x, _id: maps.attributes.get(key(x._id)), businessId: business._id, unitIds: mappedList(x.unitIds, maps.units) })));
    await writeRows(Tax, taxes.map((x) => ({ ...x, _id: maps.taxes.get(key(x._id)), businessId: business._id })));
    await writeRows(Product, products.map((x) => ({ ...x, _id: maps.products.get(key(x._id)), businessId: business._id, sourceProductId: x._id, categoryIds: mappedList(x.categoryIds, maps.categories), baseUnitId: mapped(x.baseUnitId, maps.units), additionalUnits: (x.additionalUnits || []).map((u) => ({ ...u, unitId: mapped(u.unitId, maps.units) })).filter((u) => u.unitId), attributeIds: mappedList(x.attributeIds, maps.attributes), taxComponentIds: mappedList(x.taxComponentIds, maps.taxes) })));
    return { sourceBusinessTypeId: String(type._id), sourceBusinessTypeName: type.name, copiedAt: new Date(), businessTaxComponentIds: mappedList(type.taxComponentIds, maps.taxes), counts: { products: products.length, categories: selectedCategories.length, attributes: attributes.length, units: units.length, taxes: taxes.length } };
  } catch (cause) {
    const rollback = await Promise.allSettled([
      Product.deleteMany({ _id: { $in: ownedIds.products }, businessId: business._id }),
      Category.deleteMany({ _id: { $in: ownedIds.categories }, businessId: business._id }), Attribute.deleteMany({ _id: { $in: ownedIds.attributes }, businessId: business._id }),
      Unit.deleteMany({ _id: { $in: ownedIds.units }, businessId: business._id }), Tax.deleteMany({ _id: { $in: ownedIds.taxes }, businessId: business._id }),
    ]);
    if (rollback.some((result) => result.status === 'rejected')) throw Object.assign(new Error('Catalog copy failed and recovery was incomplete.'), { statusCode: 500, code: 'CATALOG_COPY_COMPENSATION_FAILED', cause });
    throw cause;
  }
}

async function copyBusinessTypeCatalog(business) {
  const lockId = crypto.randomUUID();
  const expiresAt = () => new Date(Date.now() + 10 * 60 * 1000);
  let acquired = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const lock = await BusinessMutationLock.findOneAndUpdate({ businessId: business._id, $or: [{ expiresAt: { $lte: new Date() } }, { lockId }] }, { $set: { businessId: business._id, lockId, expiresAt: expiresAt() } }, { upsert: true, new: true, setDefaultsOnInsert: true });
      if (lock?.lockId === lockId) { acquired = true; break; }
    } catch (error) { if (error.code !== 11000) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!acquired) throw Object.assign(new Error('Another business catalog operation is in progress.'), { statusCode: 409, code: 'BUSINESS_CATALOG_COPY_BUSY' });
  const renewal = setInterval(() => { BusinessMutationLock.updateOne({ businessId: business._id, lockId }, { $set: { expiresAt: expiresAt() } }).catch(() => {}); }, 60 * 1000);
  renewal.unref();
  try { return await copyCatalogUnlocked(business); }
  finally { clearInterval(renewal); await BusinessMutationLock.deleteOne({ businessId: business._id, lockId }); }
}

module.exports = { copyBusinessTypeCatalog };
