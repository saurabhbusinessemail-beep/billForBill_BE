'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const businessSchema = new mongoose.Schema({
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  creationRequestKey: { type: String, default: null, maxlength: 100 },
  businessTypeId: { type: Schema.Types.ObjectId, ref: 'BusinessType', default: null },
  catalogCopyState: { type: String, enum: ['pending', 'complete'], default: 'complete', index: true },
  catalogProvenance: { type: Schema.Types.Mixed, default: null },
  businessTaxComponentIds: [{ type: Schema.Types.ObjectId, ref: 'BusinessCatalogTax' }],
  legalName: { type: String, required: true, trim: true, maxlength: 200 },
  registrationId: { type: String, trim: true, maxlength: 100, default: '' },
  phone: { type: String, trim: true, maxlength: 40, default: '' },
  email: { type: String, trim: true, lowercase: true, maxlength: 254, default: '' },
  website: { type: String, trim: true, maxlength: 2048, default: '' },
  address: { type: String, trim: true, maxlength: 1000, default: '' },
}, { timestamps: true });

businessSchema.index({ ownerUserId: 1, createdAt: 1 });
businessSchema.index({ ownerUserId: 1, creationRequestKey: 1 }, { unique: true, partialFilterExpression: { creationRequestKey: { $type: 'string' } } });

module.exports = mongoose.models.Business || mongoose.model('Business', businessSchema);
