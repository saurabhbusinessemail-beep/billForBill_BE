'use strict';

const { assertDatabaseConnected } = require('../../DB/connection');
const BusinessType = require('../../DB/models/BusinessType');
const Product = require('../../DB/models/CatalogProduct');
const ProductImage = require('../../DB/models/ProductImage');
const Category = require('../../DB/models/ProductCategory');
const Attribute = require('../../DB/models/ProductAttribute');
const Unit = require('../../DB/models/CatalogUnit');
const common = require('./catalogCommon.service');
const images = require('./productImages.service');

const BASE_URL = (process.env.OPEN_FOOD_FACTS_API_BASE_URL || 'https://world.openfoodfacts.org').replace(/\/$/, '');
const API_VERSION = process.env.OPEN_FOOD_FACTS_API_VERSION || '3.6';
const USER_AGENT = process.env.OPEN_FOOD_FACTS_USER_AGENT || 'BillForBill/1.0 (local-development)';
const TIMEOUT_MS = Math.max(1000, Math.min(Number(process.env.OPEN_FOOD_FACTS_TIMEOUT_MS) || 15000, 30000));
const retryValue = Number.parseInt(process.env.OPEN_FOOD_FACTS_MAX_RETRIES ?? '2', 10);
const MAX_RETRIES = Math.max(0, Math.min(Number.isFinite(retryValue) ? retryValue : 1, 2));
const activeSyncs = new Set();
const rateLimitNextAt = new Map();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeError = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
function retryDelay(response, attempt) {
  const value = response?.headers?.get('retry-after');
  const seconds = Number(value);
  const dateDelay = value && !Number.isFinite(seconds) ? Date.parse(value) - Date.now() : 0;
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Number.isFinite(dateDelay) && dateDelay > 0 ? dateDelay : 0;
  return Math.max(3000 * (2 ** attempt), retryAfterMs) + Math.floor(Math.random() * 1000);
}
const englishTag = (value) => {
  const raw = String(value || '').trim().toLowerCase().replace(/^en:/, '');
  const normalized = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized ? `en:${normalized}` : '';
};
const normalizeLabel = (value) => String(value || '').trim().toLocaleLowerCase('en-IN').replace(/\s+/g, ' ');
const productUrl = (code) => `${BASE_URL}/product/${encodeURIComponent(code)}`;

