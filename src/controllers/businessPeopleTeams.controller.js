'use strict';
const s = require('../services/businessPeopleTeams.service');
const run = (fn, key = 'data', status = 200) => async (req, res, next) => { try { const data = await fn(req); res.setHeader('Cache-Control', 'private, no-store'); res.status(status).json({ success: true, data: key ? { [key]: data } : data }); } catch (e) { next(e); } };
const id = req => req.params.businessId; const user = req => req.authUserId;
module.exports = {
  overview: run(req => s.overview(id(req), user(req)), null),
  lookupPerson: run(req => s.lookupPerson(id(req), user(req), req.query), null),
  listPeople: run(req => s.listPeople(id(req), user(req), req.query), null),
  addPerson: run(req => s.addPerson(id(req), user(req), req.body), null, 201),
  removePerson: run(req => s.removePerson(id(req), user(req), req.params.userId), null),
  listTeams: run(req => s.listTeams(id(req), user(req), req.query), null),
  createTeam: run(req => s.createTeam(id(req), user(req), req.body), null, 201),
  getTeam: run(req => s.getTeam(id(req), user(req), req.params.teamId), null),
  updateTeam: run(req => s.updateTeam(id(req), user(req), req.params.teamId, req.body), null),
  deleteTeam: run(req => s.deleteTeam(id(req), user(req), req.params.teamId), null),
  listTeamMembers: run(req => s.listMembers(id(req), user(req), req.params.teamId), null),
  addTeamMember: run(req => s.addMember(id(req), user(req), req.params.teamId, req.params.userId), null),
  removeTeamMember: run(req => s.removeMember(id(req), user(req), req.params.teamId, req.params.userId), null),
  permissionCatalog: run(req => s.catalog(id(req), user(req)), null),
  listTeamPermissions: run(req => s.permissions(id(req), user(req), req.params.teamId), null),
  setTeamPermissions: run(req => s.setPermissions(id(req), user(req), req.params.teamId, req.body), null),
};
