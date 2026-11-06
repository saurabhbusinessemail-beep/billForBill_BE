'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  paymentNumber: { type: String, required: true, trim: true },
  direction: { type: String, enum: ['incoming', 'outgoing'], required: true },
  partyUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  partySnapshot: { type: Schema.Types.Mixed, required: true },
  amount: { type: Schema.Types.Decimal128, required: true },
  currencyCode: { type: String, required: true, uppercase: true },
  paymentDate: { type: String, required: true },
  method: { type: String, enum: ['cash', 'upi', 'card', 'bank_transfer'], required: true },
  methodDetails: { type: Schema.Types.Mixed, default: {} },
  methodConfigurationSnapshot: { type: Schema.Types.Mixed, default: {} },
  note: { type: String, maxlength: 1000, default: '' },
  idempotencyKey: { type: String, required: true, maxlength: 120 },
  status: { type: String, enum: ['recorded', 'reversed'], default: 'recorded' },
  reversalReason: { type: String, maxlength: 500, default: '' },
  reversedAt: { type: Date, default: null },
  reversedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, minimize: false });
schema.index({ businessId: 1, paymentNumber: 1 }, { unique: true });
schema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ businessId: 1, paymentDate: -1, _id: -1 });
schema.index({ partyUserId: 1, direction: 1, status: 1, businessId: 1 });
module.exports = mongoose.models.BusinessPayment || mongoose.model('BusinessPayment', schema);
