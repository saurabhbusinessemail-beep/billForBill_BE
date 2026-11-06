'use strict';

const { getWorkspaces, getWorkingAtWorkspaces, saveSetupChoice } = require('../services/workspaces.service');

async function listWorkspaces(req, res) {
  const data = await getWorkspaces(req.authUserId);
  res.status(200).json({ success: true, data });
}

async function listWorkingAtWorkspaces(req, res) {
  const data = await getWorkingAtWorkspaces(req.authUserId);
  res.status(200).json({ success: true, data });
}

async function updateSetupChoice(req, res) {
  const data = await saveSetupChoice(req.authUserId, req.body?.choice);
  res.status(200).json({ success: true, data });
}

module.exports = { listWorkspaces, listWorkingAtWorkspaces, updateSetupChoice };
