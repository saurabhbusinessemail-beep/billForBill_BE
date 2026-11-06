'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true }, lockId: { type: String, required: true }, expiresAt: { type: Date, required: true } }, { timestamps: true });
module.exports = mongoose.models.BusinessFinancialLock || mongoose.model('BusinessFinancialLock', schema);
