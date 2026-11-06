'use strict';

const mongoose = require('mongoose');

const rateLimitWindowSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, required: true, default: 0 },
  resetAt: { type: Date, required: true },
}, { timestamps: true });

rateLimitWindowSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.RateLimitWindow || mongoose.model('RateLimitWindow', rateLimitWindowSchema);
