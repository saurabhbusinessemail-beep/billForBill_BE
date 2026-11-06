'use strict';

const profileService = require('../services/userProfile.service');

async function getProfile(req, res) {
  res.status(200).json({ success: true, data: await profileService.getProfile(req.authUserId) });
}

async function addAddress(req, res) {
  res.status(201).json({ success: true, data: await profileService.addAddress(req.authUserId, req.body) });
}

async function updateAddress(req, res) {
  res.status(200).json({ success: true, data: await profileService.updateAddress(req.authUserId, req.params.addressId, req.body) });
}

async function deleteAddress(req, res) {
  res.status(200).json({ success: true, data: await profileService.deleteAddress(req.authUserId, req.params.addressId) });
}

module.exports = { getProfile, addAddress, updateAddress, deleteAddress };
