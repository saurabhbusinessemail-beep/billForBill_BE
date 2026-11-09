'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const units = require('../src/services/productUnits');
const Product = require('../src/DB/models/BusinessCatalogProduct');
const Pricing = require('../src/DB/models/BusinessProductPricing');
const Business = require('../src/DB/models/Business');
const Tax = require('../src/DB/models/BusinessCatalogTax');
const User = require('../src/DB/models/User');
function internals(file, names) {
  const filename = path.resolve(__dirname, '../src/services', file);
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(filename, 'utf8') + `\nmodule.exports.testInternals = { ${names} };`, filename);
  return mod.exports.testInternals;
}
const { normalizeDocument } = internals('businessDocuments.service.js', 'normalizeDocument');
const pid = '111111111111111111111111'; const bid = '222222222222222222222222';
const base = { key: 'base', name: 'Kilogram', symbol: 'kg', dimension: 'mass', factorToBase: '1' };
const pack = { key: 'pack', name: 'Five kg', symbol: '5kg', dimension: 'mass', conversionKind: 'product_specific', factorToBase: '5' };
const config = units.normalize({ baseUnit: base, units: [pack] });
const product = { _id: pid, businessId: bid, name: 'Rice', ...config };
const query = value => ({ lean: async () => value, select() { return this; } });
function setup(t, selected = product, price = { purchaseCost: '10', defaultSellingPrice: '10', rules: [], version: 1 }) {
  t.mock.method(Product, 'find', filter => { assert.equal(filter.businessId, bid); return query(selected ? [selected] : []); });
  t.mock.method(Pricing, 'findOne', filter => { assert.equal(filter.businessId, bid); return query(price); });
  t.mock.method(Business, 'findById', () => query({ businessTaxComponentIds: [] }));
  t.mock.method(Tax, 'find', () => query([]));
  t.mock.method(User, 'findOne', () => query({ _id: '333333333333333333333333' }));
}
function body(line = {}) { return { documentDate: '2026-11-08T00:00:00.000+05:30', createdAtClient: '2026-11-08T00:00:00.000+05:30', contact: { name: 'Test', countryCallingCode: '+91', phoneNumber: '9876543210' }, lines: [{ productId: pid, unitKey: 'pack', quantity: '2', unitPrice: '1', ...line }] }; }
test('document normalization rejects foreign unit keys and ignores forged factors/labels', async t => {
  setup(t);
  await assert.rejects(normalizeDocument(bid, 'u', body({ unitKey: 'foreign' }), 'purchase'), { code: 'INVALID_PRODUCT_UNIT' });
  const r = await normalizeDocument(bid, 'u', body({ factorToBase: '999', conversionFactor: '999', unitLabel: 'Forged' }), 'purchase');
  assert.equal(r.lines[0].factorToBase, '5'); assert.equal(r.lines[0].unitLabel, 'Five kg');
  assert.equal(r.lines[0].baseQuantity, '10'); assert.equal(r.lines[0].unitPrice, '50'); assert.equal(r.grandTotal.toString(), '100.00');
  assert.equal(r.lines[0].unitId, undefined);
});
test('pricing tiers use base quantity and selected-unit prices scale from base', async t => {
  setup(t, product, { defaultSellingPrice: '10', version: 2, rules: [{ active: true, minimumQuantity: 10, sellingPrice: '8' }] });
  const r = await normalizeDocument(bid, 'u', body(), 'sales');
  assert.equal(r.lines[0].sourcePrice, '8'); assert.equal(r.lines[0].unitPrice, '40'); assert.equal(r.grandTotal.toString(), '80.00');
});
test('unchanged saved line retains removed unit and price snapshots', async t => {
  setup(t, { ...product, ...units.normalize({ baseUnit: base }) });
  const saved = { lineId: 'old', productId: pid, unitKey: 'removed', quantity: '2', unitPrice: '75', factorToBase: '5', unitLabel: 'Old pack', sourcePrice: '15', manualOverride: false, priceOrigin: 'master', baseQuantity: '10' };
  const old = { ...body(), lines: [saved], contactSnapshot: { name: 'Test' }, createdAtClient: body().createdAtClient };
  const r = await normalizeDocument(bid, 'u', body(saved), 'purchase', old);
  assert.equal(r.lines[0].factorToBase, '5'); assert.equal(r.lines[0].unitLabel, 'Old pack'); assert.equal(r.lines[0].unitPrice, '75');
});
test('stale configurations, cross-business products and unrepresentable conversions fail', async t => {
  setup(t);
  await assert.rejects(normalizeDocument(bid, 'u', body({ unitConfigRevision: 'stale' }), 'purchase'), { code: 'PRODUCT_UNIT_CONFIG_STALE' });
  t.mock.method(Product, 'find', () => query([]));
  await assert.rejects(normalizeDocument(bid, 'u', body(), 'purchase'), { code: 'INVALID_PRODUCT' });
});
test('stock line conversion uses saved factor after alternate unit edits/removal', () => {
  const { lineUnit } = internals('businessInventory.service.js', 'lineUnit');
  const selected = lineUnit({ unitKey: 'removed', factorToBase: '5', unitLabel: 'Old pack', unitSymbol: 'pack' }, product, []);
  assert.equal(selected.factor, '5'); assert.equal(units.multiply('2', selected.factor, 4), '10');
  assert.throws(() => lineUnit({ unitKey: 'removed', factorToBase: '0' }, product, []));
  assert.throws(() => lineUnit({ baseUnitKey: 'base', baseUnitSymbol: 'L', baseUnitName: 'Litre', factorToBase: '1' }, product, []), { code: 'PRODUCT_UNIT_CONFIG_STALE' });
});
test('bill stock posting is idempotent and compensation restores the original base quantity', async t => {
  const Movement = require('../src/DB/models/BusinessInventoryMovement');
  const Lock = require('../src/DB/models/BusinessInventoryLock');
  const rows = [];
  t.mock.method(Product, 'findOne', filter => { assert.equal(filter.businessId, bid); return query({ ...product, ...units.normalize({ baseUnit: base }) }); });
  t.mock.method(Lock, 'findOneAndUpdate', async (filter, change) => ({ lockId: change.$set.lockId }));
  t.mock.method(Lock, 'deleteOne', async () => ({}));
  t.mock.method(Movement, 'exists', async filter => rows.some(row => row.sourceEventKey === filter.sourceEventKey));
  t.mock.method(Movement, 'aggregate', async () => [{ _id: pid, quantity: '100' }]);
  t.mock.method(Movement, 'findOne', () => ({ sort() { return this; }, lean: async () => rows.find(row => row.source === 'bill') }));
  t.mock.method(Movement, 'create', async row => { const value = { ...row, _id: String(rows.length + 1) }; rows.push(value); return value; });
  const { recordBillMovement } = require('../src/services/businessInventory.service');
  const bill = { _id: '444444444444444444444444', billNumber: 'TEST', billDate: '2026-11-08' };
  const line = { productId: pid, lineId: 'old-line', unitKey: 'removed', factorToBase: '5', quantity: '2', unitLabel: 'Old five kg pack', unitSymbol: 'pack' };
  await recordBillMovement(bid, 'u', bill, line, 'out', 'event');
  assert.equal(rows[0].stockQuantity.toString(), '10'); assert.equal(rows[0].unitId, undefined); assert.equal(rows[0].stockUnitId, undefined);
  assert.deepEqual(await recordBillMovement(bid, 'u', bill, line, 'out', 'event'), { duplicate: true });
  await recordBillMovement(bid, 'u', bill, { ...line, factorToBase: '999', quantity: '999' }, 'in', 'event:rollback', true);
  assert.equal(rows.length, 2); assert.equal(rows[1].stockQuantity.toString(), '10');
  assert.equal(rows[1].factorToBase, '5');
});
test('base edits conflict after movement history and business catalog permissions remain enforced', async t => {
  const connection = require('../src/DB/connection');
  const Movement = require('../src/DB/models/BusinessInventoryMovement');
  const inventory = require('../src/services/businessInventory.service');
  t.mock.method(connection, 'assertDatabaseConnected', () => {});
  t.mock.method(inventory, 'withProductLock', async (b, p, work) => work());
  t.mock.method(Product, 'findOne', async () => new Product({ ...product, name: 'Rice', normalizedName: 'rice', type: 'Physical' }));
  t.mock.method(Movement, 'exists', async () => true);
  const { update } = internals('adminSetup/catalogCommon.service.js', 'update');
  await assert.rejects(update('products', pid, { baseUnit: { ...base, name: 'New meaning' } }, bid), { code: 'PRODUCT_BASE_UNIT_IN_USE' });
  const people = require('../src/services/businessPeopleTeams.service');
  t.mock.method(people, 'access', async (b, u, permission) => { assert.equal(b, bid); assert.equal(permission, 'business.catalog.products.manage'); throw Object.assign(new Error('Denied'), { code: 'PERMISSION_DENIED' }); });
  const service = internals('businessCatalog.service.js', 'createProduct');
  await assert.rejects(service.createProduct(bid, 'member', { name: 'Rice', ...config }), { code: 'PERMISSION_DENIED' });
});
test('complete business catalog copy preserves embedded metadata and creates no product-only unit rows', async t => {
  const source = { ...product, businessId: null, ...require('./legacyPackFixture').parseOffQuantity({ quantity: '6 x 250 ml, 12 x 250 ml' }) };
  const SourceProduct = require('../src/DB/models/CatalogProduct');
  const SourceUnit = require('../src/DB/models/CatalogUnit');
  const BusinessType = require('../src/DB/models/BusinessType');
  t.mock.method(SourceProduct, 'find', () => query([source]));
  t.mock.method(BusinessType, 'findOne', () => query({ _id: '555555555555555555555555', productIds: [pid], name: 'Shop' }));
  for (const name of ['ProductCategory', 'ProductAttribute', 'TaxComponent']) t.mock.method(require('../src/DB/models/' + name), 'find', () => query([]));
  t.mock.method(SourceUnit, 'find', filter => { assert.deepEqual(filter._id.$in, []); return query([]); });
  t.mock.method(require('../src/DB/models/ProductImage'), 'find', () => query([{ productId: pid }]));
  let copied;
  t.mock.method(Product, 'bulkWrite', async operations => { copied = operations.map(op => new Product(op.replaceOne.replacement).toObject()); });
  t.mock.method(Product, 'find', () => query(copied));
  t.mock.method(require('../src/DB/models/BusinessCatalogUnit'), 'bulkWrite', () => { throw new Error('Product units must not create generic rows'); });
  const { copyCatalogUnlocked } = internals('businessCatalogCopy.service.js', 'copyCatalogUnlocked');
  const result = await copyCatalogUnlocked({ _id: bid, businessTypeId: '555555555555555555555555' });
  assert.equal(result.counts.products, 1); assert.equal(result.counts.units, 0);
  assert.deepEqual(units.dto(source), units.dto(copied[0]));
  assert.equal(copied[0].baseUnitId, undefined); assert.equal(copied[0].additionalUnits, undefined);
});
test('migration dry-run is read-only and apply retries leave migrated products unchanged', async t => {
  const SourceProduct = require('../src/DB/models/CatalogProduct');
  const SourceUnit = require('../src/DB/models/CatalogUnit');
  const stored = { _id: pid, businessId: null, baseUnitId: 'a', additionalUnits: [], baseUnit: null };
  const cursor = values => ({ lean() { return this; }, cursor: async function* () { yield* values; } });
  t.mock.method(SourceProduct, 'find', () => cursor([stored]));
  t.mock.method(Product, 'find', () => cursor([]));
  t.mock.method(SourceUnit, 'find', () => query([{ _id: 'a', name: 'Kilogram', symbol: 'kg', dimension: 'mass' }]));
  let writes = 0;
  t.mock.method(SourceProduct, 'updateOne', async (filter, change) => { writes++; Object.assign(stored, change.$set); });
  const { migrate } = require('../src/migrations/productEmbeddedUnits');
  assert.equal((await migrate()).migrated, 1); assert.equal(writes, 0);
  assert.equal((await migrate({ dryRun: false })).migrated, 1); assert.equal(writes, 1);
  assert.equal((await migrate({ dryRun: false })).unchanged, 1); assert.equal(writes, 1);
  assert.equal(stored.baseUnitId, 'a');
});

test('OFF pack pricing and stock quantities stay per pack rather than per gram', async t => {
  const parsed=require('./legacyPackFixture').parseOffQuantity({quantity:'123 g',product_quantity:123,product_quantity_unit:'g'});
  setup(t,{_id:pid,businessId:bid,name:'Pack fixture',...parsed});
  const result=await normalizeDocument(bid,'u',body({unitKey:'base',quantity:'3'}),'sales');
  assert.equal(result.lines[0].baseQuantity,'3');
  assert.equal(result.lines[0].factorToBase,'1');
  assert.equal(result.lines[0].baseUnitSymbol,'pack');
  assert.equal(result.lines[0].unitPrice,'10');
  assert.equal(result.grandTotal.toString(),'30.00');
});