function apiUrl(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  return url;
}
async function requestJson(url, externalSignal) {
  if (!['https://world.openfoodfacts.org', 'https://world.openfoodfacts.net'].includes(BASE_URL)) throw safeError(503, 'OFF_CONFIGURATION_INVALID', 'Open Food Facts API base URL must use an approved HTTPS host.');
  if (!/^[A-Za-z0-9._-]+\/\d+(?:\.\d+)* \([^()\s]+@[^()\s]+\)$/.test(USER_AGENT)) throw safeError(503, 'OFF_USER_AGENT_REQUIRED', 'Configure OPEN_FOOD_FACTS_USER_AGENT with an application name, version, and contact email before syncing.');
  const interval = url.pathname === '/api/v2/search' ? 6100 : /^\/api\/v3\.6\/product\//.test(url.pathname) ? 4100 : 0;
  const rateKey = url.pathname === '/api/v2/search' ? 'search' : 'product';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (interval) {
      const scheduledAt = Math.max(Date.now(), rateLimitNextAt.get(rateKey) || 0);
      rateLimitNextAt.set(rateKey, scheduledAt + interval);
      if (scheduledAt > Date.now()) await wait(scheduledAt - Date.now());
    }
    const controller = new AbortController(); const cancel = () => controller.abort();
    if (externalSignal?.aborted) controller.abort(); else externalSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS); timer.unref?.();
    try {
      const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
      if (BASE_URL === 'https://world.openfoodfacts.net') headers.Authorization = `Basic ${Buffer.from('off:off').toString('base64')}`;
      const response = await fetch(url, { headers, signal: controller.signal });
      if (response.status === 429) throw safeError(503, 'OFF_RATE_LIMITED', 'Open Food Facts is rate limiting requests. Wait and retry.');
      if (response.status >= 500 && attempt < MAX_RETRIES) { const delay = retryDelay(response, attempt); await response.body?.cancel(); await wait(delay); continue; }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 503) throw Object.assign(safeError(503, 'OFF_UPSTREAM_UNAVAILABLE', 'Open Food Facts is temporarily unavailable or applying a global rate limit. Wait before retrying.'), { expose: true });
        throw Object.assign(safeError(502, 'OFF_UPSTREAM_ERROR', `Open Food Facts rejected ${url.pathname} with HTTP ${response.status}.`), { expose: true });
      }
      const bytes = await readLimited(response, 5_000_000);
      return JSON.parse(bytes.toString('utf8'));
    } catch (cause) {
      if (externalSignal?.aborted) throw safeError(499, 'OFF_SYNC_CANCELLED', 'Synchronization was cancelled because the Business Type popup was closed.');
      if (cause.statusCode) throw cause;
      if (attempt < MAX_RETRIES) { await wait(retryDelay(null, attempt)); continue; }
      throw safeError(503, 'OFF_UNAVAILABLE', cause.name === 'AbortError' ? 'Open Food Facts request timed out.' : 'Open Food Facts is unavailable.');
    } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', cancel); }
  }
  throw safeError(503, 'OFF_UNAVAILABLE', 'Open Food Facts is unavailable.');
}
async function readLimited(response, limit) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > limit) { await response.body?.cancel(); throw safeError(502, 'OFF_RESPONSE_TOO_LARGE', 'Open Food Facts returned an oversized response.'); }
  if (!response.body) throw safeError(502, 'OFF_EMPTY_RESPONSE', 'Open Food Facts returned an empty response.');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw safeError(502, 'OFF_RESPONSE_TOO_LARGE', 'Open Food Facts returned an oversized response.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}
async function taxonomyEntries(tagType, tags, fields = 'name', signal) {
  if (!tags.length) return {};
  const result = await requestJson(apiUrl('/api/v2/taxonomy', { tagtype: tagType, tags: tags.join(','), fields, lc: 'en' }), signal);
  return result && typeof result === 'object' && result.status !== 'failure' ? result : {};
}
async function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw safeError(400, 'INVALID_OFF_CONFIG', 'Enter valid Open Food Facts mapping details.');
  const countryTag = englishTag(input.countryTag);
  const rawTags = input.categoryTags;
  if (!countryTag && input.isActive !== true && Array.isArray(rawTags) && rawTags.length === 0) return { provider: 'open_food_facts', countryTag: '', categoryTags: [], isActive: false };
  if (countryTag.length > 80 || !/^en:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(countryTag)) throw safeError(400, 'INVALID_OFF_COUNTRY', 'Enter a valid country name, such as India.');
  if (!Array.isArray(input.categoryTags) || input.categoryTags.length > 25) throw safeError(400, 'INVALID_OFF_CATEGORIES', 'Choose up to 25 canonical category tags.');
  const categoryTags = [...new Set(input.categoryTags.map(englishTag).filter(Boolean))];
  if (categoryTags.some((tag) => tag.length > 80 || !/^en:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag))) throw safeError(400, 'INVALID_OFF_CATEGORIES', 'Enter valid English category names.');
  const isActive = input.isActive === true;
  if (isActive && !categoryTags.length) throw safeError(400, 'INVALID_OFF_CATEGORIES', 'Add at least one category tag before enabling synchronization.');
  if (categoryTags.length) {
    const categoryTaxonomy = await taxonomyEntries('categories', categoryTags);
    if (categoryTags.some((tag) => !Object.hasOwn(categoryTaxonomy, tag))) throw safeError(400, 'INVALID_OFF_CATEGORIES', 'One or more category tags are not present in the Open Food Facts taxonomy.');
  }
  const countryTaxonomy = await taxonomyEntries('countries', [countryTag]);
  if (!Object.hasOwn(countryTaxonomy, countryTag)) throw safeError(400, 'INVALID_OFF_COUNTRY', 'The country tag is not present in the Open Food Facts taxonomy.');
  return { provider: 'open_food_facts', countryTag, categoryTags, isActive };
}

