'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  monthlyPrice: { type: Number, required: true, min: 0 },
  includedBills: { type: Number, required: true, min: 0, validate: Number.isInteger },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.models.Plan || mongoose.model('Plan', schema);
