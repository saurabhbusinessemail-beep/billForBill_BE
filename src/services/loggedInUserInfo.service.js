'use strict';

const { assertDatabaseConnected } = require('../DB/connection');
const User = require('../DB/models/User');
const { assignDefaultName } = require('./userNames.service');

async function getLoggedInUserInfo(userId) {
  assertDatabaseConnected();
  let user = await User.findById(userId).select('phoneE164 displayName generatedNameNumber profilePhotoUrl isAdmin isSuperAdmin createdAt');
  if (!user) {
    const error = new Error('Please sign in again.');
    error.statusCode = 401;
    error.code = 'SESSION_USER_NOT_FOUND';
    throw error;
  }
  if (!user.displayName) user = await assignDefaultName(user._id);
  const isAdmin = Boolean(await User.exists({ _id: user._id, isAdmin: true }));
  return { userId: String(user._id), phoneE164: user.phoneE164, name: user.displayName, photoUrl: user.profilePhotoUrl || '', createdAt: user.createdAt, isAdmin, isSuperAdmin: user.isSuperAdmin === true };
}

module.exports = { getLoggedInUserInfo };
