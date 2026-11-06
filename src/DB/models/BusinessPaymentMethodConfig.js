'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true }, fields: { type: mongoose.Schema.Types.Mixed, default: { cash: { paidBy: 'optional' }, upi: { upiId: 'optional', transactionReference: 'optional' }, card: { lastFour: 'optional', approvalCode: 'optional' }, bank_transfer: { reference: 'optional', bankName: 'optional' } } }, updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true } }, { timestamps: true, minimize: false });
module.exports = mongoose.models.BusinessPaymentMethodConfig || mongoose.model('BusinessPaymentMethodConfig', schema);
