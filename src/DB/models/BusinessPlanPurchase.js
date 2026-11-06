'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  planId: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
  planSnapshot: { type: Schema.Types.Mixed, required: true },
  effectiveMonth: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  offerSnapshot: { type: Schema.Types.Mixed, default: null },
  amountPaid: { type: Number, required: true, min: 0 },
  paymentStatus: { type: String, enum: ['completed'], default: 'completed' },
  idempotencyKey: { type: String, required: true, maxlength: 120 },
  purchasedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ businessId: 1, effectiveMonth: -1, createdAt: -1 });
module.exports = mongoose.models.BusinessPlanPurchase || mongoose.model('BusinessPlanPurchase', schema);
