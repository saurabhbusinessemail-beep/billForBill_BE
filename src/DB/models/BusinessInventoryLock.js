'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true }, productId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessCatalogProduct', required: true }, lockId: { type: String, required: true }, expiresAt: { type: Date, required: true } }, { timestamps: true });
schema.index({ businessId: 1, productId: 1 }, { unique: true });
module.exports = mongoose.models.BusinessInventoryLock || mongoose.model('BusinessInventoryLock', schema);
