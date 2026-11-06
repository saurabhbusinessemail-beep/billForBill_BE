'use strict';
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const Business = require('../DB/models/Business');
const BusinessMembership = require('../DB/models/BusinessMembership');
const BusinessTeam = require('../DB/models/BusinessTeam');
const TeamMembership = require('../DB/models/TeamMembership');
const TeamPermissionGrant = require('../DB/models/TeamPermissionGrant');
const RateLimitWindow = require('../DB/models/RateLimitWindow');
const BusinessMutationLock = require('../DB/models/BusinessMutationLock');
const User = require('../DB/models/User');
const UserSession = require('../DB/models/UserSession');
const { assertDatabaseConnected } = require('../DB/connection');
const { normalizePhone } = require('../utils/phone');
const { BUSINESS_PERMISSIONS, PERMISSION_KEYS } = require('./businessPermissions');
const { assignDefaultName } = require('./userNames.service');
const fail = (status, code, message) => Object.assign(new Error(message), { statusCode: status, code });
function validId(id) { if (!mongoose.isValidObjectId(id)) throw fail(404, 'NOT_FOUND', 'The requested item was not found.'); }
async function withCompensation(work) {
  const undo = [];
  const step = async (action, rollback) => {
    undo.push(rollback);
    return action();
  };
  try { return await work(step); }
  catch (cause) {
    const rollbackErrors = [];
    for (const rollback of undo.reverse()) {
      try { await rollback(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) {
      console.error('[business-people-teams] Compensation failed:', rollbackErrors.map(e => e.code || e.name || 'UNKNOWN_ERROR'));
      throw fail(500, 'COMPENSATION_FAILED', 'The operation could not be completed or fully rolled back. Contact support before retrying.');
    }
    throw cause;
  }
}
async function withBusinessMutation(businessId, work) {
  const lockId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  let acquired = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const lock = await BusinessMutationLock.findOneAndUpdate(
        { businessId, $or: [{ expiresAt: { $lte: new Date() } }, { lockId }] },
        { $set: { businessId, lockId, expiresAt } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      if (lock?.lockId === lockId) { acquired = true; break; }
    } catch (e) { if (e.code !== 11000) throw e; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!acquired) throw fail(409, 'BUSINESS_UPDATE_BUSY', 'Another business update is in progress. Please try again.');
  const renewal = setInterval(() => {
    BusinessMutationLock.updateOne({ businessId, lockId }, { $set: { expiresAt: new Date(Date.now() + 10 * 60 * 1000) } })
      .catch(e => console.error('[business-people-teams] Mutation lock renewal failed:', e.code || e.name || 'UNKNOWN_ERROR'));
  }, 60 * 1000);
  renewal.unref();
  try { return await withCompensation(work); }
  finally {
    clearInterval(renewal);
    try { await BusinessMutationLock.deleteOne({ businessId, lockId }); }
    catch (e) { console.error('[business-people-teams] Mutation lock release failed:', e.code || e.name || 'UNKNOWN_ERROR'); }
  }
}
async function restoreDocuments(Model, documents) {
  if (!documents.length) return;
  await Model.bulkWrite(documents.map(document => ({ replaceOne: { filter: { _id: document._id }, replacement: document, upsert: true } })), { ordered: true });
}
async function access(businessId, userId, required) {
  validId(businessId); assertDatabaseConnected();
  const business = await Business.findById(businessId).lean();
  if (!business) throw fail(404, 'BUSINESS_NOT_FOUND', 'Business not found.');
  if (String(business.ownerUserId) === String(userId)) return { business, owner: true, keys: new Set([...PERMISSION_KEYS]) };
  if (!await BusinessMembership.exists({ businessId, userId })) throw fail(404, 'BUSINESS_NOT_FOUND', 'Business not found.');
  const teamIds = await TeamMembership.find({ businessId, userId }).distinct('teamId');
  const keys = new Set(await TeamPermissionGrant.find({ businessId, teamId: { $in: teamIds } }).distinct('permissionKey'));
  if (required && !keys.has(required)) throw fail(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.');
  return { business, owner: false, keys };
}
async function team(businessId, teamId) { validId(teamId); const value = await BusinessTeam.findOne({ _id: teamId, businessId }).lean(); if (!value) throw fail(404, 'TEAM_NOT_FOUND', 'Team not found.'); return value; }
function page(query) { const p = Math.max(1, parseInt(query.page, 10) || 1); const s = Math.max(1, Math.min(100, parseInt(query.pageSize, 10) || 25)); return { p, s, skip: (p - 1) * s }; }
async function person(user, extras = {}) {
  let u = user; if (!u.displayName) u = await assignDefaultName(u._id);
  return { userId: String(u._id), phoneE164: u.phoneE164, name: u.displayName, generatedNameNumber: u.generatedNameNumber || null, photoUrl: /^https:\/\//i.test(u.profilePhotoUrl || '') ? u.profilePhotoUrl : '', accountStatus: u.accountStatus, ...extras };
}
async function overview(bid, uid) {
  const ctx = await access(bid, uid, 'dashboard.view');
  const [people, teams, permissions] = await Promise.all([BusinessMembership.countDocuments({ businessId: bid }), BusinessTeam.countDocuments({ businessId: bid }), TeamPermissionGrant.countDocuments({ businessId: bid })]);
  const catalogCounts = ctx.keys.has('business.catalog.view') ? await require('./businessCatalog.service').counts(bid, uid) : null;
  const documentCounts = await require('./businessDocuments.service').summary(bid, uid);
  const billingCounts = ctx.keys.has('business.bills.view') ? await require('./businessBillsPayments.service').summary(bid, uid) : {};
  return { counts: { people, teams, permissions, ...(catalogCounts || {}), ...documentCounts, ...billingCounts }, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function listPeople(bid, uid, query) {
  const ctx = await access(bid, uid, 'people.view'); const { p, s, skip } = page(query); const filter = { businessId: bid, userId: { $ne: ctx.business.ownerUserId } };
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 80) : '';
  if (search) { const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); const matching = await User.find({ $or: [{ displayName: rx }, { phoneE164: rx }] }).distinct('_id'); filter.userId = { $in: matching, $ne: ctx.business.ownerUserId }; }
  const links = await BusinessMembership.find(filter).sort({ createdAt: 1 }).skip(skip).limit(s + 1).lean();
  const ids = links.slice(0, s).map(x => x.userId); const users = await User.find({ _id: { $in: ids } }).lean(); const byId = new Map(users.map(u => [String(u._id), u]));
  const items = await Promise.all(links.slice(0, s).filter(x => byId.has(String(x.userId))).map(async (x) => person(byId.get(String(x.userId)), { joinedAt: x.createdAt, teamCount: await TeamMembership.countDocuments({ businessId: bid, userId: x.userId }) })));
  const total = await BusinessMembership.countDocuments(filter); return { items, page: p, pageSize: s, total, hasNextPage: links.length > s, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function lookupPerson(bid, uid, query) {
  await access(bid, uid, 'people.add'); const phoneE164 = normalizePhone(query.countryCallingCode, query.phoneNumber);
  if (!phoneE164) throw fail(400, 'INVALID_PHONE', 'Enter a valid phone number and calling code.');
  const key = `f006-person-lookup:${uid}`; const now = new Date();
  let window = await RateLimitWindow.findOneAndUpdate({ key, resetAt: { $gt: now } }, { $inc: { count: 1 } }, { new: true });
  if (!window) window = await RateLimitWindow.findOneAndUpdate({ key }, { $set: { count: 1, resetAt: new Date(now.getTime() + 60 * 60 * 1000) } }, { upsert: true, new: true, setDefaultsOnInsert: true }).catch(async e => { if (e.code !== 11000) throw e; return RateLimitWindow.findOneAndUpdate({ key }, { $inc: { count: 1 } }, { new: true }); });
  if (window.count > 30) throw Object.assign(fail(429, 'RATE_LIMITED', 'Too many lookup requests. Try again later.'), { retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) });
  const user = await User.findOne({ phoneE164 }).lean(); if (!user) return { exists: false };
  return { exists: true, alreadyAdded: Boolean(await BusinessMembership.exists({ businessId: bid, userId: user._id })), user: await person(user) };
}
async function addPerson(bid, uid, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'INVALID_PERSON', 'Enter valid person details.');
  const ctx = await access(bid, uid, 'people.add'); const phoneE164 = normalizePhone(input.countryCallingCode, input.phoneNumber);
  if (!phoneE164) throw fail(400, 'INVALID_PHONE', 'Enter a valid phone number and calling code.'); const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length > 120) throw fail(400, 'INVALID_NAME', 'Name is too long.');
  let u = await User.findOne({ phoneE164 }); let provisioned = false;
  if (!u) {
    if (!name) throw fail(400, 'NAME_REQUIRED', 'Name is required for a new user.');
    const userId = new mongoose.Types.ObjectId();
    const membershipId = new mongoose.Types.ObjectId();
    let createdUser;
    try {
      await withBusinessMutation(bid, async step => {
        if (await User.exists({ phoneE164 })) throw fail(409, 'USER_CREATE_CONFLICT', 'This phone number was registered while the person was being added. Try again.');
        if (await BusinessMembership.exists({ businessId: bid, userId })) throw fail(409, 'PERSON_EXISTS', 'This person is already in the business.');
        await step(
          () => BusinessMembership.create({ _id: membershipId, businessId: bid, userId, createdByUserId: uid }),
          () => BusinessMembership.deleteOne({ _id: membershipId }),
        );
        createdUser = await step(
          () => User.create({ _id: userId, phoneE164, displayName: name, accountStatus: 'provisioned' }),
          async () => {
            const linked = await BusinessMembership.exists({ userId });
            const hasSession = await UserSession.exists({ userId });
            if (!linked && !hasSession) await User.deleteOne({ _id: userId, accountStatus: 'provisioned' });
          },
        );
      });
      u = createdUser;
      provisioned = true;
      return { person: await person(u, { teamCount: 0 }), provisioned, added: true };
    } catch (e) {
      if (e.code !== 11000 && e.code !== 'USER_CREATE_CONFLICT') throw e;
      u = await User.findOne({ phoneE164 });
    }
  }
  if (!u) throw fail(409, 'USER_CREATE_CONFLICT', 'Could not add this person.');
  if (String(u._id) === String(ctx.business.ownerUserId)) throw fail(409, 'OWNER_PROTECTED', 'The business owner is already included.');
  const personData = await person(u, { teamCount: 0 });
  let link;
  try { link = await withBusinessMutation(bid, async step => {
    if (await BusinessMembership.exists({ businessId: bid, userId: u._id })) throw fail(409, 'PERSON_EXISTS', 'This person is already in the business.');
    const membershipId = new mongoose.Types.ObjectId();
    return step(() => BusinessMembership.create({ _id: membershipId, businessId: bid, userId: u._id, createdByUserId: uid }), () => BusinessMembership.deleteOne({ _id: membershipId }));
  }); }
  catch (e) { if (e.code === 11000) throw fail(409, 'PERSON_EXISTS', 'This person is already in the business.'); throw e; }
  return { person: { ...personData, joinedAt: link.createdAt }, provisioned, added: true };
}
async function removePerson(bid, uid, targetId) {
  const ctx = await access(bid, uid, 'people.remove'); validId(targetId); if (String(ctx.business.ownerUserId) === String(targetId)) throw fail(403, 'OWNER_PROTECTED', 'The business owner cannot be removed.');
  await withBusinessMutation(bid, async step => {
    const link = await BusinessMembership.findOne({ businessId: bid, userId: targetId }).lean();
    if (!link) throw fail(404, 'PERSON_NOT_FOUND', 'Person not found.');
    const teams = await TeamMembership.find({ businessId: bid, userId: targetId }).lean();
    await step(
      () => TeamMembership.deleteMany({ businessId: bid, userId: targetId }),
      () => restoreDocuments(TeamMembership, teams),
    );
    await step(
      () => BusinessMembership.deleteOne({ _id: link._id }),
      () => restoreDocuments(BusinessMembership, [link]),
    );
  });
  return { removed: true };
}
async function teamCounts(rows) {
  if (!rows.length) return [];
  const teamIds = rows.map(team => team._id);
  const [memberships, permissionCounts] = await Promise.all([
    TeamMembership.find({ businessId: rows[0].businessId, teamId: { $in: teamIds } }).sort({ createdAt: 1 })
      .populate({ path: 'userId', select: 'displayName generatedNameNumber profilePhotoUrl' }).lean(),
    Promise.all(rows.map(team => TeamPermissionGrant.countDocuments({ teamId: team._id }))),
  ]);
  const membersByTeam = new Map();
  for (const membership of memberships) {
    const teamId = String(membership.teamId);
    const members = membersByTeam.get(teamId) || [];
    members.push(membership.userId);
    membersByTeam.set(teamId, members);
  }
  return rows.map((team, index) => {
    const members = membersByTeam.get(String(team._id)) || [];
    return {
      id: String(team._id), name: team.name, description: team.description,
      memberCount: members.length,
      memberPreviews: members.filter(Boolean).slice(0, 3).map(user => ({
        name: user.displayName || '', generatedNameNumber: user.generatedNameNumber || null,
        photoUrl: /^https:\/\//i.test(user.profilePhotoUrl || '') ? user.profilePhotoUrl : '',
      })),
      permissionCount: permissionCounts[index], createdAt: team.createdAt, updatedAt: team.updatedAt,
    };
  });
}
async function listTeams(bid, uid, query) { const ctx = await access(bid, uid, 'teams.view'); const { p, s, skip } = page(query); const filter = { businessId: bid }; if (query.search) filter.name = { $regex: String(query.search).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }; const rows = await BusinessTeam.find(filter).sort({ name: 1 }).skip(skip).limit(s + 1).lean(); return { items: await teamCounts(rows.slice(0, s)), page: p, pageSize: s, total: await BusinessTeam.countDocuments(filter), hasNextPage: rows.length > s, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } }; }
async function getTeam(bid, uid, tid) { await access(bid, uid, 'teams.view'); return (await teamCounts([await team(bid, tid)]))[0]; }
function teamValues(input, partial = false) { if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'INVALID_TEAM', 'Enter valid team details.'); const out = {}; if (!partial || 'name' in input) { const name = typeof input.name === 'string' ? input.name.trim() : ''; if (!name || name.length > 100) throw fail(400, 'INVALID_TEAM_NAME', 'Enter a team name up to 100 characters.'); out.name = name; out.normalizedName = name.normalize('NFKC').toLowerCase(); } if (!partial || 'description' in input) { if (input.description != null && typeof input.description !== 'string') throw fail(400, 'INVALID_DESCRIPTION', 'Enter a valid description.'); const d = String(input.description || '').trim(); if (d.length > 500) throw fail(400, 'INVALID_DESCRIPTION', 'Description is too long.'); out.description = d; } if (!Object.keys(out).length) throw fail(400, 'EMPTY_TEAM_UPDATE', 'Provide team details to update.'); return out; }
async function createTeam(bid, uid, input) { await access(bid, uid, 'teams.create'); try { return await withBusinessMutation(bid, async step => { const teamId = new mongoose.Types.ObjectId(); const values = { _id: teamId, businessId: bid, ...teamValues(input), createdByUserId: uid, updatedByUserId: uid }; const created = await step(() => BusinessTeam.create(values), () => BusinessTeam.deleteOne({ _id: teamId })); return (await teamCounts([created.toObject()]))[0]; }); } catch (e) { if (e.code === 11000) throw fail(409, 'TEAM_NAME_EXISTS', 'A team with this name already exists.'); throw e; } }
async function updateTeam(bid, uid, tid, input) { await access(bid, uid, 'teams.update'); validId(tid, 'TEAM_NOT_FOUND'); try { return await withBusinessMutation(bid, async step => { const current = await BusinessTeam.findOne({ _id: tid, businessId: bid }).lean(); if (!current) throw fail(404, 'TEAM_NOT_FOUND', 'Team not found.'); const updated = await step(() => BusinessTeam.findOneAndUpdate({ _id: tid, businessId: bid }, { $set: { ...teamValues(input, true), updatedByUserId: uid } }, { new: true, runValidators: true }).lean(), () => restoreDocuments(BusinessTeam, [current])); return (await teamCounts([updated]))[0]; }); } catch (e) { if (e.code === 11000) throw fail(409, 'TEAM_NAME_EXISTS', 'A team with this name already exists.'); throw e; } }
async function deleteTeam(bid, uid, tid) {
  await access(bid, uid, 'teams.remove'); validId(tid, 'TEAM_NOT_FOUND');
  await withBusinessMutation(bid, async step => {
    const currentTeam = await BusinessTeam.findOne({ _id: tid, businessId: bid }).lean();
    if (!currentTeam) throw fail(404, 'TEAM_NOT_FOUND', 'Team not found.');
    const memberships = await TeamMembership.find({ businessId: bid, teamId: tid }).lean();
    const grants = await TeamPermissionGrant.find({ businessId: bid, teamId: tid }).lean();
    await step(() => TeamMembership.deleteMany({ businessId: bid, teamId: tid }), () => restoreDocuments(TeamMembership, memberships));
    await step(() => TeamPermissionGrant.deleteMany({ businessId: bid, teamId: tid }), () => restoreDocuments(TeamPermissionGrant, grants));
    await step(() => BusinessTeam.deleteOne({ _id: tid, businessId: bid }), () => restoreDocuments(BusinessTeam, [currentTeam]));
  });
  return { deleted: true };
}
async function listMembers(bid, uid, tid) { const ctx = await access(bid, uid, 'teams.view'); await team(bid, tid); const ids = (await BusinessMembership.find({ businessId: bid, userId: { $ne: ctx.business.ownerUserId } }).distinct('userId')).map(String); const teamIds = new Set((await TeamMembership.find({ businessId: bid, teamId: tid }).distinct('userId')).map(String)); const users = await User.find({ _id: { $in: ids } }).lean(); const members = await Promise.all(users.filter(u => teamIds.has(String(u._id))).map(u => person(u))); const eligible = await Promise.all(users.filter(u => !teamIds.has(String(u._id))).map(u => person(u))); return { members, eligible, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } }; }
async function addMember(bid, uid, tid, target) {
  const ctx = await access(bid, uid, 'team.members.manage'); await team(bid, tid); validId(target);
  if (String(ctx.business.ownerUserId) === String(target)) throw fail(409, 'OWNER_PROTECTED', 'The business owner is not a team member.');
  const u = await User.findById(target); if (!u) throw fail(404, 'PERSON_NOT_FOUND', 'Person not found.');
  if (!await BusinessMembership.exists({ businessId: bid, userId: target }) && !ctx.keys.has('people.add')) throw fail(403, 'PERMISSION_DENIED', 'You also need permission to add people.');
  const member = await person(u);
  try {
    await withBusinessMutation(bid, async step => {
      if (await TeamMembership.exists({ businessId: bid, teamId: tid, userId: target })) throw fail(409, 'TEAM_MEMBER_EXISTS', 'This person is already on the team.');
      const link = await BusinessMembership.findOne({ businessId: bid, userId: target }).lean();
      if (!link) {
        const membershipId = new mongoose.Types.ObjectId();
        await step(() => BusinessMembership.create({ _id: membershipId, businessId: bid, userId: target, createdByUserId: uid }), () => BusinessMembership.deleteOne({ _id: membershipId }));
      }
      const teamMembershipId = new mongoose.Types.ObjectId();
      await step(() => TeamMembership.create({ _id: teamMembershipId, businessId: bid, teamId: tid, userId: target, createdByUserId: uid }), () => TeamMembership.deleteOne({ _id: teamMembershipId }));
    });
  } catch (e) { if (e.code === 11000) throw fail(409, 'TEAM_MEMBER_EXISTS', 'This person is already on the team.'); throw e; }
  return { member };
}
async function removeMember(bid, uid, tid, target) {
  await access(bid, uid, 'team.members.manage'); await team(bid, tid); validId(target, 'PERSON_NOT_FOUND');
  await withBusinessMutation(bid, async step => {
    const link = await TeamMembership.findOne({ businessId: bid, teamId: tid, userId: target }).lean();
    if (!link) throw fail(404, 'TEAM_MEMBER_NOT_FOUND', 'Team member not found.');
    await step(() => TeamMembership.deleteOne({ _id: link._id }), () => restoreDocuments(TeamMembership, [link]));
  });
  return { removed: true };
}
async function permissions(bid, uid, tid) { const ctx = await access(bid, uid, 'teams.view'); await team(bid, tid); const granted = new Set(await TeamPermissionGrant.find({ businessId: bid, teamId: tid }).distinct('permissionKey')); return { permissions: BUSINESS_PERMISSIONS.map(x => ({ ...x, granted: granted.has(x.key) })), authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } }; }
async function setPermissions(bid, uid, tid, input) {
  const ctx = await access(bid, uid, 'team.permissions.manage'); await team(bid, tid);
  const keys = input?.permissionKeys;
  if (!Array.isArray(keys) || keys.some(k => typeof k !== 'string' || !PERMISSION_KEYS.has(k)) || new Set(keys).size !== keys.length) throw fail(400, 'INVALID_PERMISSION_KEYS', 'Select valid permissions.');
  await withBusinessMutation(bid, async step => {
    const oldGrants = await TeamPermissionGrant.find({ businessId: bid, teamId: tid }).lean();
    const current = new Set(oldGrants.map(x => x.permissionKey));
    if (!ctx.owner && keys.some(k => !current.has(k) && !ctx.keys.has(k))) throw fail(403, 'PERMISSION_ESCALATION', 'You cannot grant permissions you do not have.');
    await step(() => TeamPermissionGrant.deleteMany({ businessId: bid, teamId: tid }), () => restoreDocuments(TeamPermissionGrant, oldGrants));
    if (keys.length) {
      await step(
        () => TeamPermissionGrant.insertMany(keys.map(permissionKey => ({ businessId: bid, teamId: tid, permissionKey, grantedByUserId: uid })), { ordered: true }),
        () => TeamPermissionGrant.deleteMany({ businessId: bid, teamId: tid, permissionKey: { $in: keys } }),
      );
    }
  });
  return { permissions: BUSINESS_PERMISSIONS.map(x => ({ ...x, granted: keys.includes(x.key) })) };
}
async function catalog(bid, uid) { await access(bid, uid); return BUSINESS_PERMISSIONS; }
module.exports = { access, overview, listPeople, lookupPerson, addPerson, removePerson, listTeams, getTeam, createTeam, updateTeam, deleteTeam, listMembers, addMember, removeMember, permissions, setPermissions, catalog };
