'use strict';

const Business = require('../DB/models/Business');
const Bill = require('../DB/models/BusinessBill');
const Payment = require('../DB/models/BusinessPayment');
const Allocation = require('../DB/models/BusinessPaymentAllocation');
const User = require('../DB/models/User');

const fail = (statusCode, code, message) => Object.assign(new Error(message), {
  statusCode, code, expose: statusCode < 500,
});
const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : value;
const userKey = id => id ? `user:${id}` : '';
const businessKey = id => `business:${id}`;

function date(value) {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || day(parsed) !== value) {
    throw fail(400, 'INVALID_DATE', 'Choose a valid date.');
  }
  return value;
}

function amount(value) {
  const match = /^([+-]?)(\d{1,30})(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) throw fail(400, 'INVALID_AMOUNT', 'Enter an amount with up to two decimal places.');
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  return match[1] === '-' ? -cents : cents;
}

function money(cents) {
  const magnitude = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`;
}

function billParty(bill, businessId) {
  if (String(bill.businessId) !== String(businessId)) return businessKey(bill.businessId);
  if (bill.billType === 'sale' && bill.recipientBusinessId && String(bill.recipientBusinessId) !== String(businessId)) {
    return businessKey(bill.recipientBusinessId);
  }
  return userKey(bill.partyUserId);
}

async function billsFor(business) {
  const businessId = business._id;
  const received = [{ recipientBusinessId: businessId }];
  if (business.gstin) {
    const matches = await Business.find({ gstin: business.gstin, catalogCopyState: { $ne: 'pending' } }).select('_id').limit(2).lean();
    if (matches.length === 1 && String(matches[0]._id) === String(businessId)) {
      received.push({ recipientBusinessId: null, gstin: business.gstin });
    }
  }
  return Bill.find({
    status: { $in: ['issued', 'cancelled'] }, issuedAt: { $ne: null }, deletedAt: null,
    $or: [{ businessId }, { businessId: { $ne: businessId }, billType: 'sale', $or: received }],
  }).select('businessId billType status issuedAt cancelledAt billDate billNumber currencyCode grandTotal partyUserId partySnapshot.name partySnapshot.phone recipientBusinessId').lean();
}

async function counterparties(business, bills) {
  const parties = new Map();
  for (const bill of bills) {
    if (bill.status !== 'issued') continue;
    const key = billParty(bill, business._id);
    if (!key) continue;
    const role = String(bill.businessId) === String(business._id) && bill.billType === 'sale' ? 'customer' : 'vendor';
    const entry = parties.get(key) || { key, label: '', phone: '', roles: [] };
    if (!entry.roles.includes(role)) entry.roles.push(role);
    if (key.startsWith('user:')) {
      entry.label ||= bill.partySnapshot?.name || '';
      entry.phone ||= bill.partySnapshot?.phone || '';
    }
    parties.set(key, entry);
  }
  const contacts = await partyContacts([...parties.keys()]);
  for (const [key, contact] of contacts) {
    const party = parties.get(key);
    party.label = contact.label || party.label;
    party.phone = contact.phone || party.phone;
  }
  for (const entry of parties.values()) entry.roles.sort();
  return [...parties.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

async function partyContacts(keys) {
  const businessIds = keys.filter(key => key.startsWith('business:')).map(key => key.slice(9));
  const userIds = keys.filter(key => key.startsWith('user:')).map(key => key.slice(5));
  const [businesses, users] = await Promise.all([
    Business.find({ _id: { $in: businessIds } }).select('legalName phone').lean(),
    User.find({ _id: { $in: userIds } }).select('displayName generatedNameNumber phoneE164').lean(),
  ]);
  return new Map([
    ...businesses.map(business => [businessKey(business._id), { label: business.legalName, phone: business.phone }]),
    ...users.map(user => [userKey(user._id), {
      label: user.displayName || (user.generatedNameNumber ? `User ${user.generatedNameNumber}` : ''),
      phone: user.phoneE164,
    }]),
  ]);
}

async function events(business, bills, cutoff, partyKey = '') {
  const businessId = String(business._id);
  const currency = business.currencyCode || 'INR';
  const activeAt = timestamp => !timestamp || day(timestamp) > cutoff;
  const isReceived = bill => String(bill.businessId) !== businessId;
  const eligible = bills.filter(bill => activeAt(bill.cancelledAt));
  const byId = new Map(bills.map(bill => [String(bill._id), bill]));
  const receivedIds = eligible.filter(bill => isReceived(bill) && (!partyKey || billParty(bill, businessId) === partyKey)).map(bill => bill._id);
  const allocations = await Allocation.find({
    $or: [{ businessId }, { billId: { $in: receivedIds } }],
  }).select('businessId billId paymentId sourcePaymentId amount reversedAt').lean();
  const activeAllocations = allocations.filter(allocation => activeAt(allocation.reversedAt));
  const paymentIds = activeAllocations.filter(row => String(row.businessId) !== businessId).map(row => row.sourcePaymentId || row.paymentId);
  const payments = await Payment.find({
    $or: [{ businessId }, { _id: { $in: paymentIds }, direction: 'incoming' }],
    paymentDate: { $lte: cutoff },
  }).select('businessId paymentDate paymentNumber direction partyUserId amount currencyCode reversedAt').lean();
  const rows = [];
  const emit = (id, type, sourceDate, reference, counterpartyKey, currencyCode, value) => {
    if (partyKey && partyKey !== counterpartyKey) return;
    if (date(sourceDate) > cutoff) return;
    rows.push({ id, type, date: sourceDate, reference: reference || '', counterpartyKey, currency: currencyCode || currency, amount: money(value) });
  };
  for (const bill of eligible) {
    const type = isReceived(bill) ? 'receivedBill' : bill.billType === 'sale' ? 'sale' : 'purchase';
    emit(String(bill._id), type, bill.billDate, bill.billNumber, billParty(bill, businessId),
      bill.currencyCode, amount(bill.grandTotal) * (type === 'sale' ? -1n : 1n));
  }
  const byPayment = new Map();
  for (const allocation of activeAllocations) {
    const id = String(allocation.sourcePaymentId || allocation.paymentId);
    const group = byPayment.get(id) || [];
    group.push(allocation);
    byPayment.set(id, group);
  }
  const receivedSet = new Set(receivedIds.map(String));
  for (const payment of payments.filter(row => activeAt(row.reversedAt))) {
    const id = String(payment._id);
    const links = (byPayment.get(id) || []).filter(row => String(row.businessId) === String(payment.businessId));
    if (String(payment.businessId) !== businessId) {
      for (const link of links) {
        if (!receivedSet.has(String(link.billId))) continue;
        const bill = byId.get(String(link.billId));
        if (String(bill.businessId) !== String(payment.businessId)) continue;
        emit(String(link._id), 'receivedBillPayment', payment.paymentDate, bill.billNumber,
          billParty(bill, businessId), payment.currencyCode, -amount(link.amount));
      }
      continue;
    }
    const direction = payment.direction === 'incoming' ? 1n : -1n;
    const party = userKey(payment.partyUserId);
    let remainder = amount(payment.amount);
    for (const link of links) {
      const bill = byId.get(String(link.billId));
      if (!bill || isReceived(bill)) continue;
      const counterparty = billParty(bill, businessId) || party;
      const allocated = amount(link.amount);
      if (counterparty === party) continue;
      remainder -= allocated;
      emit(String(link._id), payment.direction, payment.paymentDate, payment.paymentNumber,
        counterparty, payment.currencyCode, direction * allocated);
    }
    if (remainder < 0n) throw fail(409, 'INVALID_LEDGER_SOURCE', 'Payment allocations exceed the payment amount.');
    if (remainder) emit(id, payment.direction, payment.paymentDate, payment.paymentNumber, party,
      payment.currencyCode, direction * remainder);
  }
  const rank = row => ['sale', 'purchase', 'receivedBill'].includes(row.type) ? 0 : 1;
  const contacts = await partyContacts([...new Set(rows.map(row => row.counterpartyKey))]);
  for (const row of rows) row.counterpartyLabel = contacts.get(row.counterpartyKey)?.label || '';
  return rows.sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.id.localeCompare(b.id));
}

module.exports = { amount, money, day, date, fail, billParty, billsFor, counterparties, events };
