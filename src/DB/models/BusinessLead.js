'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  leadNumber: { type: String, required: true, trim: true },
  status: { type: String, enum: ['open', 'ordered', 'billed', 'delivered', 'converted', 'cancelled'], default: 'open' },
  contactUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  contactSnapshot: { type: Schema.Types.Mixed, default: null },
  documentDate: { type: String, required: true },
  createdAtClient: { type: String, required: true },
  currencyCode: { type: String, uppercase: true, trim: true, maxlength: 3, default: null },
  currencyScale: { type: Number, min: 0, max: 6, default: null },
  lines: { type: [Schema.Types.Mixed], default: [] },
  subtotal: { type: Schema.Types.Decimal128, default: null },
  discounts: { type: [Schema.Types.Mixed], default: [] },
  discountTotal: { type: Schema.Types.Decimal128, default: null },
  afterDiscount: { type: Schema.Types.Decimal128, default: null },
  taxes: { type: [Schema.Types.Mixed], default: [] },
  taxSelectionSet: { type: Boolean, default: false },
  taxTotal: { type: Schema.Types.Decimal128, default: null },
  grandTotal: { type: Schema.Types.Decimal128, default: null },
  version: { type: Number, default: 1, min: 1 },
  convertedOrderId: { type: Schema.Types.ObjectId, ref: 'BusinessOrder', default: null },
  orderStatus: { type: String, enum: ['open', 'confirmed', 'billed', 'delivered', 'completed_billed', 'cancelled'], default: null },
  billStatus: { type: String, enum: ['draft', 'confirmed', 'delivered', 'cancelled'], default: null },
  billGeneratedAt: { type: Date, default: null },
  deliveryCompleted: { type: Boolean, default: false },
  conversionMode: { type: String, enum: ['order', 'bill'], default: null },
  lifecycleEvents: { type: [Schema.Types.Mixed], default: [] },
  deletedAt: { type: Date, default: null },
  deletedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  cancelledAt: { type: Date, default: null },
  cancelledByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  idempotencyKey: { type: String, default: null, maxlength: 120 },
  createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, minimize: false });
schema.index({ businessId: 1, leadNumber: 1 }, { unique: true });
schema.index({ businessId: 1, status: 1, documentDate: -1 });
schema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
module.exports = mongoose.models.BusinessLead || mongoose.model('BusinessLead', schema);
