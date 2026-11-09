'use strict';

const mongoose = require('mongoose');
const { productFields, legacyProductFields, legacyUnitReferences, validateLegacyUnits } = require('./productFields');
const { ObjectId, Decimal128 } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  businessId: { type: ObjectId, ref: 'Business', required: true, index: true },
  ...productFields,
  sourceProductId: { type: ObjectId, ref: 'CatalogProduct', default: null, index: true },
  mrpPricingPending: { type: Boolean, select: false },
  code: { type: String, trim: true, maxlength: 40, default: '' },
  normalizedCode: { type: String, trim: true, uppercase: true, maxlength: 40, default: '' },
  categoryIds: [{ type: ObjectId, ref: 'BusinessCatalogCategory' }],
  attributeIds: [{ type: ObjectId, ref: 'BusinessCatalogAttribute' }],
  taxComponentIds: [{ type: ObjectId, ref: 'BusinessCatalogTax' }],
  ...legacyProductFields,
  ...legacyUnitReferences('BusinessCatalogUnit'),
  reorderLevel: Decimal128,
}, { timestamps: true });

validateLegacyUnits(schema);
schema.index({ businessId: 1, normalizedCode: 1 }, { unique: true, partialFilterExpression: { normalizedCode: { $type: 'string', $gt: '' } } });
schema.index({ businessId: 1, variantIdentifierKeys: 1 }, { unique: true, partialFilterExpression: { variantIdentifierKeys: { $type: 'string' } } });
module.exports = mongoose.models.BusinessCatalogProduct || mongoose.model('BusinessCatalogProduct', schema);
