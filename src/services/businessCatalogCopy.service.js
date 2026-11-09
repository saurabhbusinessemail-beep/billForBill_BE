'use strict';

const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const BusinessMutationLock = require('../DB/models/BusinessMutationLock');
const SourceProduct = require('../DB/models/CatalogProduct');
const SourceCategory = require('../DB/models/ProductCategory');
const SourceAttribute = require('../DB/models/ProductAttribute');
const SourceUnit = require('../DB/models/CatalogUnit');
const SourceTax = require('../DB/models/TaxComponent');
const Product = require('../DB/models/BusinessCatalogProduct');
const Pricing = require('../DB/models/BusinessProductPricing');
const Category = require('../DB/models/BusinessCatalogCategory');
const Attribute = require('../DB/models/BusinessCatalogAttribute');
const Unit = require('../DB/models/BusinessCatalogUnit');
const Tax = require('../DB/models/BusinessCatalogTax');
const BusinessType = require('../DB/models/BusinessType');
const Business = require('../DB/models/Business');

const productUnits = require('./productUnits');
const key = (value) => String(value);
const ids = (list) => [...new Set((list || []).filter(Boolean).map(key))];
function mapped(value, map) { return value ? map.get(key(value)) || null : null; }
function mappedList(list, map) { return (list || []).map((value) => mapped(value, map)).filter(Boolean); }
function stableId(businessId, kind, sourceId) { return new mongoose.Types.ObjectId(crypto.createHash('sha256').update(`${businessId}:${kind}:${sourceId}`).digest('hex').slice(0, 24)); }

function mrpSellingPrices(variations) {
  return variations.filter(variation => variation.mrp != null && /^\d{1,12}(?:\.\d{1,4})?$/.test(String(variation.mrp)))
    .map(variation => ({ variantKey: variation.key, basis: 'fixed', sellingPrice: variation.mrp }));
}

async function seedCopiedProductPricing(business, productId) {
  const filter = { _id: productId, businessId: business._id, mrpPricingPending: true };
  const product = await Product.findOne(filter).lean();
  if (!product) return;
  const variantPrices = mrpSellingPrices(productUnits.variations(product));
  if (variantPrices.length) {
    const pricingFilter = { businessId: business._id, productId };
    const now = new Date();
    try {
      await Pricing.updateOne(pricingFilter, { $setOnInsert: {
        variantPrices,
        createdByUserId: business.ownerUserId,
        updatedByUserId: business.ownerUserId,
        createdAt: now,
        updatedAt: now,
      } }, { upsert: true, timestamps: false, runValidators: true });
    } catch (error) {
      if (error.code !== 11000 || !await Pricing.exists(pricingFilter)) {
        error.catalogModel = Pricing.modelName;
        throw error;
      }
    }
  }
  await Product.updateOne(filter, { $unset: { mrpPricingPending: '' } }, { timestamps: false });
}

async function syncBusinessTax(businessId, source, insertId) {
  const filter = { businessId, normalizedName: source.normalizedName };
  const fields = {
    name: source.name,
    calculationType: source.calculationType,
    value: source.value,
    currency: source.currency ?? '',
    effectiveStart: source.effectiveStart,
    effectiveEnd: source.effectiveEnd ?? null,
    jurisdiction: source.jurisdiction ?? '',
    description: source.description ?? '',
  };
  const options = { new: true, runValidators: true };
  try {
    try {
      return await Tax.findOneAndUpdate(filter, { $set: fields, $setOnInsert: { _id: insertId } }, { ...options, upsert: true }).select('_id').lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      // A concurrent insert may have claimed the same business and tax name.
      const existing = await Tax.findOneAndUpdate(filter, { $set: fields }, options).select('_id').lean();
      if (!existing) throw error;
      return existing;
    }
  } catch (error) {
    error.catalogModel = Tax.modelName;
    throw error;
  }
}

