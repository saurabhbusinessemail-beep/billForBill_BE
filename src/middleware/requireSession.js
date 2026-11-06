'use strict';

const crypto = require('node:crypto');
const UserSession = require('../DB/models/UserSession');

const configuredCookieName = process.env.SESSION_COOKIE_NAME || 'billforbill_session';
const COOKIE_NAME = /^[A-Za-z0-9_-]+$/.test(configuredCookieName) ? configuredCookieName : 'billforbill_session';

function readCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator > -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

async function requireSession(req, res, next) {
  try {
    const rawToken = readCookie(req, COOKIE_NAME);
    if (!rawToken || !/^[a-f\d]{64}$/i.test(rawToken)) {
      return res.status(401).json({ success: false, error: { code: 'SESSION_REQUIRED', message: 'Please sign in.' } });
    }
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const session = await UserSession.findOne({
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).select('+tokenHash');
    if (!session) {
      return res.status(401).json({ success: false, error: { code: 'SESSION_EXPIRED', message: 'Please sign in again.' } });
    }
    req.authSession = session;
    req.authUserId = session.userId;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { requireSession, readCookie, COOKIE_NAME };
