'use strict';

const { Schema } = require('mongoose');
const { baseUnit, units, quantityVariants } = require('./productUnitFields');

const variant = new Schema({
  baseUnit,
  additionalUnits: units,
  quantityVariants,
  needsUnit: { type: Boolean, default: undefined },
  reorderLevel: { type: Schema.Types.Decimal128, default: undefined },
  key: { type: String, required: true },
  values: { type: Map, of: String, default: () => ({}) },
  barcode: String,
  gtin: String,
  normalizedGtin: String,
  mrp: Schema.Types.Decimal128,
}, { _id: false });

module.exports = variant;
