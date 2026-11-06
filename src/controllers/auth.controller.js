'use strict';

const { requestOtp, verifyOtp, logout } = require('../services/auth.service');
const { COOKIE_NAME } = require('../middleware/requireSession');

async function requestPhoneOtp(req, res) {
  const data = await requestOtp({
    countryCallingCode: req.body?.countryCallingCode,
    phoneNumber: req.body?.phoneNumber,
    clientIp: req.ip,
  });
  res.status(200).json({ success: true, data });
}

async function verifyPhoneOtp(req, res) {
  const session = await verifyOtp({
    countryCallingCode: req.body?.countryCallingCode,
    phoneNumber: req.body?.phoneNumber,
    otp: req.body?.otp,
  });
  res.cookie(COOKIE_NAME, session.rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    expires: session.expiresAt,
  });
  res.status(200).json({ success: true, data: { authenticated: true } });
}

async function logoutUser(req, res) {
  await logout(req.authSession);
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
  res.status(200).json({ success: true, data: { loggedOut: true } });
}

module.exports = { requestPhoneOtp, verifyPhoneOtp, logoutUser };
