'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null, index: true }, name: { type: String, required: true, trim: true, maxlength: 100 }, normalizedName: { type: String, required: true, trim: true, lowercase: true }, description: { type: String, trim: true, maxlength: 500, default: '' }, productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct' }], taxComponentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxComponent' }] }, { timestamps: true });
schema.index({ businessId: 1, normalizedName: 1 }, { unique: true });
module.exports = mongoose.models.BusinessType || mongoose.model('BusinessType', schema);
