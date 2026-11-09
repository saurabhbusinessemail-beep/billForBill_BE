'use strict';

function normalizeGstin(value) {
  if (value == null) return '';
  const gstin = typeof value === 'string' ? value.trim() : null;
  if (gstin === '' || (gstin && /^[A-Za-z0-9]{15}$/.test(gstin))) return gstin.toUpperCase();
  throw Object.assign(new Error('Enter a GSTIN with 15 letters and digits.'), { statusCode: 400, code: 'INVALID_GSTIN', expose: true });
}

module.exports = { normalizeGstin };
