'use strict';

const User = require('../DB/models/User');

async function requireAdmin(req, res, next) {
  try {
    const isAdmin = await User.exists({ _id: req.authUserId, isAdmin: true });
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: { code: 'ADMIN_REQUIRED', message: 'Administrator access is required.' } });
    }
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { requireAdmin };
