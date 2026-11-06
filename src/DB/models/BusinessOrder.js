'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  orderNumber: { type: String, required: true, trim: true },
  orderType: { type: String, enum: ['sales', 'purchase'], required: true },
  entryMode: { type: String, enum: ['detailed', 'image_only'], default: 'detailed' },
  status: { type: String, enum: ['open', 'confirmed', 'billed', 'delivered', 'completed_billed', 'cancelled'], default: 'open' },
  billStatus: { type: String, enum: ['draft', 'confirmed', 'delivered', 'cancelled'], default: null },
  billGeneratedAt: { type: Date, default: null },
  confirmedAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  deliveryCompleted: { type: Boolean, default: false },
  sourceLeadId: { type: Schema.Types.ObjectId, ref: 'BusinessLead', default: null },
  conversionMode: { type: String, enum: ['order', 'bill'], default: null },
  contactType: { type: String, enum: ['customer', 'supplier'], default: null },
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
  imageAmounts: { type: Schema.Types.Mixed, default: null },
  imageIds: [{ type: Schema.Types.ObjectId }],
  imageMetadata: { type: [Schema.Types.Mixed], default: [] },
  version: { type: Number, default: 1, min: 1 },
  idempotencyKey: { type: String, default: null, maxlength: 120 },
  lifecycleEvents: { type: [Schema.Types.Mixed], default: [] },
  deletedAt: { type: Date, default: null },
  deletedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  cancelledAt: { type: Date, default: null },
  cancelledByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, minimize: false });

schema.index({ businessId: 1, orderNumber: 1 }, { unique: true });
schema.index({ businessId: 1, sourceLeadId: 1 }, { unique: true, partialFilterExpression: { sourceLeadId: { $type: 'objectId' } } });
schema.index({ businessId: 1, status: 1, documentDate: -1 });
schema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
module.exports = mongoose.models.BusinessOrder || mongoose.model('BusinessOrder', schema);
