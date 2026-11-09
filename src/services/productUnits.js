'use strict';

// Decimal contract: positive factors up to 10^10, eight fractional places;
// transaction quantities up to 10^10, six places (stock uses four).
const SCALE = 100000000n;
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
function fixed(value, maximum = 10000000000n) {
  let text = String(value ?? '');
  // BSON may render a valid small Decimal128 in exponent notation. Expand only
  // trusted typed decimals; request strings must still use plain decimal text.
  if (value?._bsontype === 'Decimal128' && /e/i.test(text)) {
    const match = /^(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
    if (!match) throw fail('INVALID_CONVERSION', 'Enter a finite decimal conversion.');
    const digits = match[1] + (match[2] || ''); const point = match[1].length + Number(match[3]);
    if (Math.abs(point) > 40) throw fail('INVALID_CONVERSION', 'Conversion exceeds the supported range.');
    text = point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(text) || text.length > 24) throw fail('INVALID_CONVERSION', 'Enter a valid decimal conversion with up to eight decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
  if (result <= 0n || result > maximum * SCALE) throw fail('INVALID_CONVERSION', 'Conversion must be positive and at most 10 billion.');
  return result;
}
function text(value) { return `${value / SCALE}.${String(value % SCALE).padStart(8, '0')}`.replace(/\.?0+$/, ''); }
function multiply(quantity, factor, places = 6, maximum = 10000000000n) {
  const result = fixed(quantity, maximum) * fixed(factor);
  const divisor = SCALE * (10n ** BigInt(8 - places));
  if (result % divisor) throw fail('INVALID_CONVERSION', 'The converted quantity exceeds the supported decimal precision.');
  const value = result / SCALE;
  if (value > maximum * SCALE) throw fail('INVALID_CONVERSION', 'The converted quantity exceeds the supported range.');
  return text(value);
}
const metrics = {
  g: ['Gram', 'mass', 1n], kg: ['Kilogram', 'mass', 1000n],
  ml: ['Millilitre', 'volume', 1n], l: ['Litre', 'volume', 1000n], kl: ['Kilolitre', 'volume', 1000000n],
  pc: ['Piece', 'count', 1n], doz: ['Dozen', 'count', 12n], pair: ['Pair', 'count', 2n],
};
const aliases = { dozen: 'doz', dozens: 'doz', grams: 'g', gram: 'g', gm: 'g', gms: 'g', kilograms: 'kg', kilogram: 'kg', millilitres: 'ml', milliliters: 'ml', litre: 'l', liter: 'l', litres: 'l', liters: 'l', pieces: 'pc', piece: 'pc', pcs: 'pc' };
const metric = symbol => { const key = String(symbol).toLowerCase(); const canonical = Object.hasOwn(aliases, key) ? aliases[key] : key; return Object.hasOwn(metrics, canonical) ? metrics[canonical] : undefined; };
function normalize(input, allowMissing = false) {
  if (!input.baseUnit) {
    if (allowMissing) return { baseUnit: null, units: [], quantityVariants: [], needsUnit: true };
    throw fail('PRODUCT_UNIT_MIGRATION_REQUIRED', 'Configure this product’s base unit before use.', 409);
  }
  const clean = (u, base = false) => {
    if (!u || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(u.key || '') || typeof u.name !== 'string' || !u.name.trim() || u.name.length > 100 || typeof u.symbol !== 'string' || !u.symbol.trim() || u.symbol.length > 24 || !['mass', 'volume', 'count', 'length', 'area', 'time', 'package', 'service', 'other'].includes(u.dimension)) throw fail('INVALID_PRODUCT_UNIT', 'Enter a valid product unit key, name, symbol and dimension.');
    const factorToBase = text(fixed(u.factorToBase));
    if (base && factorToBase !== '1') throw fail('INVALID_PRODUCT_UNIT', 'The base unit conversion must equal one.');
    if (!base && !['standard', 'product_specific'].includes(u.conversionKind || 'standard')) throw fail('INVALID_PRODUCT_UNIT', 'Choose a valid conversion kind.');
    if (u.source && !['manual', 'open_food_facts'].includes(u.source)) throw fail('INVALID_PRODUCT_UNIT', 'Choose a valid unit source.');
    return { key: u.key, name: u.name.trim(), symbol: u.symbol.trim(), dimension: u.dimension, factorToBase, conversionKind: u.conversionKind || 'standard', active: base || u.active !== false, source: u.source || 'manual', ...(u.sourceText ? { sourceText: String(u.sourceText).slice(0, 500) } : {}) };
  };
  const baseUnit = clean(input.baseUnit, true);
  if (metric(baseUnit.symbol) && metric(baseUnit.symbol)[1] !== baseUnit.dimension) throw fail('INVALID_PRODUCT_UNIT', 'The base unit dimension must match its canonical symbol.');
  const additional = input.units ?? (input.baseUnitId ? [] : input.additionalUnits) ?? [];
  if (!Array.isArray(additional) || additional.length > 100 || !Array.isArray(input.quantityVariants || []) || (input.quantityVariants || []).length > 100) throw fail('INVALID_PRODUCT_UNIT', 'At most 100 units and variants are supported.');
  const supplied = additional.map(u => clean(u));
  const units = [baseUnit, ...supplied.filter(u => u.key !== baseUnit.key)];
  if (supplied.filter(u => u.key === baseUnit.key).some(u => u.factorToBase !== '1' || u.symbol !== baseUnit.symbol || u.dimension !== baseUnit.dimension) || new Set(supplied.map(u => u.key)).size !== supplied.length || new Set(units.map(u => u.key)).size !== units.length) throw fail('INVALID_PRODUCT_UNIT', 'Product unit keys must be unique.');
  const quantityVariants = (input.quantityVariants || []).map(v => {
    const unit = units.find(u => u.key === v.unitKey);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v.key || '') || typeof v.label !== 'string' || !v.label.trim() || v.label.length > 100 || !unit || fixed(v.amountInBase) !== fixed(unit.factorToBase)) throw fail('INVALID_PRODUCT_UNIT', 'Each package variant must match a product unit and amount.');
    const result = { key: v.key, label: v.label.trim(), sourceText: String(v.sourceText || '').slice(0, 500), amountInBase: text(fixed(v.amountInBase)), unitKey: v.unitKey, source: v.source || 'manual', active: v.active !== false };
    if (!['manual', 'open_food_facts'].includes(result.source)) throw fail('INVALID_PRODUCT_UNIT', 'Choose a valid variant source.');
    if (v.contentQuantity != null || v.contentUnit != null) {
      const content = metric(v.contentUnit);
      if (!content) throw fail('INVALID_PRODUCT_UNIT', 'Choose a supported package content unit.');
      Object.assign(result, { contentQuantity: text(fixed(v.contentQuantity)), contentUnit: Object.keys(metrics).find(key => metrics[key] === content) });
    }
    if (v.packageCount != null) {
      if (!Number.isSafeInteger(Number(v.packageCount)) || Number(v.packageCount) <= 0 || !v.amountPerPieceUnit) throw fail('INVALID_PRODUCT_UNIT', 'Enter an explicit package count and per-piece amount.');
      Object.assign(result, { packageCount: Number(v.packageCount), amountPerPiece: text(fixed(v.amountPerPiece)), amountPerPieceUnit: String(v.amountPerPieceUnit) });
      const piece = metric(v.amountPerPieceUnit); const base = metric(baseUnit.symbol);
      if (!piece || (baseUnit.dimension === 'package'
        ? !result.contentUnit || piece[1] !== metric(result.contentUnit)[1] || fixed(v.amountPerPiece) * BigInt(result.packageCount) * piece[2] !== fixed(result.contentQuantity) * metric(result.contentUnit)[2]
        : !base || piece[1] !== base[1] || fixed(v.amountPerPiece) * BigInt(result.packageCount) * piece[2] !== fixed(v.amountInBase) * base[2])) throw fail('INVALID_PRODUCT_UNIT', 'Package count and content must equal the variant amount.');
    }
    return result;
  });
  if (new Set(quantityVariants.map(v => v.key)).size !== quantityVariants.length || new Set(quantityVariants.map(v => `${v.amountInBase}:${v.packageCount || ''}`)).size !== quantityVariants.length) throw fail('INVALID_PRODUCT_UNIT', 'Duplicate package variants are not allowed.');
  const packAnchor = baseUnit.dimension === 'package' ? quantityVariants.find(v => v.unitKey === baseUnit.key && v.contentUnit) : null;
  if (baseUnit.dimension === 'package' && quantityVariants.some(v => v.contentUnit) && !packAnchor) throw fail('INVALID_PRODUCT_UNIT', 'Define the content of the base pack before adding other package sizes.');
  if (packAnchor) for (const variant of quantityVariants.filter(v => v.contentUnit)) {
    const reference = metric(packAnchor.contentUnit); const content = metric(variant.contentUnit);
    if (reference[1] !== content[1] || fixed(variant.contentQuantity) * content[2] * SCALE !== fixed(packAnchor.contentQuantity) * reference[2] * fixed(variant.amountInBase)) throw fail('INVALID_PRODUCT_UNIT', 'Package content must agree with its conversion to the base pack.');
  }
  const seen = new Set();
  for (const u of units) {
    const canonical = metric(u.symbol); const base = metric(baseUnit.symbol);
    if (u.dimension !== baseUnit.dimension && !(u.dimension === 'count' && u.conversionKind === 'product_specific' && quantityVariants.some(v => v.packageCount && (base ? fixed(v.amountPerPiece) * metric(v.amountPerPieceUnit)[2] === fixed(u.factorToBase) * base[2] : packAnchor && metric(v.amountPerPieceUnit)[1] === metric(packAnchor.contentUnit)[1] && fixed(v.amountPerPiece) * metric(v.amountPerPieceUnit)[2] * SCALE === fixed(u.factorToBase) * fixed(packAnchor.contentQuantity) * metric(packAnchor.contentUnit)[2])))) throw fail('INVALID_PRODUCT_UNIT', 'Cross-dimension conversions require explicit package content.');
    if (canonical && base && u.key !== baseUnit.key && u.dimension === baseUnit.dimension && (canonical[1] !== base[1] || fixed(u.factorToBase) * base[2] !== SCALE * canonical[2])) throw fail('INVALID_PRODUCT_UNIT', 'Standard metric conversions must use canonical factors.');
    const variant = quantityVariants.find(v => v.unitKey === u.key);
    const identity = `${u.dimension}:${u.factorToBase}:${variant?.packageCount || ''}`;
    if (seen.has(identity)) throw fail('INVALID_PRODUCT_UNIT', 'Duplicate equivalent unit options are not allowed.');
    seen.add(identity);
  }
  return { baseUnit, units, quantityVariants, needsUnit: false };
}
function variationUnits(product, variantKey) {
  const variants = product.variations || product.variants || [];
  const variant = variantKey == null ? variants[0] : variants.find(item => item.key === variantKey);
  // Rows saved before variation units have neither a nested base nor a repair flag.
  return variant && (variant.baseUnit || variant.needsUnit !== undefined) ? variant : product;
}
function revision(product, variantKey) { return require('node:crypto').createHash('sha256').update(JSON.stringify(dto(product, variantKey))).digest('hex'); }
function options(product, variantKey) {
  if (variationUnits(product, variantKey).needsUnit === true) return [];
  const config = dto(product, variantKey);
  if (config.needsUnit) return [];
  return config.units.filter(u => u.active && (u.key === config.baseUnit.key || !config.quantityVariants.some(v => v.unitKey === u.key && !v.active)));
}
function dto(product, variantKey) {
  const config = variationUnits(product, variantKey);
  return normalize(config, !config.baseUnit);
}
function variations(product) {
  const stored = product.variations || product.variants;
  const variants = stored?.length ? stored : [{ key: 'default', values: {} }];
  return variants.map(variant => {
    const legacy = variant.key === legacyVariantKey(product) ? product : {};
    const fields = Object.fromEntries(variationMetadataFields.map(field => [field, variant[field] === undefined ? legacy[field] : variant[field]]));
    if (variant.mrp === undefined && product.variations && product.variants) {
      const previous = product.variants.find(item => item.key === variant.key);
      if (previous?.mrp !== undefined) fields.mrp = previous.mrp;
    }
    if (fields.mrp != null) fields.mrp = fields.mrp.toString();
    fields.gtin ||= fields.normalizedGtin;
    fields.barcode ??= fields.gtin;
    const values = variant.values instanceof Map ? Object.fromEntries(variant.values) : variant.values || {};
    return storeVariation({ key: variant.key, values, ...fields, reorderLevel: variant.reorderLevel, ...dto(product, variant.key) });
  });
}
function legacyVariantKey(product) { return product.legacyStockVariantKey || (product.variations || product.variants)?.[0]?.key || 'default'; }
const variationMetadataFields = ['barcode', 'gtin', 'normalizedGtin', 'mrp'];
function storeVariation({ units, ...variation }) {
  return { ...variation, additionalUnits: units ? units.filter(unit => unit.key !== variation.baseUnit?.key) : variation.additionalUnits };
}
function productBrand(product) {
  const legacy = product.variants || [];
  return product.brand || legacy.find(item => item.key === legacyVariantKey(product))?.brand || legacy.find(item => item.brand)?.brand || '';
}
function withEmptyVariation(variants) {
  if (variants.some(item => !Object.values(item.values || {}).some(Boolean))) return variants;
  let key = 'default';
  for (let suffix = 1; variants.some(item => item.key === key); suffix++) key = `default_${suffix}`;
  const { baseUnit, additionalUnits, quantityVariants, needsUnit } = variants[0];
  return [...variants, { key, values: {}, baseUnit, additionalUnits, quantityVariants, needsUnit }];
}
module.exports = { fixed, text, multiply, metric, metrics, normalize, options, dto, variations, variationMetadataFields, storeVariation, productBrand, withEmptyVariation, legacyVariantKey, revision, fail };
