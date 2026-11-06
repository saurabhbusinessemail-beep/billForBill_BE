'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  deliveryNumber: { type: String, required: true }, status: { type: String, enum: ['draft', 'on_move', 'delivered', 'cancelled'], default: 'draft', index: true },
  sourceType: { type: String, enum: ['order', 'party'], required: true }, orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessOrder', default: null }, billId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessBill', default: null },
  partyUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, partyName: { type: String, trim: true, maxlength: 120, default: '' }, partyPhone: { type: String, trim: true, maxlength: 40, default: '' },
  deliveryDate: { type: String, required: true }, fromAddress: { type: String, trim: true, maxlength: 1000, default: '' }, toAddress: { type: String, trim: true, maxlength: 1000, default: '' },
  transportType: { type: String, trim: true, maxlength: 40, default: '' }, transportDetails: { type: mongoose.Schema.Types.Mixed, default: {} }, legs: { type: [mongoose.Schema.Types.Mixed], default: [] }, events: { type: [mongoose.Schema.Types.Mixed], default: [] }, completedAt: { type: Date, default: null },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, minimize: false });
schema.index({ businessId: 1, deliveryNumber: 1 }, { unique: true });
module.exports = mongoose.models.BusinessDelivery || mongoose.model('BusinessDelivery', schema);
