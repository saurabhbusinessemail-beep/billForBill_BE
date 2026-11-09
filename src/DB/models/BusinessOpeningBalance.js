'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;
const historySchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, required: true },
  scope: { type: String, required: true },
  version: { type: Number, required: true },
  periods: { type: [Schema.Types.Mixed], default: [] },
  operations: { type: [Schema.Types.Mixed], default: [] },
});
historySchema.index({ businessId: 1, scope: 1 }, { unique: true });

const previewSchema = new Schema({
  _id: String,
  businessId: Schema.Types.ObjectId,
  actor: String,
  request: Schema.Types.Mixed,
  digest: String,
  expiresAt: { type: Date, expires: 0 },
});
module.exports = {
  History: mongoose.model('BusinessOpeningBalanceHistory', historySchema),
  Preview: mongoose.model('BusinessOpeningBalancePreview', previewSchema),
};
