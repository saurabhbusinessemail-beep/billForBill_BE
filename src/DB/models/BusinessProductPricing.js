'use strict';
const mongoose = require('mongoose');
const { rateModes } = require('../../services/serviceMeasurement');
const variantPriceSchema = new mongoose.Schema({
  variantKey: { type: String, required: true },
  basis: { type: String, enum: rateModes, required: true },
  sellingPrice: { type: mongoose.Schema.Types.Decimal128, default: null },
  purchaseCost: { type: mongoose.Schema.Types.Decimal128, default: null },
}, { _id: false });
const ruleSchema = new mongoose.Schema({
  customerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  minimumQuantity: { type: Number, min: 1, default: null },
  sellingPrice: { type: mongoose.Schema.Types.Decimal128, required: true },
  active: { type: Boolean, default: true },
}, { timestamps: true });
const schema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessCatalogProduct', required: true },
  purchaseCost: { type: mongoose.Schema.Types.Decimal128, default: null },
  taxInclusive: { type: Boolean, default: true },
  separateTaxAmount: { type: mongoose.Schema.Types.Decimal128, default: null },
  separateTaxId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessCatalogTax', default: null },
  defaultSellingPrice: { type: mongoose.Schema.Types.Decimal128, default: null },
  variantPrices: { type: [variantPriceSchema], default: [] },
  rules: { type: [ruleSchema], default: [] },
  version: { type: Number, default: 1, min: 1 },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ businessId: 1, productId: 1 }, { unique: true });
schema.index({ businessId: 1, 'rules.customerUserId': 1, productId: 1 });
module.exports = mongoose.models.BusinessProductPricing || mongoose.model('BusinessProductPricing', schema);
