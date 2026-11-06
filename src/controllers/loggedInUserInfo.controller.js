'use strict';

const { getLoggedInUserInfo } = require('../services/loggedInUserInfo.service');

async function loggedInUserInfo(req, res) {
  const data = await getLoggedInUserInfo(req.authUserId);
  res.status(200).json({ success: true, data });
}

module.exports = { loggedInUserInfo };
