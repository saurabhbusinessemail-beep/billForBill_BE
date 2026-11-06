'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  code: { type: String, required: true, trim: true, maxlength: 40 },
  discountType: { type: String, required: true, enum: ['percent', 'flat'] },
  amount: { type: Number, required: true, min: 0 },
  planIds: [{ type: Schema.Types.ObjectId, ref: 'Plan' }],
  userIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  businessIds: [{ type: Schema.Types.ObjectId, ref: 'Business' }],
  businessTypeIds: [{ type: Schema.Types.ObjectId, ref: 'BusinessType' }],
  validTill: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.models.PlanOffer || mongoose.model('PlanOffer', schema);
