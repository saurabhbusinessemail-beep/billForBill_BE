'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  extraCreditPackId: { type: Schema.Types.ObjectId, ref: 'ExtraCreditPack', required: true },
  packSnapshot: { type: Schema.Types.Mixed, required: true },
  amountPaid: { type: Number, required: true, min: 0 },
  paymentStatus: { type: String, enum: ['completed'], default: 'completed' },
  idempotencyKey: { type: String, required: true, maxlength: 120 },
  purchasedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ businessId: 1, createdAt: 1 });
module.exports = mongoose.models.BusinessExtraCreditPurchase || mongoose.model('BusinessExtraCreditPurchase', schema);
