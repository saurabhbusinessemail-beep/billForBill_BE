'use strict';

const VALID_CALLING_CODES = new Set([
  '+1', '+7', '+20', '+27', '+30', '+31', '+32', '+33', '+34', '+39', '+40', '+41', '+43', '+44', '+45', '+46',
  '+47', '+48', '+49', '+52', '+54', '+55', '+56', '+57', '+60', '+61', '+62', '+63', '+64', '+65', '+66',
  '+81', '+82', '+84', '+86', '+90', '+91', '+92', '+94', '+234', '+254', '+351', '+353', '+358', '+380',
  '+420', '+852', '+880', '+886', '+966', '+971', '+972', '+977',
]);

function normalizePhone(countryCallingCode, phoneNumber) {
  if (typeof countryCallingCode !== 'string' || typeof phoneNumber !== 'string') return null;
  const callingCode = countryCallingCode.replace(/^\+/, '');
  const nationalNumber = phoneNumber.replace(/[\s().-]/g, '');
  if (!/^\d{1,3}$/.test(callingCode) || !VALID_CALLING_CODES.has(`+${callingCode}`)) return null;
  if (!/^\d{4,14}$/.test(nationalNumber)) return null;
  const phoneE164 = `+${callingCode}${nationalNumber}`;
  if (!/^\+[1-9]\d{6,14}$/.test(phoneE164)) return null;
  return phoneE164;
}

function parsePhoneE164(phoneE164) {
  if (typeof phoneE164 !== 'string' || !/^\+[1-9]\d{6,14}$/.test(phoneE164)) return null;
  const code = [...VALID_CALLING_CODES].sort((a, b) => b.length - a.length).find((candidate) => phoneE164.startsWith(candidate));
  return code ? { countryCallingCode: code, phoneNumber: phoneE164.slice(code.length) } : null;
}

module.exports = { normalizePhone, parsePhoneE164 };