async function saveConfig(id, input) {
  assertDatabaseConnected();
  const type = await BusinessType.findOne({ _id: id, businessId: null });
  if (!type) throw safeError(404, 'BUSINESS_TYPE_NOT_FOUND', 'Business Type not found.');
  const config = await validateConfig(input);
  type.openFoodFactsConfig = { ...type.openFoodFactsConfig?.toObject?.(), ...config, mappingRevision: (type.openFoodFactsConfig?.mappingRevision || 0) + 1 };
  await type.save();
  const savedConfig = type.toObject().openFoodFactsConfig || config;
  return { id: String(type._id), ...savedConfig };
}

async function taxonomySuggestions(tagType, search, context = '') {
  const allowed = { categories: 'categories', countries: 'countries' };
  const type = allowed[tagType]; if (!type) throw safeError(400, 'INVALID_TAXONOMY_TYPE', 'Choose categories or countries.');
  const text = String(search || '').trim().split(/[\n,]+/).map((part) => part.trim()).filter(Boolean).at(-1)?.slice(0, 80) || '';
  if (text.length < 2) return [];
  const categories = [...new Set(String(context || '').split(/[|,\n]+/).map(englishTag).filter(Boolean))].slice(0, 25);
  const result = await requestJson(apiUrl('/api/v3/taxonomy_suggestions', { tagtype: type, string: text, lc: 'en', limit: 100, categories: categories.join(',') }));
  const suggestions = Array.isArray(result) ? result : Array.isArray(result?.suggestions) ? result.suggestions : Array.isArray(result?.result?.suggestions) ? result.result.suggestions : [];
  const rows = suggestions.map((entry) => {
    const suggestion = typeof entry === 'string' ? entry : String(entry.id || entry.tag || entry.value || entry.text || entry.name || '');
    const tag = englishTag(suggestion);
    const name = suggestion.replace(/^en:/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 120);
    return { tag, name };
  });
  const unique = new Map();
  for (const row of rows) if (/^en:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.tag) && !categories.includes(row.tag) && !unique.has(row.tag)) unique.set(row.tag, row);
  return [...unique.values()].slice(0, 100);
}

