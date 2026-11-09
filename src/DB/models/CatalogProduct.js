'use strict';

const mongoose = require('mongoose');
const { productFields, legacyProductFields, legacyUnitReferences, validateLegacyUnits } = require('./productFields');
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  businessId: { type: ObjectId, ref: 'Business', default: null, index: true },
  ...productFields,
  categoryIds: [{ type: ObjectId, ref: 'ProductCategory' }],
  attributeIds: [{ type: ObjectId, ref: 'ProductAttribute' }],
  taxComponentIds: [{ type: ObjectId, ref: 'TaxComponent' }],
  ...legacyProductFields,
  ...legacyUnitReferences('CatalogUnit'),
}, { timestamps: true });

validateLegacyUnits(schema);
schema.index({ variantIdentifierKeys: 1 }, { unique: true, partialFilterExpression: { variantIdentifierKeys: { $type: 'string' } } });
module.exports = mongoose.models.CatalogProduct || mongoose.model('CatalogProduct', schema);
