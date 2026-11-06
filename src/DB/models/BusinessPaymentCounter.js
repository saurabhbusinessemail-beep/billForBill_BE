'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true }, value: { type: Number, default: 1000, min: 1000 } }, { timestamps: true });
schema.index({ businessId: 1 }, { unique: true });
module.exports = mongoose.models.BusinessPaymentCounter || mongoose.model('BusinessPaymentCounter', schema);
