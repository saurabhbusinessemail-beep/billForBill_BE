'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null, index: true }, name: { type: String, required: true, trim: true, maxlength: 100 }, normalizedName: { type: String, required: true, trim: true, lowercase: true }, calculationType: { type: String, enum: ['percentage', 'fixed'], required: true }, value: { type: Number, required: true, min: 0 }, currency: { type: String, uppercase: true, trim: true, maxlength: 3, default: '' }, effectiveStart: { type: Date, required: true }, effectiveEnd: { type: Date, default: null }, jurisdiction: { type: String, trim: true, maxlength: 100, default: '' }, description: { type: String, trim: true, maxlength: 500, default: '' } }, { timestamps: true });
schema.index({ businessId: 1, normalizedName: 1 }, { unique: true });
module.exports = mongoose.models.TaxComponent || mongoose.model('TaxComponent', schema);
