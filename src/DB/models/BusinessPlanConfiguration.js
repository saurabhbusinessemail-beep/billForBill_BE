'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, default: 'default' },
  defaultBills: { type: Number, required: true, min: 0, default: 10, validate: Number.isInteger },
}, { timestamps: true, versionKey: false });
module.exports = mongoose.models.BusinessPlanConfiguration || mongoose.model('BusinessPlanConfiguration', schema);
