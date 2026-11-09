'use strict';

const Product = require('../DB/models/CatalogProduct');
const BusinessProduct = require('../DB/models/BusinessCatalogProduct');
const BusinessType = require('../DB/models/BusinessType');
const productUnits = require('../services/productUnits');
const { canonicalProductType, prepareVariantIdentifiers } = require('../services/adminSetup/catalogCommon.service');

const retiredFields = {
  externalSource: '', externalProductId: '', externalProductUrl: '',
  externalUpdatedAt: '', lastSyncedAt: '', pendingAttributes: '',
};

async function migrate({ dryRun = true } = {}) {
  const summary = { dryRun, productTypesUpdated: 0, ambiguousTypes: Object.create(null), legacyUnitsRemoved: 0, variationUnitsBackfilled: 0, legacyUnitsNeedingRepair: 0, retiredProductMetadata: 0, retiredBusinessTypeMetadata: 0, concurrentUpdatesSkipped: 0, variantMetadataBackfilled: 0, identifierConflicts: [] };
  const seen = new Map();
  for (const Model of [Product, BusinessProduct]) {
    for await (const product of Model.find().lean().cursor()) {
      try {
        const variations = productUnits.variations(product);
        for (const key of prepareVariantIdentifiers(variations)) {
          const scopeKey = `${product.businessId || 'shared'}:${key}`;
          if (seen.has(scopeKey)) summary.identifierConflicts.push({ productId: String(product._id), otherProductId: seen.get(scopeKey), code: 'PRODUCT_GTIN_EXISTS' });
          else seen.set(scopeKey, String(product._id));
        }
      } catch (error) { summary.identifierConflicts.push({ productId: String(product._id), code: error.code || 'INVALID_PRODUCT_VARIANTS' }); }
    }
  }
  if (summary.identifierConflicts.length) return { ...summary, applied: false };
  if (!dryRun) await Promise.all([Product.createIndexes(), BusinessProduct.createIndexes()]);
  for (const Model of [Product, BusinessProduct]) {
    for await (const product of Model.find().select('+variantIdentifierKeys').lean().cursor()) {
      const $set = {};
      const $unset = {};
      if (!product.title) $set.title = product.name;
      const brand = productUnits.productBrand(product);
      if (brand !== product.brand) $set.brand = brand;
      if (Object.hasOwn(product, 'variants')) $unset.variants = '';
      if (Object.hasOwn(product, 'elid')) $unset.elid = '';
      const type = canonicalProductType(product.type);
      if (type && type !== product.type) { $set.type = type; summary.productTypesUpdated++; }
      if (!type) {
        const key = String(product.type ?? '(missing)');
        summary.ambiguousTypes[key] = (summary.ambiguousTypes[key] || 0) + 1;
      }
      if (Object.keys(retiredFields).some(key => Object.hasOwn(product, key))) {
        Object.assign($unset, retiredFields);
        summary.retiredProductMetadata++;
      }
      const legacyUnitFields = ['baseUnit', 'units', 'quantityVariants', 'needsUnit', 'baseUnitId', 'additionalUnits'];
      const legacyKey = productUnits.legacyVariantKey(product);
      const variations = productUnits.variations(product);
      const keys = prepareVariantIdentifiers(variations);
      const legacyMetadata = productUnits.variationMetadataFields.filter(field => Object.hasOwn(product, field));
      const needsMetadata = legacyMetadata.length || Object.hasOwn(product, 'variants') || variations.length !== product.variations?.length
        || JSON.stringify(keys) !== JSON.stringify(product.variantIdentifierKeys || []);
      let moveUnits = false;
      if (legacyUnitFields.some(key => Object.hasOwn(product, key)) || !product.variations?.length || !product.variations.every(variant => variant.baseUnit)) {
        if (variations.every(variant => variant.baseUnit)) {
          moveUnits = true;
          Object.assign($unset, Object.fromEntries(legacyUnitFields.map(key => [key, ''])));
          if (Model === BusinessProduct) $unset.reorderLevel = '';
          summary.variationUnitsBackfilled++;
          summary.legacyUnitsRemoved++;
        } else summary.legacyUnitsNeedingRepair++;
      }
      if (needsMetadata || moveUnits) {
        const cast = new Model({ variations: variations.map(variant => ({
          ...variant,
          needsUnit: variant.baseUnit ? variant.needsUnit : undefined,
          reorderLevel: variant.key === legacyKey ? variant.reorderLevel ?? product.reorderLevel : variant.reorderLevel,
        })) });
        $set.variations = cast.toObject({ flattenMaps: true }).variations;
        $set.legacyStockVariantKey = legacyKey;
        $set.variantIdentifierKeys = keys;
        for (const field of legacyMetadata) $unset[field] = '';
        if (needsMetadata) summary.variantMetadataBackfilled++;
      }
      if (!dryRun && (Object.keys($set).length || Object.keys($unset).length)) {
        const result = await Model.collection.updateOne({ _id: product._id, updatedAt: product.updatedAt }, {
          ...(Object.keys($set).length ? { $set } : {}),
          ...(Object.keys($unset).length ? { $unset } : {}),
        });
        if (!result.matchedCount) summary.concurrentUpdatesSkipped++;
      }
    }
  }
  const typeFilter = { openFoodFactsConfig: { $exists: true } };
  summary.retiredBusinessTypeMetadata = await BusinessType.collection.countDocuments(typeFilter);
  if (!dryRun) await BusinessType.collection.updateMany(typeFilter, { $unset: { openFoodFactsConfig: '' } });
  return summary;
}

if (require.main === module) {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const dryRun = !process.argv.includes('--apply');
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => migrate({ dryRun }))
    .then(summary => {
      console.log(JSON.stringify(summary));
      if (!dryRun && (summary.identifierConflicts.length || summary.concurrentUpdatesSkipped)) process.exitCode = 1;
    })
    .catch(error => { console.error(error.code || error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}

module.exports = { migrate };
