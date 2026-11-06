'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  paymentId: { type: Schema.Types.ObjectId, ref: 'BusinessPayment', required: true },
  event: { type: String, enum: ['payment', 'reversal'], required: true },
  currencyCode: { type: String, required: true },
  amount: { type: Schema.Types.Decimal128, required: true },
  entries: { type: [Schema.Types.Mixed], required: true },
  actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ businessId: 1, paymentId: 1, event: 1 }, { unique: true });
module.exports = mongoose.models.BusinessPaymentJournal || mongoose.model('BusinessPaymentJournal', schema);
