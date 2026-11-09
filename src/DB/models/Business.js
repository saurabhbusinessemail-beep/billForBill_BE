'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;
const { defaultCurrency, supportedCurrencies } = require('../../services/businessCurrency');

const businessSchema = new mongoose.Schema({
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  creationRequestKey: { type: String, default: null, maxlength: 100 },
  businessTypeId: { type: Schema.Types.ObjectId, ref: 'BusinessType', default: null },
  timeZone: { type: String, trim: true, maxlength: 80, default: process.env.BUSINESS_DEFAULT_TIME_ZONE || 'Asia/Kolkata' },
  currencyCode: { type: String, enum: supportedCurrencies, default: defaultCurrency },
  catalogCopyState: { type: String, enum: ['pending', 'complete'], default: 'complete', index: true },
  catalogProvenance: { type: Schema.Types.Mixed, default: null },
  businessTaxComponentIds: [{ type: Schema.Types.ObjectId, ref: 'BusinessCatalogTax' }],
  legalName: { type: String, required: true, trim: true, maxlength: 200 },
  registrationId: { type: String, trim: true, maxlength: 100, default: '' },
  gstin: { type: String, trim: true, uppercase: true, maxlength: 15, default: '' },
  phone: { type: String, trim: true, maxlength: 40, default: '' },
  email: { type: String, trim: true, lowercase: true, maxlength: 254, default: '' },
  website: { type: String, trim: true, maxlength: 2048, default: '' },
  address: { type: String, trim: true, maxlength: 1000, default: '' },
}, { timestamps: true });

businessSchema.index({ ownerUserId: 1, createdAt: 1 });
businessSchema.index({ gstin: 1 }, { unique: true, partialFilterExpression: { gstin: { $gt: '' } } });
businessSchema.index({ ownerUserId: 1, creationRequestKey: 1 }, { unique: true, partialFilterExpression: { creationRequestKey: { $type: 'string' } } });

module.exports = mongoose.models.Business || mongoose.model('Business', businessSchema);
