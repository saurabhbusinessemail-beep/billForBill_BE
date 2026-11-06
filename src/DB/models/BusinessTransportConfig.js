'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true }, fields: { type: mongoose.Schema.Types.Mixed, default: {} }, updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null } }, { timestamps: true });
module.exports = mongoose.models.BusinessTransportConfig || mongoose.model('BusinessTransportConfig', schema);
