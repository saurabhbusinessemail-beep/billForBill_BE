'use strict';
const User = require('../DB/models/User');
const Sequence = require('../DB/models/UserNameSequence');
async function assignDefaultName(userId) {
  let user = await User.findById(userId);
  if (!user || user.displayName) return user;
  const sequence = await Sequence.findOneAndUpdate({ _id: 'global' }, { $inc: { value: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  user = await User.findOneAndUpdate({ _id: userId, displayName: { $in: ['', null] } }, { $set: { displayName: `User ${sequence.value}`, generatedNameNumber: sequence.value } }, { new: true });
  return user || User.findById(userId);
}
module.exports = { assignDefaultName };
