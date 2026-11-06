'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ _id: { type: String, default: 'global' }, value: { type: Number, default: 0, min: 0 } }, { versionKey: false });
module.exports = mongoose.models.UserNameSequence || mongoose.model('UserNameSequence', schema);
