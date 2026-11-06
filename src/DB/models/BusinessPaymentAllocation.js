'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  paymentId: { type: Schema.Types.ObjectId, ref: 'BusinessPayment', required: true },
  billId: { type: Schema.Types.ObjectId, ref: 'BusinessBill', required: true },
  amount: { type: Schema.Types.Decimal128, required: true },
  kind: { type: String, enum: ['payment', 'advance_credit'], default: 'payment' },
  sourcePaymentId: { type: Schema.Types.ObjectId, ref: 'BusinessPayment', default: null },
  reversedAt: { type: Date, default: null },
  reversedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ businessId: 1, billId: 1, createdAt: 1 });
schema.index({ businessId: 1, paymentId: 1 });
schema.index({ billId: 1, reversedAt: 1, createdAt: 1 });
module.exports = mongoose.models.BusinessPaymentAllocation || mongoose.model('BusinessPaymentAllocation', schema);
