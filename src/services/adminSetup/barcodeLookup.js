'use strict';

const { error, normalizeGtin } = require('./catalogCommon.service');
const { defaultCurrency } = require('../businessCurrency');

let nextRequestAt = 0;

async function lookup(value, currency = defaultCurrency) {
  if (typeof value !== 'string') throw error(400, 'INVALID_GTIN', 'Enter a barcode to look up.');
  const gtin = normalizeGtin(value);
  if (!gtin) throw error(400, 'INVALID_GTIN', 'Enter a barcode to look up.');
  const now = Date.now();
  if (now < nextRequestAt) throw error(429, 'BARCODE_LOOKUP_RATE_LIMITED', 'Wait before looking up another barcode.');
  nextRequestAt = now + 10_000;

  const url = new URL('https://api.upcitemdb.com/prod/trial/lookup');
  url.searchParams.set('upc', gtin);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'error' });
    if (response.status === 404) return null;
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) nextRequestAt = Math.max(nextRequestAt, Date.now() + retryAfter * 1000);
      throw error(429, 'BARCODE_LOOKUP_RATE_LIMITED', 'The barcode lookup service is temporarily rate limited.');
    }
    if (!response.ok) throw new Error('Unexpected barcode lookup response.');
    const { items } = await response.json();
    if (!Array.isArray(items)) throw new Error('Invalid barcode lookup response.');
    const item = items.find(entry => [entry?.ean, entry?.upc, entry?.gtin].some(code =>
      typeof code === 'string' && /^\d+$/.test(code) && code.padStart(14, '0') === gtin.padStart(14, '0')));
    if (!item) return null;
    const field = (key, limit) => typeof item[key] === 'string' ? item[key].trim().slice(0, limit) : '';
    const low = item.lowest_recorded_price;
    const high = item.highest_recorded_price;
    const priceCurrency = typeof item.currency === 'string' ? item.currency.trim().toUpperCase() : '';
    const mrp = (priceCurrency || defaultCurrency) === currency
      && Number.isFinite(low) && Number.isFinite(high) && low >= 0 && high >= low && high < 1e12
      ? ((low + high) / 2).toFixed(2) : null;
    const images = (Array.isArray(item.images) ? item.images : []).filter(value => {
      if (typeof value !== 'string' || value.length > 2048) return false;
      try {
        const image = new URL(value);
        return image.protocol === 'https:' && !image.username && !image.password;
      } catch { return false; }
    }).slice(0, 5);
    return {
      gtin,
      title: field('title', 160),
      mrp,
      brand: field('brand', 120),
      images,
      attributes: Object.fromEntries(['model', 'color', 'size', 'dimension', 'weight']
        .map(key => [key, field(key, 160)]).filter(([, value]) => value)),
    };
  } catch (cause) {
    if (cause.code === 'BARCODE_LOOKUP_RATE_LIMITED') throw cause;
    throw error(502, 'BARCODE_LOOKUP_UNAVAILABLE', 'Barcode lookup is temporarily unavailable.');
  }
}

module.exports = { lookup };
