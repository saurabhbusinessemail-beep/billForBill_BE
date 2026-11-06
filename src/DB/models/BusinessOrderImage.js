'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
// Binary content is stored in the dedicated businessOrderImages GridFS bucket so normal phone photos can exceed BSON's 16 MiB document limit.
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'BusinessOrder', required: true },
  fileId: { type: Schema.Types.ObjectId, required: true, unique: true },
  filename: { type: String, required: true, maxlength: 180 },
  contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true },
  size: { type: Number, required: true, min: 1, max: 20 * 1024 * 1024 },
  width: { type: Number, required: true, min: 1, max: 30000 },
  height: { type: Number, required: true, min: 1, max: 30000 },
  checksum: { type: String, required: true, maxlength: 64 },
  uploadedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ businessId: 1, orderId: 1, createdAt: 1 });
module.exports = mongoose.models.BusinessOrderImage || mongoose.model('BusinessOrderImage', schema);
