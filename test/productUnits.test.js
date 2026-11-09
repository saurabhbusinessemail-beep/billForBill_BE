'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const units = require('../src/services/productUnits');
const { parseOffQuantity: parse } = require('./legacyPackFixture');
const { fromLegacy } = require('../src/migrations/productEmbeddedUnits');
const base = { key: 'base', name: 'Kilogram', symbol: 'kg', dimension: 'mass', factorToBase: '1' };
test('OFF package alternatives keep pack stock units and exact content', () => {
  const result = parse({ quantity: '5kg, 10 kg, 20 kg, 25 kg' });
  assert.equal(result.baseUnit.symbol, 'pack');
  assert.deepEqual(result.quantityVariants.map(v => v.amountInBase), ['1', '2', '4', '5']);
  assert.equal(result.quantityVariants[0].sourceText, '5kg');
  assert.deepEqual(result.quantityVariants.map(v => v.contentQuantity), ['5', '10', '20', '25']);
  assert.ok(result.quantityVariants.every(v => v.contentUnit === 'kg'));
  assert.ok(result.units.every(u => u.symbol === 'pack'));
  assert.equal(units.multiply('3', result.baseUnit.factorToBase), '3');
});
test('multipacks preserve count/content and derive only explicit piece conversions', () => {
  const r = parse({ quantity: '6 x 250 ml, 12 x 250 ml' });
  assert.deepEqual(r.quantityVariants.map(v => v.amountInBase), ['1', '2']);
  assert.equal(r.quantityVariants[0].packageCount, 6);
  assert.equal(r.quantityVariants[0].amountPerPiece, '250');
  assert.equal(r.quantityVariants[0].contentQuantity, '1500');
  assert.equal(r.units.filter(u => u.dimension === 'count').length, 0);
  assert.ok(r.warnings.some(w => w.reason === 'unsupported_precision'));
  const exact = parse({ quantity: '4 x 250 ml' });
  assert.equal(exact.units.find(u => u.symbol === 'pc').factorToBase, '0.25');
  assert.equal(parse({ quantity: '250 ml' }).units.some(u => u.symbol === 'pc'), false);
});
test('normalized whole-product values deduplicate after metric conversion', () => {
  const r = parse({ quantity: '1 kg', product_quantity: 1000, product_quantity_unit: 'g' });
  assert.equal(r.quantityVariants.length, 1); assert.equal(r.duplicateVariants, 1);
  assert.equal(parse({ quantity: '6 x 250 ml', product_quantity: 1500, product_quantity_unit: 'ml' }).quantityVariants.length, 1);
  const fallback = parse({ product_quantity: 250, product_quantity_unit: 'ml' });
  assert.equal(fallback.baseUnit.symbol, 'pack'); assert.equal(fallback.quantityVariants[0].contentQuantity, '250'); assert.equal(fallback.quantityVariants.length, 1);
});
test('ambiguous strings are not guessed and incompatible dimensions are reported', () => {
  for (const quantity of ['1,000 g', '5kg, malformed', 'unknown', '0 kg', '-1 kg']) {
    const r = parse({ quantity }); assert.equal(r.needsUnit, true); assert.ok(r.warnings.length);
  }
  const r = parse({ quantity: '1 kg, 1 L', product_quantity: 500, product_quantity_unit: 'ml' });
  assert.equal(r.quantityVariants.length, 1); assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.every(w => w.reason === 'incompatible_dimension'));
  assert.equal(parse({}).needsUnit, true);
});
test('equivalent simple sizes deduplicate; distinct explicit package meanings survive', () => {
  assert.equal(parse({ quantity: '1 kg, 1000 g' }).quantityVariants.length, 1);
  assert.equal(parse({ quantity: '6 x 250 ml, 3 x 500 ml' }).quantityVariants.length, 2);
});
test('inactive packages are excluded even if their linked unit remains active', () => {
  const config = parse({ quantity: '5 kg, 10 kg' });
  config.quantityVariants[0].active = false;
  assert.equal(units.options(config).some(u => u.key === 'base'), true);
  assert.equal(units.options(config).some(u => u.key === 'size_2'), true);
  assert.equal(units.dto(config).quantityVariants[0].active, false);
});
test('factors reject malformed values, zero, overflow and precision loss', () => {
  for (const v of ['0', '-1', 'NaN', 'Infinity', '1e3', '0.000000001', '10000000001']) assert.throws(() => units.fixed(v));
  assert.equal(units.multiply('6', '0.25', 4), '1.5');
  assert.throws(() => units.multiply('0.0001', '0.0001', 4), { code: 'INVALID_CONVERSION' });
  assert.throws(() => units.multiply('10000000000', '2'), { code: 'INVALID_CONVERSION' });
  assert.equal(units.text(units.fixed(require('mongoose').Types.Decimal128.fromString('0.00000001'))), '0.00000001');
});
test('canonical metric conversions, unique keys and variant links are validated', () => {
  const gram = { key: 'g', name: 'Gram', symbol: 'g', dimension: 'mass', factorToBase: '0.001' };
  assert.equal(units.normalize({ baseUnit: base, units: [gram] }).units.length, 2);
  assert.throws(() => units.normalize({ baseUnit: base, units: [{ ...gram, factorToBase: '1000' }] }));
  assert.throws(() => units.normalize({ baseUnit: base, units: [gram, gram] }));
  assert.throws(() => units.normalize({ baseUnit: base, quantityVariants: [{ key: 'v', label: 'Pack', unitKey: 'missing', amountInBase: '5' }] }));
  assert.throws(() => units.normalize({ baseUnit: base, units: [{ ...gram, dimension: 'volume', symbol: 'ml', conversionKind: 'product_specific' }] }));
});
test('Mongoose embedded config survives casting and copies without ObjectId unit references', async () => {
  const Product = require('../src/DB/models/BusinessCatalogProduct');
  const config = parse({ quantity: '6 x 250 ml' });
  const source = new Product({ businessId: '111111111111111111111111', name: 'Test', normalizedName: 'test', type: 'Physical', ...config });
  await source.validate();
  const copy = new Product({ businessId: '222222222222222222222222', name: 'Copy', normalizedName: 'copy', type: 'Physical', ...units.dto(source) });
  await copy.validate(); assert.deepEqual(units.dto(source), units.dto(copy));
  assert.equal(copy.baseUnitId, undefined); assert.equal(copy.additionalUnits, undefined);
  assert.equal(copy.baseUnit.factorToBase.toString(), '1');
});
test('legacy migration preserves factors/identity and rejects missing or inconsistent references', () => {
  const rows = [{ _id: 'a', name: 'Kilogram', symbol: 'kg', dimension: 'mass' }, { _id: 'b', name: 'Gram', symbol: 'g', dimension: 'mass' }];
  const config = fromLegacy({ baseUnitId: 'a', additionalUnits: [{ unitId: 'b', conversionFactor: 0.001 }] }, rows);
  assert.equal(config.baseUnit.key, 'legacy_a'); assert.equal(config.units[1].factorToBase, '0.001');
  assert.deepEqual(units.normalize(config), config);
  assert.throws(() => fromLegacy({ baseUnitId: 'missing' }, rows));
  assert.throws(() => fromLegacy({ baseUnitId: 'a', additionalUnits: [{ unitId: 'b', conversionFactor: 1000 }] }, rows));
});


