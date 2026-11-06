'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ operationId: { type: String, required: true, unique: true }, businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true }, userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, workbookType: { type: String, enum: ['selling', 'purchase'], required: true }, digest: { type: String, required: true }, parsedData: { type: mongoose.Schema.Types.Mixed, required: true }, errors: { type: [mongoose.Schema.Types.Mixed], default: [] }, expiresAt: { type: Date, required: true }, committedAt: { type: Date, default: null } }, { timestamps: true, collection: 'pricingimportsessions' });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ businessId: 1, userId: 1, createdAt: -1 });
module.exports = connection => connection.models.PricingImportSession || connection.model('PricingImportSession', schema);