async function copyCatalogUnlocked(business, options = {}) {
  const type = await BusinessType.findOne({ _id: business.businessTypeId, businessId: null }).lean();
  if (!type) throw Object.assign(new Error('Choose an available business type.'), { statusCode: 400, code: 'BUSINESS_TYPE_NOT_FOUND' });
  const requestedIds = options.productIds ? (type.productIds || []).filter(id => options.productIds.map(String).includes(String(id))) : type.productIds || [];
  let products = await SourceProduct.find({ _id: { $in: requestedIds }, businessId: null }).lean();
  if (products.length !== requestedIds.length) throw Object.assign(new Error('The selected business type references missing products.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  if (options.additionsOnly) {
    const existing = await Product.find({ businessId: business._id, sourceProductId: { $in: requestedIds } }).select('sourceProductId +mrpPricingPending').lean();
    for (const product of existing) {
      if (product.mrpPricingPending) await seedCopiedProductPricing(business, product._id);
    }
    const copied = new Set(existing.map(p => String(p.sourceProductId)));
    products = products.filter(p => !copied.has(String(p._id)));
    if (!products.length && !type.taxComponentIds?.length) return;
  }
  const taxIds = ids([...(type.taxComponentIds || []), ...products.flatMap((p) => p.taxComponentIds || [])]);
  const taxes = await SourceTax.find({ _id: { $in: taxIds }, businessId: null }).lean();
  if (taxes.length !== taxIds.length) throw Object.assign(new Error('The selected business type references missing tax components.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  const productCategoryIds = ids(products.flatMap((p) => p.categoryIds || []));
  const categories = productCategoryIds.length ? await SourceCategory.find({ businessId: null }).lean() : [];
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
  const attributes = attributeIds.length ? await SourceAttribute.find({ _id: { $in: attributeIds }, businessId: null }).lean() : [];
  if (attributes.length !== attributeIds.length) throw Object.assign(new Error('A product references a missing attribute.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  const unitIds = ids([
    ...selectedCategories.flatMap((c) => c.unitIds || []), ...attributes.flatMap((a) => a.unitIds || []),
  ]);
  const units = unitIds.length ? await SourceUnit.find({ _id: { $in: unitIds }, businessId: null }).lean() : [];
  if (units.length !== unitIds.length) throw Object.assign(new Error('The catalog references a missing unit.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  if (products.some(product => !product.baseUnit && !product.needsUnit
    && !((product.variations || product.variants)?.some(variant => variant.baseUnit || variant.needsUnit)))) {
    throw Object.assign(new Error('A product is missing its required base unit.'), { statusCode: 409, code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE' });
  }
  const maps = Object.fromEntries(['products', 'categories', 'attributes', 'units', 'taxes'].map((name) => [name, new Map()]));
  for (const [name, rows] of Object.entries({ products, categories: selectedCategories, attributes, units, taxes })) for (const row of rows) maps[name].set(key(row._id), stableId(business._id, name, row._id));
  const ownedIds = { products: [...maps.products.values()], categories: [...maps.categories.values()], attributes: [...maps.attributes.values()], units: [...maps.units.values()], taxes: [...maps.taxes.values()] };
  const writeRows = async (Model, rows) => {
    if (!rows.length) return;
    try {
      await Model.bulkWrite(rows.map(row => options.additionsOnly
        ? { updateOne: { filter: { _id: row._id, businessId: business._id }, update: { $setOnInsert: row }, upsert: true, timestamps: false } }
        : { replaceOne: { filter: { _id: row._id, businessId: business._id }, replacement: row, upsert: true } }), { ordered: true });
    } catch (error) {
      error.catalogModel = Model.modelName;
      throw error;
    }
  };
  try {
    await writeRows(Unit, units.map((x) => ({ ...x, _id: maps.units.get(key(x._id)), businessId: business._id })));
    await writeRows(Category, selectedCategories.map((x) => ({ ...x, _id: maps.categories.get(key(x._id)), businessId: business._id, parentId: mapped(x.parentId, maps.categories), unitIds: mappedList(x.unitIds, maps.units) })));
    await writeRows(Attribute, attributes.map((x) => ({ ...x, _id: maps.attributes.get(key(x._id)), businessId: business._id, unitIds: mappedList(x.unitIds, maps.units) })));
    if (options.additionsOnly) {
      for (const tax of taxes) {
        const sourceId = key(tax._id);
        const saved = await syncBusinessTax(business._id, tax, maps.taxes.get(sourceId));
        maps.taxes.set(sourceId, saved._id);
      }
      const businessTaxComponentIds = mappedList(type.taxComponentIds, maps.taxes);
      if (businessTaxComponentIds.length) {
        await Business.updateOne({ _id: business._id, businessTypeId: type._id }, {
          $addToSet: { businessTaxComponentIds: { $each: businessTaxComponentIds } },
        });
      }
      if (!products.length) return;
    } else {
      await writeRows(Tax, taxes.map(x => ({ ...x, _id: maps.taxes.get(key(x._id)), businessId: business._id })));
    }
    const variantConfig = product => {
      const variations = productUnits.variations(product);
      const variantIdentifierKeys = require('./adminSetup/catalogCommon.service').prepareVariantIdentifiers(variations);
      return { variations, variantIdentifierKeys };
    };
    const retiredMetadata = Object.fromEntries(productUnits.variationMetadataFields.map(field => [field, undefined]));
    const productRows = products.map(x => {
      const config = variantConfig(x);
      return {
        ...x,
        ...retiredMetadata,
        ...config,
        _id: maps.products.get(key(x._id)),
        businessId: business._id,
        sourceProductId: x._id,
        title: x.title || x.name,
        brand: productUnits.productBrand(x),
        categoryIds: mappedList(x.categoryIds, maps.categories),
        attributeIds: mappedList(x.attributeIds, maps.attributes),
        taxComponentIds: mappedList(x.taxComponentIds, maps.taxes),
        legacyStockVariantKey: productUnits.legacyVariantKey(x),
        variants: undefined,
        elid: undefined,
        baseUnit: undefined,
        units: undefined,
        quantityVariants: undefined,
        needsUnit: undefined,
        baseUnitId: undefined,
        additionalUnits: undefined,
        ...(options.additionsOnly && mrpSellingPrices(config.variations).length ? { mrpPricingPending: true } : {}),
      };
    });
    await writeRows(Product, productRows);
    const copiedProducts = await Product.find({ businessId: business._id, _id: { $in: ownedIds.products } }).lean();
    for (const source of products) {
      const target = copiedProducts.find(p => String(p.sourceProductId) === String(source._id));
      const comparable = product => JSON.parse(JSON.stringify(variantConfig(product)));
      if (!target || !isDeepStrictEqual(comparable(source), comparable(target))) throw Object.assign(new Error('Product variation copy verification failed.'), { code: 'BUSINESS_TYPE_CATALOG_INCOMPLETE', statusCode: 409 });
    }
    for (const row of productRows) {
      if (row.mrpPricingPending) await seedCopiedProductPricing(business, row._id);
    }
    return { sourceBusinessTypeId: String(type._id), sourceBusinessTypeName: type.name, copiedAt: new Date(), businessTaxComponentIds: mappedList(type.taxComponentIds, maps.taxes), counts: { products: products.length, categories: selectedCategories.length, attributes: attributes.length, units: units.length, taxes: taxes.length } };
  } catch (cause) {
    // Propagation retains partial progress for a safe retry.
    if (options.additionsOnly) throw cause;
    const rollback = await Promise.allSettled([
      Product.deleteMany({ _id: { $in: ownedIds.products }, businessId: business._id }),
      Category.deleteMany({ _id: { $in: ownedIds.categories }, businessId: business._id }), Attribute.deleteMany({ _id: { $in: ownedIds.attributes }, businessId: business._id }),
      Unit.deleteMany({ _id: { $in: ownedIds.units }, businessId: business._id }), Tax.deleteMany({ _id: { $in: ownedIds.taxes }, businessId: business._id }),
    ]);
    if (rollback.some((result) => result.status === 'rejected')) throw Object.assign(new Error('Catalog copy failed and recovery was incomplete.'), { statusCode: 500, code: 'CATALOG_COPY_COMPENSATION_FAILED', cause });
    throw cause;
  }
}

async function copyBusinessTypeCatalog(business, options = {}) {
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
  try { return await copyCatalogUnlocked(business, options); }
  finally { clearInterval(renewal); await BusinessMutationLock.deleteOne({ businessId: business._id, lockId }); }
}

async function pushBusinessTypeProducts(typeId, productIds) {
  let firstFailure;
  let firstDetails;
  for await (const business of Business.find({ businessTypeId: typeId }).lean().cursor()) {
    try { await copyBusinessTypeCatalog(business, { additionsOnly: true, productIds }); }
    catch (cause) {
      const writeError = cause.writeErrors?.[0];
      const index = /\bindex: ([\w.-]+) dup key\b/.exec(writeError?.errmsg || cause.message || '')?.[1];
      const details = {
        businessId: String(business._id),
        causeCode: cause.code || cause.name || 'UNKNOWN_ERROR',
        ...(cause.catalogModel ? { catalogModel: cause.catalogModel } : {}),
        ...(index ? { index } : {}),
        ...(cause.statusCode >= 400 && cause.statusCode < 500 ? { reason: cause.message } : {}),
      };
      console.error('[catalog copy] Business Type product push failed:', { businessTypeId: String(typeId), ...details });
      firstFailure ||= cause;
      firstDetails ||= details;
    }
  }
  if (firstFailure) throw Object.assign(new Error('Some business catalogs could not be updated. Retry the product addition to complete synchronization.'), { statusCode: 409, code: 'BUSINESS_CATALOG_PUSH_INCOMPLETE', details: firstDetails, cause: firstFailure });
}

module.exports = { copyBusinessTypeCatalog, pushBusinessTypeProducts };
