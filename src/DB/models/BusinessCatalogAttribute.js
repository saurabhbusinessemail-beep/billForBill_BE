'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true }, name: { type: String, required: true, trim: true, maxlength: 100 }, normalizedName: { type: String, required: true, trim: true, lowercase: true }, unitIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'BusinessCatalogUnit' }] }, { timestamps: true });
schema.index({ businessId: 1, normalizedName: 1 }, { unique: true });
module.exports = mongoose.models.BusinessCatalogAttribute || mongoose.model('BusinessCatalogAttribute', schema);
