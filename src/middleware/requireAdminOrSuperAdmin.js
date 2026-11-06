'use strict';

const User = require('../DB/models/User');

async function requireAdminOrSuperAdmin(req, res, next) {
  try {
    const allowed = await User.exists({ _id: req.authUserId, $or: [{ isAdmin: true }, { isSuperAdmin: true }] });
    if (!allowed) return res.status(403).json({ success: false, error: { code: 'ADMIN_REQUIRED', message: 'Administrator access is required.' } });
    next();
  } catch (error) { next(error); }
}

module.exports = { requireAdminOrSuperAdmin };