function validGtin(value) { try { return common.normalizeGtin(String(value || '')) || ''; } catch { return ''; } }
function validProduct(product) {
  if (!product || typeof product !== 'object') return null;
  const code = validGtin(product.code);
  const name = String(product.product_name_en || product.product_name || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  if (!code || !name) return null;
  const selected = product.selected_images?.front?.display || product.selected_images?.front?.small || {};
  const selectedUrl = selected.en || Object.values(selected).find((url) => typeof url === 'string') || '';
  const timestamp = product.last_modified_t === null || product.last_modified_t === undefined ? NaN : Number(product.last_modified_t);
  const pendingAttributes = (Array.isArray(product.attribute_groups) ? product.attribute_groups : []).flatMap((group) => (Array.isArray(group.attributes) ? group.attributes : []).map((attribute) => ({ id: String(attribute.id || '').slice(0, 160), groupId: String(group.id || '').slice(0, 160), groupName: String(group.name || '').slice(0, 160), name: String(attribute.name || attribute.title || '').slice(0, 160), value: String(attribute.title || '').slice(0, 500), status: String(attribute.status || '').slice(0, 40), match: String(attribute.match || '').slice(0, 40), description: String(attribute.description || '').slice(0, 500) })).filter((attribute) => attribute.name || attribute.id)).slice(0, 100);
  const categoryTags = [...new Set((Array.isArray(product.categories_tags) ? product.categories_tags : []).map(englishTag).filter((tag) => /^en:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)))].slice(0, 100);
  return { code, name, normalizedName: normalizeLabel(name), brand: String(product.brands || '').split(',')[0].trim().slice(0, 120), imageUrl: String(product.image_front_url || product.image_front_small_url || selectedUrl), updatedAt: Number.isFinite(timestamp) ? new Date(timestamp * 1000) : null, categoryTags, pendingAttributes };
}
function safeImageUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && ['images.openfoodfacts.org', 'images.openfoodfacts.net'].includes(url.hostname) ? url : null; } catch { return null; }
}
async function downloadImage(value, externalSignal) {
  const url = safeImageUrl(value); if (!url) return null;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS); timer.unref?.();
  const cancel = () => controller.abort();
  if (externalSignal?.aborted) controller.abort(); else externalSignal?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal, redirect: 'error' });
    if (!response.ok) return null;
    const type = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return null;
    const buffer = await readLimited(response, 512000);
    images.validateImage(type, 'off-product-image', buffer);
    return { type, buffer, url: url.toString() };
  } catch (cause) { if (externalSignal?.aborted) throw safeError(499, 'OFF_SYNC_CANCELLED', 'Synchronization was cancelled because the Business Type popup was closed.'); return null; } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', cancel); }
}
async function productDetail(code, signal) {
  const url = apiUrl(`/api/v${API_VERSION}/product/${encodeURIComponent(code)}.json`, { fields: 'code,product_name,product_name_en,brands,image_front_url,image_front_small_url,selected_images,last_modified_t,categories_tags,attribute_groups' });
  const data = await requestJson(url, signal);
  const successful = data?.status === 1 || (typeof data?.status === 'string' && data.status.startsWith('success'));
  return successful && data.product && typeof data.product === 'object' ? data.product : null;
}
async function localMatch(item) {
  const byGtin = await Product.findOne({ businessId: null, normalizedGtin: item.code });
  if (byGtin) return { product: byGtin, type: 'gtin' };
  const bySource = await Product.findOne({ businessId: null, externalSource: 'open_food_facts', externalProductId: item.code });
  if (bySource) return { product: bySource, type: 'source' };
  if (!item.brand) return null;
  const candidates = await Product.find({ businessId: null, normalizedName: item.normalizedName }).limit(3);
  const matching = candidates.filter((row) => normalizeLabel(row.brand) === normalizeLabel(item.brand));
  if (matching.length === 1) return { product: matching[0], type: 'name_brand' };
  if (matching.length > 1) return { ambiguous: true };
  return null;
}
async function addImage(productId, image, code) {
  await ProductImage.create({ productId, originalName: `off-${code}`, contentType: image.type, sizeBytes: image.buffer.length, data: image.buffer, provider: 'open_food_facts', sourceUrl: image.url, sourceProductUrl: productUrl(code), licenseId: 'CC BY-SA', licenseUrl: 'https://creativecommons.org/licenses/by-sa/', attribution: 'Open Food Facts contributors; see source product page for image credits', seedSourceUrl: image.url });
}
async function associate(typeId, productId) { await BusinessType.updateOne({ _id: typeId, businessId: null }, { $addToSet: { productIds: productId } }); }

