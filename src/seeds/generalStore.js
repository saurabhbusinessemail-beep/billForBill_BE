'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { connectDatabase } = require('../DB/connection');
const BusinessType = require('../DB/models/BusinessType');
const Product = require('../DB/models/CatalogProduct');
const Category = require('../DB/models/ProductCategory');
const Attribute = require('../DB/models/ProductAttribute');
const Unit = require('../DB/models/CatalogUnit');
const Tax = require('../DB/models/TaxComponent');
const ProductImage = require('../DB/models/ProductImage');
const productUnits = require('../services/productUnits');
const { validateImage } = require('../services/adminSetup/productImages.service');

const REQUIREMENT = path.resolve(__dirname, '../../../docs/requirements/F008_BUSINESS_TYPE.md');
const DEFAULT_PRODUCT_IMAGE = path.resolve(__dirname, 'assets/default-product-image.png');
const text = fs.readFileSync(REQUIREMENT, 'utf8');
const norm = (value) => value.trim().toLocaleLowerCase('en-IN');

function section(title) {
  const start = text.indexOf(`#### ${title}`);
  if (start < 0) throw new Error(`Missing seed section: ${title}`);
  const bodyStart = text.indexOf('\n', start) + 1;
  const end = text.indexOf('\n#### ', bodyStart);
  return text.slice(bodyStart, end < 0 ? text.length : end);
}
function tableRows(markdown) {
  return markdown.split(/\r?\n/).filter((line) => line.trim().startsWith('|') && !/^\|[\s|:-]+\|?$/.test(line.trim()))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}
