'use strict';

const mongoose = require('mongoose');

const businessLogoSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  originalName: { type: String, required: true, maxlength: 255 },
  contentType: { type: String, required: true, enum: ['image/jpeg', 'image/png', 'image/webp'] },
  sizeBytes: { type: Number, required: true, min: 1, max: 1024 * 1024 },
  data: { type: Buffer, required: true, select: false },
}, { timestamps: true });

businessLogoSchema.index({ ownerUserId: 1, businessId: 1 });

module.exports = mongoose.models.BusinessLogo || mongoose.model('BusinessLogo', businessLogoSchema);
