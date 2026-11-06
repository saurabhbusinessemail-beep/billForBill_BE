'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, maxlength: 40 },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  price: { type: Number, required: true, min: 0 },
  billCount: { type: Number, required: true, min: 1, validate: Number.isInteger },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.models.ExtraCreditPack || mongoose.model('ExtraCreditPack', schema);
