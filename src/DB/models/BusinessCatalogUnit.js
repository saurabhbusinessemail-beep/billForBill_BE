'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true }, name: { type: String, required: true, trim: true, maxlength: 100 }, normalizedName: { type: String, required: true, trim: true, lowercase: true }, symbol: { type: String, required: true, trim: true, maxlength: 24 }, dimension: { type: String, trim: true, maxlength: 50, default: 'other' } }, { timestamps: true });
schema.index({ businessId: 1, normalizedName: 1 }, { unique: true });
module.exports = mongoose.models.BusinessCatalogUnit || mongoose.model('BusinessCatalogUnit', schema);
