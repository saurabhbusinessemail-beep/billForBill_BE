'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const billSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  billType: { type: String, enum: ['sale', 'purchase'], required: true },
  entryMode: { type: String, enum: ['detailed', 'image'], required: true },
  status: { type: String, enum: ['draft', 'issued', 'cancelled'], default: 'draft', index: true },
  deliveryStatus: { type: String, enum: ['draft', 'in_transit', 'delivered', 'received', 'cancelled'], default: 'draft', index: true },
  planId: { type: String, default: null, index: true },
  billNumber: { type: String, default: null, trim: true },
  sequenceNumber: { type: Number, default: null },
  billDate: { type: String, required: true },
  dueDate: { type: String, required: true },
  partyUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  gstin: { type: String, trim: true, uppercase: true, maxlength: 15, default: '' },
  recipientBusinessId: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
  partySnapshot: { type: Schema.Types.Mixed, required: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'BusinessOrder', default: null },
  leadId: { type: Schema.Types.ObjectId, ref: 'BusinessLead', default: null },
  currencyCode: { type: String, uppercase: true, trim: true, maxlength: 3, default: null },
  currencyScale: { type: Number, default: 2 },
  lines: { type: [Schema.Types.Mixed], default: [] },
  discounts: { type: [Schema.Types.Mixed], default: [] },
  afterDiscount: { type: Schema.Types.Decimal128, default: null },
  taxes: { type: [Schema.Types.Mixed], default: [] },
  imageAmounts: { type: Schema.Types.Mixed, default: null },
  subtotal: { type: Schema.Types.Decimal128, required: true },
  discountTotal: { type: Schema.Types.Decimal128, default: '0' },
  taxTotal: { type: Schema.Types.Decimal128, default: '0' },
  grandTotal: { type: Schema.Types.Decimal128, required: true },
  imageIds: [{ type: Schema.Types.ObjectId }],
  imageMetadata: { type: [Schema.Types.Mixed], default: [] },
  deliveredAtIssue: { type: Boolean, default: false },
  inventoryCycle: { type: Number, default: 0 },
  inventoryPosted: { type: Boolean, default: false },
  version: { type: Number, default: 1 },
  idempotencyKey: { type: String, default: null },
  lifecycleEvents: { type: [Schema.Types.Mixed], default: [] },
  issuedAt: { type: Date, default: null },
  issuedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  cancelledAt: { type: Date, default: null },
  cancelledByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  deletedAt: { type: Date, default: null },
  deletedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, minimize: false });
billSchema.index({ businessId: 1, billNumber: 1 }, { unique: true, partialFilterExpression: { billNumber: { $type: 'string' } } });
billSchema.index({ businessId: 1, billType: 1, status: 1, billDate: -1 });
billSchema.index({ businessId: 1, planId: 1, status: 1, issuedAt: 1 });
billSchema.index({ businessId: 1, orderId: 1 }, { unique: true, partialFilterExpression: { orderId: { $type: 'objectId' }, status: { $in: ['draft', 'issued'] } } });
billSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
billSchema.index({ businessId: 1, partyUserId: 1, dueDate: 1 });
billSchema.index({ partyUserId: 1, billType: 1, status: 1, billDate: -1, _id: -1 });
billSchema.index({ recipientBusinessId: 1, billDate: -1, _id: -1 }, { partialFilterExpression: { recipientBusinessId: { $type: 'objectId' } } });
billSchema.index({ gstin: 1, recipientBusinessId: 1 }, { partialFilterExpression: { gstin: { $gt: '' } } });
billSchema.pre('validate', function validateIssuedPlanId() {
  if (this.status === 'issued' && !this.planId && (this.isNew || this.isModified('status'))) this.invalidate('planId', 'Issued bills must reference a plan or extra-credit entitlement.', 'PLAN_ID_REQUIRED');
});
module.exports = mongoose.models.BusinessBill || mongoose.model('BusinessBill', billSchema);
