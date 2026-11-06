'use strict';

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phoneE164: { type: String, required: true, unique: true, immutable: true },
  displayName: { type: String, trim: true, maxlength: 120, default: '' },
  generatedNameNumber: { type: Number, min: 1, unique: true, sparse: true },
  profilePhotoUrl: { type: String, trim: true, maxlength: 2048, default: '' },
  isAdmin: { type: Boolean },
  isSuperAdmin: { type: Boolean, default: false },
  accountStatus: { type: String, enum: ['provisioned', 'active'], default: 'active' },
  firstTimeWorkspaceChoice: { type: String, enum: ['personal', 'new-business'], default: null },
  addresses: {
    type: [{
      label: { type: String, enum: ['home', 'work', 'warehouse', 'shop', 'other'], required: true },
      contactName: { type: String, trim: true, required: true, maxlength: 120 },
      phone: { type: String, trim: true, required: true, maxlength: 30 },
      line1: { type: String, trim: true, required: true, maxlength: 200 },
      line2: { type: String, trim: true, maxlength: 200, default: '' },
      city: { type: String, trim: true, required: true, maxlength: 100 },
      state: { type: String, trim: true, required: true, maxlength: 100 },
      pincode: { type: String, trim: true, required: true, maxlength: 20 },
      country: { type: String, trim: true, required: true, maxlength: 100 },
    }],
    default: [],
  },
}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
