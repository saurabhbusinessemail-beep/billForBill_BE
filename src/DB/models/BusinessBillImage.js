'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true }, billId: { type: mongoose.Schema.Types.ObjectId, ref: 'BusinessBill', required: true }, fileId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true }, filename: { type: String, required: true, maxlength: 180 }, contentType: { type: String, enum: ['image/jpeg', 'image/png', 'application/pdf'], required: true }, size: { type: Number, required: true }, checksum: { type: String, required: true }, uploadedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, deletedAt: { type: Date, default: null } }, { timestamps: true });
schema.index({ businessId: 1, billId: 1, createdAt: 1 });
module.exports = mongoose.models.BusinessBillImage || mongoose.model('BusinessBillImage', schema);
