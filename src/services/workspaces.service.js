'use strict';

const { assertDatabaseConnected } = require('../DB/connection');
const Business = require('../DB/models/Business');
const BusinessMembership = require('../DB/models/BusinessMembership');
const BusinessLogo = require('../DB/models/BusinessLogo');
const User = require('../DB/models/User');
const { businessCurrency } = require('./businessCurrency');

function createError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function toWorkspace(business, logoIds) {
  return {
    id: String(business._id),
    kind: 'business',
    legalName: business.legalName,
    currencyCode: businessCurrency(business),
    businessTypeId: business.businessTypeId ? String(business.businessTypeId) : null,
    registrationId: business.registrationId,
    gstin: business.gstin || '',
    phone: business.phone,
    email: business.email,
    website: business.website,
    address: business.address,
    hasLogo: logoIds.has(String(business._id)),
    createdAt: business.createdAt,
    updatedAt: business.updatedAt,
  };
}

async function getWorkspaces(userId) {
  assertDatabaseConnected();
  const user = await User.findById(userId).select('firstTimeWorkspaceChoice');
  if (!user) throw createError(401, 'SESSION_USER_NOT_FOUND', 'Please sign in again.');
  const businesses = await Business.find({ ownerUserId: userId }).sort({ createdAt: 1, _id: 1 }).lean();
  const logoRecords = await BusinessLogo.find({ ownerUserId: userId }).select('businessId').lean();
  const logoIds = new Set(logoRecords.map((logo) => String(logo.businessId)));
  return {
    userId: String(user._id),
    setupChoice: user.firstTimeWorkspaceChoice ?? null,
    workspaces: [
      { id: 'personal', kind: 'personal', name: 'Personal' },
      ...businesses.map((business) => toWorkspace(business, logoIds)),
    ],
  };
}

async function getWorkingAtWorkspaces(userId) {
  assertDatabaseConnected();
  const user = await User.findById(userId).select('_id');
  if (!user) throw createError(401, 'SESSION_USER_NOT_FOUND', 'Please sign in again.');

  const memberships = await BusinessMembership.find({ userId })
    .select('businessId')
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  const businessIds = [...new Set(memberships.map(membership => String(membership.businessId)))];
  if (!businessIds.length) return { workspaces: [] };

  const businesses = await Business.find({ _id: { $in: businessIds }, ownerUserId: { $ne: userId } }).lean();
  if (!businesses.length) return { workspaces: [] };
  const availableIds = businesses.map(business => String(business._id));
  const logoRecords = await BusinessLogo.find({ businessId: { $in: availableIds } }).select('businessId').lean();

  const businessById = new Map(businesses.map(business => [String(business._id), business]));
  const logoIds = new Set(logoRecords.map(logo => String(logo.businessId)));
  return {
    workspaces: businessIds.flatMap(id => {
      const business = businessById.get(id);
      if (!business) return [];
      return [{
        id,
        kind: 'business',
        legalName: business.legalName,
        currencyCode: businessCurrency(business),
        businessTypeId: business.businessTypeId ? String(business.businessTypeId) : null,
        hasLogo: logoIds.has(id),
      }];
    }),
  };
}

async function saveSetupChoice(userId, choice) {
  assertDatabaseConnected();
  if (choice !== 'personal' && choice !== 'new-business') {
    throw createError(400, 'INVALID_SETUP_CHOICE', 'Choose Personal Use or New Business.');
  }
  const existing = await User.findById(userId).select('firstTimeWorkspaceChoice');
  if (!existing) throw createError(401, 'SESSION_USER_NOT_FOUND', 'Please sign in again.');
  if (existing.firstTimeWorkspaceChoice) {
    if (existing.firstTimeWorkspaceChoice !== choice) {
      throw createError(409, 'SETUP_CHOICE_ALREADY_SAVED', 'Your first-time setup choice has already been saved.');
    }
    return { setupChoice: existing.firstTimeWorkspaceChoice };
  }
  const updated = await User.findOneAndUpdate(
    { _id: userId, firstTimeWorkspaceChoice: null },
    { $set: { firstTimeWorkspaceChoice: choice } },
    { new: true, runValidators: true },
  ).select('firstTimeWorkspaceChoice');
  if (!updated) throw createError(409, 'SETUP_CHOICE_CONFLICT', 'Could not save your setup choice. Refresh and try again.');
  return { setupChoice: updated.firstTimeWorkspaceChoice };
}

module.exports = { getWorkspaces, getWorkingAtWorkspaces, saveSetupChoice };
