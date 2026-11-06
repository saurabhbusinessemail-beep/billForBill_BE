'use strict';

const mongoose = require('mongoose');
const { assertDatabaseConnected } = require('../DB/connection');
const User = require('../DB/models/User');
const { assignDefaultName } = require('./userNames.service');

const LABELS = new Set(['home', 'work', 'warehouse', 'shop', 'other']);
const FIELDS = ['contactName', 'phone', 'line1', 'line2', 'city', 'state', 'pincode', 'country'];
const LIMITS = { contactName: 120, phone: 30, line1: 200, line2: 200, city: 100, state: 100, pincode: 20, country: 100 };

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 422;
  error.code = 'INVALID_PROFILE_ADDRESS';
  return error;
}

function cleanAddress(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !LABELS.has(body.label)) {
    throw inputError('Choose a valid address label.');
  }
  const address = { label: body.label };
  for (const field of FIELDS) {
    if (typeof body[field] !== 'string') throw inputError('Complete all required address fields.');
    const value = body[field].trim();
    if (value.length > LIMITS[field] || (field !== 'line2' && !value)) throw inputError('Check the address fields and try again.');
    address[field] = value;
  }
  return address;
}

async function getProfile(userId) {
  assertDatabaseConnected();
  let user = await User.findById(userId).select('phoneE164 displayName generatedNameNumber createdAt addresses');
  if (!user) {
    const error = new Error('Please sign in again.');
    error.statusCode = 401;
    error.code = 'SESSION_USER_NOT_FOUND';
    throw error;
  }
  if (!user.displayName) user = await assignDefaultName(user._id);
  return {
    user: { name: user.displayName, phoneE164: user.phoneE164, createdAt: user.createdAt },
    addresses: (user.addresses || []).map((address, index) => ({
      id: String(address._id), label: address.label, contactName: address.contactName, phone: address.phone,
      line1: address.line1, line2: address.line2 || '', city: address.city, state: address.state,
      pincode: address.pincode, country: address.country, isDefault: index === 0,
    })),
  };
}

async function addAddress(userId, body) {
  assertDatabaseConnected();
  const address = cleanAddress(body);
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('Please sign in again.');
    error.statusCode = 401;
    error.code = 'SESSION_USER_NOT_FOUND';
    throw error;
  }
  user.addresses.push(address);
  await user.save();
  return getProfile(userId);
}

async function updateAddress(userId, addressId, body) {
  assertDatabaseConnected();
  if (!mongoose.isValidObjectId(addressId)) throw inputError('Invalid address.');
  const address = cleanAddress(body);
  const user = await User.findById(userId);
  const existing = user?.addresses.id(addressId);
  if (!existing) {
    const error = new Error('Address not found.');
    error.statusCode = 404;
    error.code = 'ADDRESS_NOT_FOUND';
    throw error;
  }
  Object.assign(existing, address);
  await user.save();
  return getProfile(userId);
}

async function deleteAddress(userId, addressId) {
  assertDatabaseConnected();
  if (!mongoose.isValidObjectId(addressId)) throw inputError('Invalid address.');
  const user = await User.findById(userId);
  const existing = user?.addresses.id(addressId);
  if (!existing) {
    const error = new Error('Address not found.');
    error.statusCode = 404;
    error.code = 'ADDRESS_NOT_FOUND';
    throw error;
  }
  existing.deleteOne();
  await user.save();
  return getProfile(userId);
}

module.exports = { getProfile, addAddress, updateAddress, deleteAddress };
