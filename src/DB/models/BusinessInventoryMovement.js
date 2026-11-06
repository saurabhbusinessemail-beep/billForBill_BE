'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessCatalogProduct', required: true },
  productName: { type: String, required: true, maxlength: 160 },
  direction: { type: String, enum: ['in', 'out'], required: true },
  quantity: { type: mongoose.Schema.Types.Decimal128, required: true },
  unitId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessCatalogUnit', required: true },
  unitName: { type: String, required: true, maxlength: 100 },
  unitSymbol: { type: String, required: true, maxlength: 24 },
  conversionFactor: { type: Number, required: true, min: Number.MIN_VALUE },
  stockQuantity: { type: mongoose.Schema.Types.Decimal128, required: true },
  stockUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessCatalogUnit', required: true },
  stockUnitName: { type: String, required: true, maxlength: 100 },
  effectiveDate: { type: Date, required: true },
  reason: { type: String, enum: ['opening', 'purchase', 'sale', 'damage', 'count', 'correction', 'other'], required: true },
  note: { type: String, maxlength: 500, default: '' },
  source: { type: String, enum: ['adjustment', 'bill', 'bill_compensation'], required: true, default: 'adjustment' },
  sourceBillId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessBill', default: null },
  sourceBillLineId: { type: String, default: null },
  sourceEventKey: { type: String, default: null },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ businessId: 1, productId: 1, effectiveDate: 1, _id: 1 });
schema.index({ businessId: 1, sourceEventKey: 1 }, { unique: true, partialFilterExpression: { sourceEventKey: { $type: 'string' } } });
module.exports = mongoose.models.BusinessInventoryMovement || mongoose.model('BusinessInventoryMovement', schema);
