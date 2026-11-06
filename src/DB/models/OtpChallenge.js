'use strict';

const mongoose = require('mongoose');

const otpChallengeSchema = new mongoose.Schema({
  phoneE164: { type: String, required: true, unique: true },
  codeHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  attemptCount: { type: Number, required: true, default: 0 },
  consumedAt: { type: Date, default: null },
}, { timestamps: true });

otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.OtpChallenge || mongoose.model('OtpChallenge', otpChallengeSchema);
