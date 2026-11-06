'use strict';

const crypto = require('node:crypto');
const { assertDatabaseConnected } = require('../DB/connection');
const OtpChallenge = require('../DB/models/OtpChallenge');
const RateLimitWindow = require('../DB/models/RateLimitWindow');
const User = require('../DB/models/User');
const UserSession = require('../DB/models/UserSession');
const { COOKIE_NAME } = require('../middleware/requireSession');
const { normalizePhone } = require('../utils/phone');
const { assignDefaultName } = require('./userNames.service');

const OTP_TTL_SECONDS = Math.min(300, Math.max(60, Number(process.env.OTP_TTL_SECONDS) || 300));
const OTP_TTL_MS = OTP_TTL_SECONDS * 1000;
const OTP_ATTEMPT_LIMIT = Math.min(5, Math.max(1, Number(process.env.OTP_MAX_ATTEMPTS) || 5));
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const PHONE_REQUEST_LIMIT = Math.max(1, Number(process.env.OTP_REQUEST_LIMIT_PHONE_PER_HOUR) || 5);
const IP_REQUEST_LIMIT = Math.max(1, Number(process.env.OTP_REQUEST_LIMIT_IP_PER_HOUR) || 20);
const RESEND_COOLDOWN_MS = Math.max(1, Number(process.env.OTP_RESEND_COOLDOWN_SECONDS) || 30) * 1000;

function createError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function hashOtp(phoneE164, otp) {
  return crypto.createHmac('sha256', process.env.OTP_HASH_SECRET)
    .update(`${phoneE164}:${otp}`)
    .digest('hex');
}

async function consumeLimit(key, maxCount, windowMs) {
  const now = new Date();
  let bucket = await RateLimitWindow.findOneAndUpdate(
    { key, resetAt: { $gt: now } },
    { $inc: { count: 1 } },
    { new: true },
  );
  if (!bucket) {
    const nextReset = new Date(now.getTime() + windowMs);
    bucket = await RateLimitWindow.findOneAndUpdate(
      { key },
      { $set: { count: 1, resetAt: nextReset } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).catch(async (error) => {
      if (error.code !== 11000) throw error;
      return RateLimitWindow.findOneAndUpdate({ key }, { $inc: { count: 1 } }, { new: true });
    });
  }
  if (bucket.count > maxCount) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt.getTime() - now.getTime()) / 1000));
    const error = createError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
    error.retryAfterSeconds = retryAfterSeconds;
    throw error;
  }
  return bucket;
}

function getPhoneE164(countryCallingCode, phoneNumber) {
  const phoneE164 = normalizePhone(countryCallingCode, phoneNumber);
  if (!phoneE164) throw createError(400, 'INVALID_PHONE', 'Enter a valid phone number and country calling code.');
  return phoneE164;
}

async function requestOtp({ countryCallingCode, phoneNumber, clientIp }) {
  assertDatabaseConnected();
  const phoneE164 = getPhoneE164(countryCallingCode, phoneNumber);
  const phoneKey = crypto.createHash('sha256').update(phoneE164).digest('hex');
  const ipKey = crypto.createHash('sha256').update(String(clientIp || 'unknown')).digest('hex');
  await consumeLimit(`otp-ip:${ipKey}`, IP_REQUEST_LIMIT, REQUEST_WINDOW_MS);
  await consumeLimit(`otp-phone:${phoneKey}`, PHONE_REQUEST_LIMIT, REQUEST_WINDOW_MS);
  const cooldownWindow = await consumeLimit(`otp-cooldown:${phoneKey}`, 1, RESEND_COOLDOWN_MS);

  const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  console.log('Login OTP for contact ', countryCallingCode, phoneNumber, ' is ', otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await OtpChallenge.findOneAndUpdate(
    { phoneE164 },
    { $set: { codeHash: hashOtp(phoneE164, otp), expiresAt, attemptCount: 0, consumedAt: null } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  );

  // Explicit temporary product decision: OTPs are logged in local and production until messaging is available.
  console.info(`[auth] OTP for phone ending ${phoneE164.slice(-4)}: ${otp}; expires ${expiresAt.toISOString()}`);
  return {
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: OTP_TTL_SECONDS,
    resendAvailableAt: cooldownWindow.resetAt.toISOString(),
  };
}

async function verifyOtp({ countryCallingCode, phoneNumber, otp }) {
  assertDatabaseConnected();
  const phoneE164 = getPhoneE164(countryCallingCode, phoneNumber);
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
    throw createError(400, 'INVALID_OTP', 'The code is invalid or expired. Request a new code and try again.');
  }

  const challenge = await OtpChallenge.findOne({ phoneE164, consumedAt: null }).select('+codeHash');
  const now = new Date();
  if (!challenge || challenge.expiresAt <= now || challenge.attemptCount >= OTP_ATTEMPT_LIMIT) {
    throw createError(400, 'INVALID_OTP', 'The code is invalid or expired. Request a new code and try again.');
  }

  const attempt = await OtpChallenge.findOneAndUpdate(
    { _id: challenge._id, consumedAt: null, expiresAt: { $gt: now }, attemptCount: { $lt: OTP_ATTEMPT_LIMIT } },
    { $inc: { attemptCount: 1 } },
    { new: true },
  ).select('+codeHash');
  if (!attempt) throw createError(400, 'INVALID_OTP', 'The code is invalid or expired. Request a new code and try again.');

  const suppliedHash = Buffer.from(hashOtp(phoneE164, otp), 'hex');
  const storedHash = Buffer.from(attempt.codeHash, 'hex');
  if (suppliedHash.length !== storedHash.length || !crypto.timingSafeEqual(suppliedHash, storedHash)) {
    throw createError(400, 'INVALID_OTP', 'The code is invalid or expired. Request a new code and try again.');
  }

  // Delete atomically after successful hash verification so a replay cannot authenticate.
  const deletedChallenge = await OtpChallenge.findOneAndDelete({
    _id: attempt._id,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
    attemptCount: attempt.attemptCount,
  });
  if (!deletedChallenge) throw createError(400, 'INVALID_OTP', 'The code is invalid or expired. Request a new code and try again.');

  const user = await User.findOneAndUpdate(
    { phoneE164 },
    { $setOnInsert: { phoneE164 }, $set: { accountStatus: 'active' } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  );
  if (!user.displayName) await assignDefaultName(user._id);
  const ttlSeconds = Math.min(30 * 24 * 60 * 60, Math.max(300, Number(process.env.SESSION_TTL_SECONDS) || 7 * 24 * 60 * 60));
  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await UserSession.create({
    tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
    userId: user._id,
    expiresAt,
  });
  return {
    cookieName: COOKIE_NAME,
    rawToken,
    expiresAt,
    maxAgeMs: ttlSeconds * 1000,
  };
}

async function logout(session) {
  assertDatabaseConnected();
  await UserSession.deleteOne({ _id: session._id });
}

module.exports = { requestOtp, verifyOtp, logout };
