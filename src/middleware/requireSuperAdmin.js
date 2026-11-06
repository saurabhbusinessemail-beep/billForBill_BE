'use strict';

const User = require('../DB/models/User');

async function requireSuperAdmin(req, res, next) {
  try {
    const allowed = await User.exists({ _id: req.authUserId, isSuperAdmin: true });
    if (!allowed) return res.status(403).json({ success: false, error: { code: 'SUPER_ADMIN_REQUIRED', message: 'Super administrator access is required.' } });
    next();
  } catch (error) { next(error); }
}

module.exports = { requireSuperAdmin };
