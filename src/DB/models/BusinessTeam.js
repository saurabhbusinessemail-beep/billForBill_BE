'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true }, name: { type: String, required: true, trim: true, maxlength: 100 }, normalizedName: { type: String, required: true }, description: { type: String, trim: true, maxlength: 500, default: '' }, createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true } }, { timestamps: true });
schema.index({ businessId:  1, normalizedName: 1 }, { unique: true }); schema.index({ businessId: 1, createdAt: 1 });
module.exports = mongoose.models.BusinessTeam || mongoose.model('BusinessTeam', schema);