function offLabel(tag, taxonomy = {}) {
  const entry = taxonomy[tag]; const name = entry?.name;
  const localized = typeof name === 'string' ? name : name?.en;
  if (localized) return String(localized).trim().slice(0, 100);
  return tag.replace(/^en:/, '').replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 100);
}
async function categoryRecords(tags, dryRun, additions, signal) {
  const queue = [...tags]; const taxonomy = {}; const parentByTag = new Map();
  for (let pass = 0; queue.length && pass < 5; pass += 1) {
    const batch = [...new Set(queue.splice(0, 100))].filter((tag) => !Object.hasOwn(taxonomy, tag));
    if (!batch.length) continue;
    Object.assign(taxonomy, await taxonomyEntries('categories', batch, 'name,parents', signal));
    for (const tag of batch) {
      const parents = taxonomy[tag]?.parents;
      const parent = Array.isArray(parents) ? parents.find((value) => typeof value === 'string' && value.startsWith('en:')) : null;
      if (parent) { parentByTag.set(tag, parent); if (!Object.hasOwn(taxonomy, parent)) queue.push(parent); }
    }
  }
  const records = new Map();
  const ensure = async (tag, depth = 0) => {
    if (records.has(tag)) return records.get(tag);
    const name = offLabel(tag, taxonomy); const parentTag = depth < 5 ? parentByTag.get(tag) : null;
    const parentRecord = parentTag ? await ensure(parentTag, depth + 1) : null;
    const normalizedName = normalizeLabel(name);
    const parentId = parentRecord?.id || null;
    const key = `${parentId || parentTag || 'root'}|${normalizedName}`;
    if (additions.categoryCache.has(key)) { const cached = additions.categoryCache.get(key); records.set(tag, cached); return cached; }
    let row = await Category.findOne({ businessId: null, parentId, normalizedName }).select('_id name').lean();
    if (row) { const result = { id: String(row._id), name: row.name, isNew: false }; records.set(tag, result); additions.categoryCache.set(key, result); return result; }
    const preview = { id: null, name, parentId, parentName: parentRecord?.name || null, isNew: true };
    if (!additions.categoryPlans.has(key)) additions.categoryPlans.set(key, preview);
    if (dryRun) { records.set(tag, preview); additions.categoryCache.set(key, preview); return preview; }
    try { row = await Category.create({ businessId: null, name, normalizedName, parentId }); }
    catch (error) { if (error.code !== 11000) throw error; row = await Category.findOne({ businessId: null, parentId, normalizedName }).select('_id name').lean(); }
    const result = { id: String(row._id), name: row.name, isNew: true }; records.set(tag, result); additions.categoryCache.set(key, result); return result;
  };
  const parentTags = new Set([...parentByTag.values()]);
  const leafTags = tags.filter((tag) => !parentTags.has(tag));
  const linked = [];
  for (const tag of (leafTags.length ? leafTags : tags)) linked.push(await ensure(tag));
  return linked;
}
async function attributeRecords(pendingAttributes, dryRun, additions) {
  const ids = [];
  for (const attribute of pendingAttributes) {
    const label = [attribute.groupName, attribute.name].filter(Boolean).join(': ').slice(0, 100);
    if (!label) continue;
    const normalizedName = normalizeLabel(label);
    if (additions.attributeCache.has(normalizedName)) { const cached = additions.attributeCache.get(normalizedName); if (cached.id) ids.push(cached.id); continue; }
    let row = await Attribute.findOne({ businessId: null, normalizedName }).select('_id name').lean();
    if (row) { additions.attributeCache.set(normalizedName, { id: String(row._id), name: row.name }); ids.push(String(row._id)); continue; }
    const preview = { name: label, isNew: true };
    additions.attributePlans.set(normalizedName, preview);
    if (dryRun) { additions.attributeCache.set(normalizedName, preview); continue; }
    try { row = await Attribute.create({ businessId: null, name: label, normalizedName }); }
    catch (error) { if (error.code !== 11000) throw error; row = await Attribute.findOne({ businessId: null, normalizedName }).select('_id name').lean(); }
    additions.attributeCache.set(normalizedName, { id: String(row._id), name: row.name }); ids.push(String(row._id));
  }
  return [...new Set(ids)];
}
async function pieceUnit(dryRun, additions) {
  if (additions.unit) return additions.unit;
  let row = await Unit.findOne({ businessId: null, normalizedName: 'piece' }).select('_id name').lean();
  if (row) return (additions.unit = { id: String(row._id), name: row.name, isNew: false });
  additions.unitPlan = { name: 'Piece', symbol: 'pc', dimension: 'count', isNew: true };
  if (dryRun) return (additions.unit = { id: null, name: 'Piece', isNew: true });
  try { row = await Unit.create({ businessId: null, name: 'Piece', normalizedName: 'piece', symbol: 'pc', dimension: 'count' }); }
  catch (error) { if (error.code !== 11000) throw error; row = await Unit.findOne({ businessId: null, normalizedName: 'piece' }).select('_id name').lean(); }
  return (additions.unit = { id: String(row._id), name: row.name, isNew: true });
}