function stripMarkdown(value) { return value.replace(/\*\*/g, '').trim(); }
function sourceMapping() {
  const mapping = new Map();
  const imageStart = text.indexOf('The following source URL mapping');
  if (imageStart < 0) throw new Error('Missing product image source URL mapping.');
  const tableStart = text.indexOf('\n|', imageStart);
  if (tableStart < 0) throw new Error('Missing product image URL table.');
  const imageLines = [];
  for (const line of text.slice(tableStart + 1).split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) break;
    imageLines.push(line);
  }
  const imageSection = imageLines.join('\n');
  for (const row of tableRows(imageSection)) {
    if (row.length < 2 || row[0] === 'Product(s)') continue;
    const url = row[1].trim();
    for (const name of row[0].split(',').map((item) => item.trim())) mapping.set(name, url);
  }
  return mapping;
}
function categoryRows() {
  const body = section('Seed categories and subcategories');
  const stack = [];
  return body.split(/\r?\n/).filter((line) => /^\s*-\s+/.test(line)).map((line) => {
    const indent = (line.match(/^\s*/) || [''])[0].length;
    const depth = Math.floor(indent / 2);
    const name = line.replace(/^\s*-\s+/, '').trim();
    stack.length = depth;
    stack.push(name);
    return { name, path: stack.join(' > '), parentPath: depth ? stack.slice(0, -1).join(' > ') : null };
  });
}
function productRows() {
  const part = text.slice(text.indexOf('#### Seed products'));
  const rows = tableRows(part).filter(row => row.length >= 6 && row[0] !== 'Product');
  return rows.map((row) => ({ name: stripMarkdown(row[0]), categoryPath: row[1].replace(/\*\*/g, '').trim(), baseSymbol: row[2].trim(), additional: row[3].trim(), attributes: row[4].trim(), taxText: row[5].trim() }));
}
function declaredUnitSymbols() {
  const symbols = new Set(tableRows(section('Seed units')).filter(row => row[0] !== 'Unit').map(row => row[1]));
  if (symbols.has('pc')) symbols.add('piece');
  if (symbols.has('doz')) symbols.add('dozen');
  return symbols;
}
function validateSeedUnits() {
  const symbols = declaredUnitSymbols();
  const missing = new Set();
  for (const product of productRows()) {
    if (!symbols.has(product.baseSymbol)) missing.add(`base unit "${product.baseSymbol}" for ${product.name}`);
    if (product.additional !== '—') for (const item of product.additional.split(',')) {
      const unitSymbol = item.trim().split(/\s+/)[0];
      if (!symbols.has(unitSymbol)) missing.add(`additional unit "${unitSymbol}" for ${product.name}`);
    }
  }
  for (const row of tableRows(section('Seed attributes')).filter(row => row[0] !== 'Attribute' && row[1] !== '—')) {
    for (const symbol of row[1].split(',').map(value => value.trim())) if (!symbols.has(symbol)) missing.add(`attribute unit "${symbol}" for ${row[0]}`);
  }
  if (missing.size) throw new Error(`Seed fixture references units that are not declared: ${[...missing].join('; ')}`);
  return symbols;
}
async function upsertNamed(Model, name, fields) {
  const normalizedName = norm(name);
  const existing = await Model.findOne({ normalizedName });
  return existing || Model.create({ ...fields, name, normalizedName });
}
function optimizedUrl(sourceUrl) {
  const url = new URL(sourceUrl); url.searchParams.set('fit', 'crop'); url.searchParams.set('w', '800'); url.searchParams.set('q', '75'); url.searchParams.set('fm', 'jpg'); url.searchParams.delete('auto'); return url.toString();
}
async function downloadSource(sourceUrl, cache) {
  const cacheKey = sourceUrl || '__default-product-image__';
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  try {
    if (!sourceUrl) throw new Error('No source URL was configured');
    const response = await fetch(optimizedUrl(sourceUrl), { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Image source returned HTTP ${response.status}`);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 512000) throw new Error('Optimized image exceeds 500 KiB');
    validateImage(contentType, 'seed-image', bytes);
    const data = { contentType, bytes, isFallback: false };
    cache.set(cacheKey, data);
    return data;
  } catch (sourceError) {
    const fallbackBytes = fs.readFileSync(DEFAULT_PRODUCT_IMAGE);
    const fallbackType = 'image/png';
    validateImage(fallbackType, 'default-product-image.png', fallbackBytes);
    console.warn(`[seed] Using default product image${sourceUrl ? ` for ${sourceUrl}` : ''}: ${sourceError.message}`);
    const data = { contentType: fallbackType, bytes: fallbackBytes, isFallback: true };
    cache.set(cacheKey, data);
    return data;
  }
}

async function seed() {
  validateSeedUnits();
  const images = sourceMapping();
  const entries = productRows();
  const imageCache = new Map();
  // Complete and validate all remote downloads before touching the database.
  for (const entry of entries) {
    const sourceUrl = images.get(entry.name) || '';
    await downloadSource(sourceUrl, imageCache);
  }

  const categoryMap = new Map();
  for (const row of categoryRows()) {
    const parentId = row.parentPath ? categoryMap.get(row.parentPath)?._id : null;
    let category = await Category.findOne({ normalizedName: norm(row.name), parentId });
    if (!category) category = await Category.create({ name: row.name, normalizedName: norm(row.name), parentId });
    categoryMap.set(row.path, category);
  }

  const unitMap = new Map();
  const attributeRows = tableRows(section('Seed attributes')).filter(row => row[0] !== 'Attribute' && !row[0].startsWith('Note:'));
  const genericSymbols = new Set(attributeRows.flatMap(row => row[1] === '—' ? [] : row[1].split(',').map(s => s.trim())));
  const aliases = { pc: 'piece', doz: 'dozen' };
  for (const row of tableRows(section('Seed units')).filter(row => row[0] !== 'Unit')) {
    const values = { name: row[0], symbol: row[1], dimension: row[2].toLowerCase() };
    const unit = genericSymbols.has(row[1]) || genericSymbols.has(aliases[row[1]]) ? await upsertNamed(Unit, row[0], values) : { ...values, _id: row[1] };
    unitMap.set(row[1], unit);
  }
  if (unitMap.has('pc')) unitMap.set('piece', unitMap.get('pc'));
  if (unitMap.has('doz')) unitMap.set('dozen', unitMap.get('doz'));
  // Day is required by the Shelf Life attribute in the fixture.
  if (!unitMap.has('d')) { const day = await upsertNamed(Unit, 'Day', { symbol: 'd', dimension: 'time' }); unitMap.set('d', day); }

  const attributeMap = new Map();
  for (const row of tableRows(section('Seed attributes')).filter(row => row[0] !== 'Attribute' && !row[0].startsWith('Note:'))) {
    const refs = row[1] === '—' ? [] : row[1].split(',').map(symbol => unitMap.get(symbol.trim())?._id).filter(Boolean);
    const attribute = await upsertNamed(Attribute, row[0], { unitIds: refs }); attributeMap.set(row[0], attribute);
  }

  const taxMap = new Map();
  for (const row of tableRows(section('Seed tax components')).filter(row => row[0] !== 'Name')) {
    const fixed = row[1].toLowerCase().includes('fixed');
    const value = Number.parseFloat(row[2].replace(/[^\d.]/g, ''));
    const tax = await upsertNamed(Tax, row[0], { calculationType: fixed ? 'fixed' : 'percentage', value, currency: fixed ? row[3] : '', effectiveStart: new Date(new Date().toISOString().slice(0, 10)), effectiveEnd: null, jurisdiction: 'Illustrative test data', description: 'Sample configuration only; not a legal tax classification.' });
    taxMap.set(row[0], tax);
  }

  const products = [];
  let fallbackProducts = 0;
  for (const entry of entries) {
    const baseUnit = unitMap.get(entry.baseSymbol);
    if (!baseUnit) throw new Error(`Missing seeded base unit ${entry.baseSymbol} for ${entry.name}`);
    const category = categoryMap.get(entry.categoryPath);
    const categoryIds = category ? [category._id] : [];
    const addition = entry.additional === '—' ? [] : entry.additional.split(',').map((part) => {
      const symbol = part.trim().split(/\s+/)[0]; const unit = unitMap.get(symbol);
      const baseMetric = productUnits.metric(baseUnit.symbol); const alternateMetric = productUnits.metric(symbol);
      if (!baseMetric || !alternateMetric || baseMetric[1] !== alternateMetric[1]) throw new Error('Unsupported explicit seed conversion for ' + entry.name);
      if (alternateMetric[2] * 100000000n % baseMetric[2]) { console.log('[seed] Skipped nonrepresentable alternate ' + symbol + ' for ' + entry.name + '; base unit is unchanged.'); return null; }
      const factor = productUnits.text(alternateMetric[2] * 100000000n / baseMetric[2]);
      if (!unit) throw new Error(`Missing additional unit ${symbol} for ${entry.name}`);
      return { unitId: unit._id, conversionFactor: factor };
    }).filter(Boolean);
    const attributeIds = entry.attributes === '—' ? [] : entry.attributes.split(',').map(name => attributeMap.get(name.trim())?._id).filter(Boolean);
    const specificTax = entry.taxText.match(/Specific:\s*([^;]+)/i)?.[1]?.trim();
    const typeMatch = entry.taxText.match(/Product type\s+\*\*([^*]+)\*\*/i);
    const type = /^services?$/i.test(typeMatch?.[1]?.trim() || '') ? 'Services' : 'Goods';
    const config = productUnits.normalize({ baseUnit: { key: 'base', name: baseUnit.name, symbol: baseUnit.symbol, dimension: baseUnit.dimension, factorToBase: '1', active: true, source: 'manual' }, units: addition.map((a, i) => { const unit = [...unitMap.values()].find(u => String(u._id) === String(a.unitId)); return { key: 'unit_' + i, name: unit.name, symbol: unit.symbol, dimension: unit.dimension, factorToBase: String(a.conversionFactor), conversionKind: 'product_specific', active: true, source: 'manual' }; }), quantityVariants: [] });
    const fields = { type, categoryIds, title: entry.name, variations: [productUnits.storeVariation({ key: 'default', values: {}, ...config })], legacyStockVariantKey: 'default', attributeIds, taxMode: specificTax ? 'specific' : 'inherit', taxComponentIds: specificTax && taxMap.has(specificTax) ? [taxMap.get(specificTax)._id] : [] };
    let product = await Product.findOne({ normalizedName: norm(entry.name), categoryIds: { $all: categoryIds, $size: categoryIds.length } });
    if (!product) product = await Product.create({ name: entry.name, normalizedName: norm(entry.name), ...fields });
    const sourceUrl = images.get(entry.name);
    const image = await downloadSource(sourceUrl, imageCache);
    if (image.isFallback) fallbackProducts += 1;
    if (!(await ProductImage.exists({ productId: product._id }))) await ProductImage.create({ productId: product._id, originalName: image.isFallback ? 'default-product-image.png' : `${norm(entry.name).replace(/[^a-z0-9]+/g, '-')}.jpg`, contentType: image.contentType, sizeBytes: image.bytes.length, data: image.bytes, seedSourceUrl: sourceUrl, seedFallback: image.isFallback });
    products.push(product._id);
  }

  const businessType = await upsertNamed(BusinessType, 'General Store', { description: 'Illustrative general store catalog for testing.', productIds: [], taxComponentIds: [] });
  businessType.name = 'General Store';
  businessType.normalizedName = norm('General Store');
  businessType.productIds = [...new Set([...(businessType.productIds || []).map(String), ...products.map(String)])];
  businessType.taxComponentIds = [...new Set([...(businessType.taxComponentIds || []).map(String), ...[...taxMap.values()].map(tax => String(tax._id))])];
  await businessType.save();
  const unitCount = new Set([...unitMap.values()].filter(unit => mongoose.isValidObjectId(unit._id)).map(unit => String(unit._id))).size;
  console.log(`Seeded General Store: ${categoryMap.size} categories, ${unitCount} units, ${attributeMap.size} attributes, ${taxMap.size} tax components, ${products.length} products and ${products.length} product images (${fallbackProducts} using the default image; type ${businessType._id}).`);
}

if (require.main === module) {
  connectDatabase().then(seed).then(() => mongoose.connection.close()).catch(async (error) => { console.error('[seed] General store seed failed:', error.message); await mongoose.connection.close(); process.exitCode = 1; });
}

module.exports = { seed, categoryRows, productRows, sourceMapping, optimizedUrl, downloadSource, validateSeedUnits, DEFAULT_PRODUCT_IMAGE };
