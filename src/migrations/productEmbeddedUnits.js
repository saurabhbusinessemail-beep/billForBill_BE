'use strict';
const productUnits = require('../services/productUnits');

function fromLegacy(product, unitRows) {
  const byId = new Map(unitRows.map(u => [String(u._id), u]));
  const base = byId.get(String(product.baseUnitId));
  if (!base) throw productUnits.fail('PRODUCT_UNIT_MIGRATION_REQUIRED', 'The legacy base unit is missing.');
  const baseUnit = { key: `legacy_${base._id}`, name: base.name, symbol: base.symbol, dimension: base.dimension, factorToBase: '1' };
  const units = (product.additionalUnits || []).map(entry => {
    const unit = byId.get(String(entry.unitId));
    if (!unit) throw productUnits.fail('PRODUCT_UNIT_MIGRATION_REQUIRED', 'A legacy alternate unit is missing.');
    return { key: `legacy_${unit._id}`, name: unit.name, symbol: unit.symbol, dimension: unit.dimension, factorToBase: String(entry.conversionFactor), conversionKind: 'standard' };
  });
  return productUnits.normalize({ baseUnit, units });
}
async function migrate({ dryRun = true } = {}) {
  const summary = { migrated: 0, repair: 0, unchanged: 0, dryRun };
  for (const [Product, Unit] of [
    [require('../DB/models/CatalogProduct'), require('../DB/models/CatalogUnit')],
    [require('../DB/models/BusinessCatalogProduct'), require('../DB/models/BusinessCatalogUnit')],
  ]) {
    for await (const product of Product.find({}).lean().cursor()) {
      if (product.baseUnit || ((product.variations || product.variants)?.length && (product.variations || product.variants).every(variant => variant.baseUnit))) { summary.unchanged++; continue; }
      const ids = [product.baseUnitId, ...(product.additionalUnits || []).map(u => u.unitId)].filter(Boolean);
      const rows = await Unit.find({ businessId: product.businessId || null, _id: { $in: ids } }).lean();
      let config;
      try { config = fromLegacy(product, rows); summary.migrated++; }
      catch { config = { needsUnit: true }; summary.repair++; }
      if (!dryRun) await Product.updateOne({ _id: product._id, baseUnit: null }, { $set: config });
    }
  }
  return summary;
}
if (require.main === module) {
  require('dotenv').config();
  const mongoose = require('mongoose');
  mongoose.connect(process.env.MONGODB_URI).then(() => migrate({ dryRun: !process.argv.includes('--apply') })).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.code || error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
}
module.exports = { migrate, fromLegacy };