async function sync(id, options = {}) {
  assertDatabaseConnected();
  const scopeKey = String(id);
  if (activeSyncs.has(scopeKey)) throw safeError(429, 'OFF_SYNC_IN_PROGRESS', 'A synchronization for this Business Type is already running.');
  const type = await BusinessType.findOne({ _id: id, businessId: null });
  if (!type) throw safeError(404, 'BUSINESS_TYPE_NOT_FOUND', 'Business Type not found.');
  const config = type.openFoodFactsConfig;
  if (!config?.isActive) throw safeError(400, 'OFF_CONFIG_DISABLED', 'Enable and save Open Food Facts synchronization for this Business Type.');
  if (!config.countryTag) throw safeError(400, 'OFF_COUNTRY_REQUIRED', 'Save a country for this Business Type before synchronization.');
  if (!config.categoryTags?.length) throw safeError(400, 'OFF_CATEGORIES_REQUIRED', 'Save at least one category for this Business Type before synchronization.');
  const dryRun = options.dryRun === true;
  const requestedProducts = Number(options.maxProducts);
  const requestedOffset = Number(options.pageOffset ?? 0);
  if (!Number.isSafeInteger(requestedProducts) || requestedProducts < 1 || !Number.isSafeInteger(requestedOffset) || requestedOffset < 0) throw safeError(400, 'INVALID_OFF_SYNC_LIMIT', 'Enter positive whole-number product and repetition limits.');
  const maxProducts = requestedProducts;
  const pageSize = 1000;
  const pagesPerRepetition = Math.ceil(maxProducts / pageSize);
  const firstPage = requestedOffset * pagesPerRepetition + 1;
  if (!Number.isSafeInteger(firstPage)) throw safeError(400, 'INVALID_OFF_SYNC_LIMIT', 'The requested repetition is too large.');
  const summary = { scanned: 0, inserted: 0, matched: 0, skipped: 0, ambiguous: 0, failed: 0, newUnits: 0, newCategories: 0, newAttributes: 0 };
  const results = [];
  const additions = { unit: null, unitPlan: null, categoryCache: new Map(), categoryPlans: new Map(), attributeCache: new Map(), attributePlans: new Map() };
  activeSyncs.add(scopeKey);
  const startedAt = new Date();
  try {
    const codes = new Set();
    const allCategories = config.categoryTags;
    const countryTagEn = config.countryTag.replace(/^en:/, '');
    const combinedQuery = apiUrl('/api/v2/search', { countries_tags_en: countryTagEn, categories_tags: allCategories.join('|'), page: 1, page_size: pageSize, sort_by: 'product_name', fields: 'code' });
    const categoryBatches = combinedQuery.href.length <= 7000 ? [allCategories] : allCategories.map((tag) => [tag]);
    for (const categories of categoryBatches) {
      let page = firstPage;
      while (codes.size < maxProducts) {
        const remaining = maxProducts - codes.size;
        const batchPageSize = Math.min(pageSize, remaining);
        const query = apiUrl('/api/v2/search', { countries_tags_en: countryTagEn, categories_tags: categories.join('|'), page, page_size: batchPageSize, sort_by: 'product_name', fields: 'code' });
        const data = await requestJson(query, options.signal);
        const products = Array.isArray(data.products) ? data.products : [];
        const before = codes.size;
        for (const row of products) if (row?.code) codes.add(String(row.code));
        page += 1;
        if (products.length < batchPageSize || codes.size === before) break;
      }
      if (codes.size >= maxProducts) break;
    }
    for (const code of [...codes].slice(0, maxProducts)) {
      if (options.signal?.aborted) break;
      summary.scanned += 1;
      try {
        const detail = await productDetail(code, options.signal); const item = validProduct(detail);
        if (!item) { summary.skipped += 1; results.push({ code, status: 'skipped', reason: 'invalid_product_details', sourceUrl: productUrl(code) }); continue; }
        const match = await localMatch(item);
        if (match?.ambiguous) { summary.ambiguous += 1; results.push({ code, status: 'ambiguous', reason: 'multiple_name_brand_matches', name: item.name }); continue; }
        let existing = match?.product || null;
        let image = null;
        const hasImage = existing && await ProductImage.exists({ productId: existing._id });
        if (!hasImage) image = await downloadImage(item.imageUrl, options.signal);
        if (!hasImage && !image) { summary.skipped += 1; results.push({ code, status: 'skipped', reason: 'usable_image_required', name: item.name }); continue; }
        if (dryRun) {
          if (existing) summary.matched += 1; else summary.inserted += 1;
          if (!existing) {
            await pieceUnit(true, additions);
            await categoryRecords(item.categoryTags, true, additions, options.signal);
            await attributeRecords(item.pendingAttributes, true, additions);
          }
          results.push({ code, status: existing ? 'matched' : 'would_insert', matchType: match?.type || null, name: item.name, sourceUrl: productUrl(code) });
          continue;
        }
        if (!existing) {
          const unit = await pieceUnit(false, additions);
          const linkedCategories = await categoryRecords(item.categoryTags, false, additions, options.signal);
          const attributeIds = await attributeRecords(item.pendingAttributes, false, additions);
          existing = await Product.create({ businessId: null, name: item.name, normalizedName: item.normalizedName, gtin: item.code, normalizedGtin: item.code, brand: item.brand, externalSource: 'open_food_facts', externalProductId: item.code, externalProductUrl: productUrl(code), externalUpdatedAt: item.updatedAt, lastSyncedAt: new Date(), type: 'Physical', needsUnit: false, baseUnitId: unit.id, categoryIds: linkedCategories.map((category) => category.id).filter(Boolean), attributeIds, pendingAttributes: item.pendingAttributes, taxMode: 'inherit' });
          try { await addImage(existing._id, image, code); }
          catch (cause) { await Product.deleteOne({ _id: existing._id }); throw cause; }
          summary.inserted += 1;
        } else {
          if (!hasImage && image) await addImage(existing._id, image, code);
          summary.matched += 1;
        }
        await associate(type._id, existing._id);
        results.push({ code, status: match ? 'matched' : 'inserted', matchType: match?.type || null, name: item.name, sourceUrl: productUrl(code) });
      } catch (cause) {
        if (cause.code === 11000) {
          const racedProduct = await Product.findOne({ businessId: null, normalizedGtin: code });
          if (racedProduct && await ProductImage.exists({ productId: racedProduct._id })) { await associate(type._id, racedProduct._id); summary.matched += 1; results.push({ code, status: 'matched', reason: 'duplicate_insert_race' }); }
          else { summary.failed += 1; results.push({ code, status: 'failed', reason: 'duplicate_insert_race' }); }
        }
        else { summary.failed += 1; results.push({ code, status: 'failed', reason: cause.code || 'record_import_failed' }); }
      }
    }
    const finishedAt = new Date();
    const newCategories = [...additions.categoryPlans.values()];
    const newAttributes = [...additions.attributePlans.values()];
    const newUnits = additions.unitPlan ? [additions.unitPlan] : [];
    summary.newCategories = newCategories.length; summary.newAttributes = newAttributes.length; summary.newUnits = newUnits.length;
    const status = summary.failed || summary.skipped || summary.ambiguous ? 'partial' : 'completed';
    if (!dryRun && !options.signal?.aborted) await BusinessType.updateOne({ _id: type._id }, { $set: { 'openFoodFactsConfig.lastSyncAt': finishedAt, 'openFoodFactsConfig.lastSyncStatus': status, 'openFoodFactsConfig.lastSyncSummary': summary } });
    const catalogAdditions = { units: newUnits, categories: newCategories, attributes: newAttributes };
    return { status, queryScope: { countryTag: config.countryTag, categoryTags: config.categoryTags }, startedAt, finishedAt, dryRun, summary, plannedCatalogAdditions: dryRun ? catalogAdditions : undefined, catalogAdditions, results };
  } finally { activeSyncs.delete(scopeKey); }
}

module.exports = { saveConfig, taxonomySuggestions, sync };
