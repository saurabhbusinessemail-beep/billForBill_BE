'use strict';

const { Schema } = require('mongoose');
const variation = require('./productVariationFields');
const { serviceModes } = require('../../services/serviceMeasurement');

const productFields = {
  name: { type: String, required: true, trim: true, maxlength: 160 },
  title: { type: String, trim: true, maxlength: 160 },
  brand: { type: String, trim: true, maxlength: 120 },
  attributes: { type: [String], default: [] },
  variations: { type: [variation], default: undefined },

  normalizedName: { type: String, required: true, trim: true, lowercase: true, index: true },
  type: { type: String, required: true, trim: true, maxlength: 50 },
  serviceMeasurement: { type: String, enum: serviceModes },
  taxMode: { type: String, enum: ['inherit', 'specific'], default: 'inherit' },
  legacyStockVariantKey: String,
  variantIdentifierKeys: { type: [String], default: undefined, select: false },
};

// Compatibility paths for existing documents and repair tooling.
const legacyProductFields = {
  ...require('./productUnitFields'),
  variants: Schema.Types.Mixed,
  barcode: String,
  gtin: String,
  normalizedGtin: String,
  mrp: Schema.Types.Decimal128,
  description: { type: String, trim: true, maxlength: 1000 },
  needsUnit: Boolean,
};

function legacyUnitReferences(unitModel) {
  return {
    baseUnitId: { type: Schema.Types.ObjectId, ref: unitModel },
    additionalUnits: {
      type: [{
        unitId: { type: Schema.Types.ObjectId, ref: unitModel, required: true },
        conversionFactor: { type: Number, required: true, min: Number.MIN_VALUE },
      }],
      default: undefined,
    },
  };
}

function validateLegacyUnits(schema) {
  schema.pre('validate', function () {
    if (this.baseUnit && (this.isNew || ['baseUnit', 'units', 'quantityVariants'].some(field => this.isModified(field)))) {
      this.set(require('../../services/productUnits').normalize(this, this.needsUnit === true));
    }
  });
}

module.exports = { productFields, legacyProductFields, legacyUnitReferences, validateLegacyUnits };