test('real OFF quantity spellings separate content from the unit and never invent missing units', () => {
  for (const [quantity, expected] of [['123g g','123'],['76,8 g','76.8'],['250gm','250'],['34.4 grams','34.4']]) {
    const parsed=parse({quantity});
    assert.equal(parsed.baseUnit.name,'Pack');assert.equal(parsed.units.length,1);
    assert.equal(parsed.units[0].symbol,'pack');assert.equal(parsed.quantityVariants[0].contentQuantity,expected);
    assert.equal(parsed.quantityVariants[0].contentUnit,'g');assert.equal(parsed.quantityVariants[0].amountInBase,'1');
    assert.deepEqual(units.dto(parsed), {baseUnit:parsed.baseUnit,units:parsed.units,quantityVariants:parsed.quantityVariants,needsUnit:false});
  }
  for(const quantity of ['', '200', '—', 'unknown', '1 constructor', '1 __proto__']) {
    const parsed=parse({quantity});assert.equal(parsed.baseUnit,null);assert.equal(parsed.needsUnit,true);assert.ok(parsed.warnings.length);
  }
  assert.equal(parse({quantity:'1 bottle'}).baseUnit.name,'Bottle');
  assert.equal(parse({quantity:'4 Pieces'}).baseUnit.name,'Piece');
});

test('package content and conversion factors cannot disagree', () => {
  const parsed=parse({quantity:'5kg, 10kg'});
  parsed.quantityVariants[1].contentQuantity='9';
  assert.throws(()=>units.normalize(parsed),{code:'INVALID_PRODUCT_UNIT'});
  const multi=parse({quantity:'4 x 250 ml'});
  multi.quantityVariants[0].amountPerPiece='200';
  assert.throws(()=>units.normalize(multi),{code:'INVALID_PRODUCT_UNIT'});
});
