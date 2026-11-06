'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true }, userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true } }, { timestamps: true });
schema.index({ businessId: 1, userId: 1 }, { unique: true }); schema.index({ businessId: 1, createdAt: 1 });
module.exports = mongoose.models.BusinessMembership || mongoose.model('BusinessMembership', schema);
