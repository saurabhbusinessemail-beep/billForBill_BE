'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { access } = require('./businessPeopleTeams.service');
const { withFinancialLock } = require('./businessBillsPayments.service');
const inventory = require('./businessInventory.service');
const Bill = require('../DB/models/BusinessBill');
const { History, Preview } = require('../DB/models/BusinessOpeningBalance');
const source = require('./openingBalanceSources');
const { amount, money, day, date, fail } = source;

const manageKey = 'business.openingBalances.manage';
const reportKey = 'business.reports.view';
const keyPattern = /^(user|business):[a-f0-9]{24}$/;
const uuidPattern = /^[a-f0-9-]{36}$/;
const validKey = key => typeof key === 'string' && keyPattern.test(key);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const previousDay = value => day(new Date(Date.parse(`${value}T00:00:00Z`) - 86400000));
const currencyOf = business => business.currencyCode || 'INR';
const stale = () => fail(409, 'STALE_BALANCE_PREVIEW', 'The calculation changed. Review the updated balance before saving.');

function validateCurrency(rows, currency) {
  if (rows.some(row => row.currency !== currency)) {
    throw fail(409, 'BALANCE_CURRENCY_MISMATCH', 'This balance contains amounts in different currencies.');
  }
}

function publicPeriod(period) {
  if (!period) return null;
  const { id, openingDate, openingAmount, closingDate, closingAmount, currency, rawClosingAmount, fallback } = period;
  return { id, openingDate, openingAmount, closingDate, closingAmount, currency, rawClosingAmount, fallback };
}

async function historyFor(businessId, scope) {
  return await History.findOne({ businessId, scope }).lean() || { version: 0, periods: [], operations: [] };
}

async function partyOptions(bid, uid, query) {
  const directory = query.directory === 'true';
  const { business, keys } = await access(bid, uid, directory ? undefined : reportKey);
  const canManage = keys.has(manageKey);
  if (directory && !canManage && !keys.has(reportKey)) {
    throw fail(403, 'PERMISSION_DENIED', 'You do not have permission to view customers and vendors.');
  }
  const search = String(query.search || '').trim().slice(0, 100).toLowerCase();
  const parties = await source.counterparties(business, await source.billsFor(business));
  const digits = /^[+\d\s().-]+$/.test(search) ? search.replace(/\D/g, '') : '';
  const items = parties.filter(party => party.label.toLowerCase().includes(search)
    || (digits && party.phone.replace(/\D/g, '').includes(digits)));
  const version = digest([bid, uid, search, directory, items]);
  const offset = readCursor(query.cursor, version);
  const page = items.slice(offset, offset + (directory ? 25 : search ? 20 : 100));
  const nextCursor = offset + page.length < items.length ? `${version}:${offset + page.length}` : null;
  if (!directory) return { items: page, nextCursor };
  const histories = await History.find({ businessId: bid, scope: { $in: page.map(party => party.key) } })
    .select('scope periods').lean();
  const latest = new Map(histories.map(row => [row.scope, publicPeriod(row.periods.at(-1))]));
  return { items: page.map(party => ({ ...party, period: latest.get(party.key) ?? null })),
    nextCursor, total: items.length, currency: currencyOf(business), canManage };
}

async function latest(bid, uid, query) {
  const { business } = await access(bid, uid, manageKey);
  const currency = currencyOf(business);
  if (query.keys === undefined) return { currency, period: publicPeriod((await historyFor(bid, 'business')).periods.at(-1)) };
  const keys = String(query.keys).split(',');
  if (keys.length > 100 || keys.some(key => !validKey(key))) throw fail(400, 'INVALID_COUNTERPARTY', 'Choose valid counterparties.');
  const parties = new Set((await source.counterparties(business, await source.billsFor(business))).map(item => item.key));
  const histories = await History.find({ businessId: bid, scope: { $in: keys } }).select('scope periods').lean();
  const byScope = new Map(histories.map(row => [row.scope, row.periods.at(-1)]));
  return {
    currency,
    items: keys.map(key => {
      const eligible = parties.has(key);
      return { key, eligible, canSet: eligible, period: eligible ? publicPeriod(byScope.get(key)) : null };
    }),
  };
}

function validateRequest(body) {
  const { action, scope, counterpartyKey, openingDate, amount: value } = body;
  if (!['set', 'close'].includes(action) || !['business', 'party'].includes(scope)
    || (scope === 'party' ? !validKey(counterpartyKey) : counterpartyKey !== undefined)
    || (action === 'set' && typeof value !== 'string')
    || (action === 'close' && (scope !== 'party' || openingDate !== undefined || value !== undefined))) {
    throw fail(400, 'INVALID_BALANCE_OPERATION', 'Choose a valid opening balance action.');
  }
  if (action === 'close') return { action, scope: counterpartyKey };
  const opening = amount(value);
  if (date(openingDate) > day(new Date()) || opening > 100000000000000n || opening < -100000000000000n) {
    throw fail(400, 'INVALID_BALANCE_OPERATION', 'Enter an amount and an opening date on or before today.');
  }
  return { action, scope: counterpartyKey || 'business', openingDate, openingAmount: money(opening) };
}

async function plan(business, actor, request, history) {
  const { action, scope, openingDate, openingAmount } = request;
  const currency = currencyOf(business);
  let bills;
  const last = history.periods.at(-1);
  if (scope !== 'business') {
    bills = await source.billsFor(business);
    const eligible = (await source.counterparties(business, bills)).some(party => party.key === scope);
    if (!eligible) throw fail(404, 'INELIGIBLE_COUNTERPARTY', 'This party is unavailable for the selected business.');
  }
  if (history.periods.some((period, index) => period.currency !== currency
    || (index > 0 && (!history.periods[index - 1].closingDate || history.periods[index - 1].closingDate >= period.openingDate))
    || (period.closingDate && period.closingDate < period.openingDate))) {
    throw fail(409, 'INVALID_BALANCE_HISTORY', 'The existing balance history cannot be changed.');
  }
  const opening = action === 'set' ? { openingDate, openingAmount, currency, createdBy: actor } : null;
  let closing = null;
  let successor = null;
  let closingDate;
  if (action === 'close') {
    if (!last || last.closingDate) throw fail(409, 'NO_OPEN_BALANCE', 'There is no open balance to close.');
    closing = last;
    closingDate = day(new Date());
  } else {
    const conflict = history.periods.find(period => period.openingDate === openingDate
      || (period.openingDate < openingDate && period.closingDate >= openingDate));
    if (conflict) {
      throw Object.assign(fail(409, 'BALANCE_DATE_OVERLAP', 'This date overlaps an existing opening balance.'), {
        details: publicPeriod(conflict),
      });
    }
    successor = history.periods.find(period => period.openingDate > openingDate);
    if (successor) {
      closing = opening;
      closingDate = previousDay(successor.openingDate);
    } else if (last && !last.closingDate) {
      closing = last;
      successor = opening;
      closingDate = previousDay(openingDate);
    }
  }
  let rows = [];
  if (closing) {
    rows = (await source.events(business, bills || await source.billsFor(business), closingDate, scope === 'business' ? '' : scope))
      .filter(row => row.date >= closing.openingDate);
    validateCurrency(rows, currency);
    const raw = rows.reduce((total, row) => total + amount(row.amount), amount(closing.openingAmount));
    closing = {
      ...closing, closingDate, rawClosingAmount: money(raw),
      closingAmount: raw === 0n && successor ? successor.openingAmount : money(raw),
      fallback: raw === 0n && Boolean(successor),
    };
  }
  return { opening, closing, rows, successorDate: successor?.openingDate || null };
}

async function preview(bid, uid, body) {
  const { business } = await access(bid, uid, manageKey);
  const request = validateRequest(body);
  const history = await historyFor(bid, request.scope);
  const result = await plan(business, String(uid), request, history);
  const token = randomUUID();
  await Preview.create({ _id: token, businessId: bid, actor: String(uid), request,
    digest: digest([history.version, result]), expiresAt: new Date(Date.now() + 10 * 60000) });
  return { token, confirmationRequired: Boolean(result.closing), opening: publicPeriod(result.opening),
    closing: publicPeriod(result.closing), successorDate: result.successorDate };
}

async function commit(bid, uid, body, key) {
  await access(bid, uid, manageKey);
  if (typeof body.token !== 'string' || !uuidPattern.test(body.token) || typeof key !== 'string' || !uuidPattern.test(key)) {
    throw fail(400, 'INVALID_BALANCE_OPERATION', 'Review the balance before saving.');
  }
  await History.init();
  return withFinancialLock(bid, async () => {
    const { business } = await access(bid, uid, manageKey);
    const actor = String(uid);
    const prior = await History.findOne({ businessId: bid, 'operations.key': key }).select('operations').lean();
    const operation = prior?.operations.find(row => row.key === key);
    if (operation) {
      if (operation.actor !== actor || operation.token !== body.token) throw stale();
      return operation.result;
    }
    const confirmation = await Preview.findOne({ _id: body.token, businessId: bid, actor, expiresAt: { $gt: new Date() } }).lean();
    if (!confirmation) throw stale();
    const { request } = confirmation;
    const history = await historyFor(bid, request.scope);
    const result = await plan(business, actor, request, history);
    if (digest([history.version, result]) !== confirmation.digest || (result.closing && body.confirmed !== true)) throw stale();
    const now = new Date().toISOString();
    const periods = [...history.periods];
    const added = result.opening && { ...result.opening, id: randomUUID(), createdAt: now, calculationVersion: 1 };
    if (added) periods.push(added);
    let closed = null;
    if (result.closing) {
      closed = { ...(result.closing.id ? result.closing : added), ...result.closing,
        closedAt: now, closedBy: actor };
      periods[periods.findIndex(period => period.id === closed.id)] = closed;
    }
    periods.sort((a, b) => a.openingDate.localeCompare(b.openingDate));
    const outcome = { addedId: added?.id || null, closedId: closed?.id || null, period: publicPeriod(periods.at(-1)) };
    try {
      const updated = await History.updateOne({ businessId: bid, scope: request.scope, version: history.version }, {
        $set: { periods }, $inc: { version: 1 },
        $push: { operations: { key, token: body.token, actor, at: now, result: outcome } },
      }, { upsert: history.version === 0 });
      if (!updated.modifiedCount && !updated.upsertedCount) throw stale();
    } catch (error) {
      if (error.code === 11000) throw stale();
      throw error;
    }
    return outcome;
  });
}

async function monetary(business, bills, from, to, type, partyKey) {
  const currency = currencyOf(business);
  const scope = partyKey || 'business';
  const periods = (await historyFor(business._id, scope)).periods.filter(period => period.openingDate <= to);
  if (periods.some(period => period.currency !== currency)) validateCurrency(periods, currency);
  const rows = await source.events(business, bills, to, partyKey);
  const live = type === 'financial' && !periods.length ? rows.filter(row => row.date >= from) : rows;
  validateCurrency(live, currency);
  const anchors = periods.map(period => ({
    id: period.id, date: period.openingDate, type: 'openingAdjustment', amount: period.openingAmount,
  }));
  // Stable sorting keeps opening balances ahead of same-day activity.
  const timeline = [...anchors, ...live].sort((a, b) => a.date.localeCompare(b.date));
  let running = 0n;
  let opening = 0n;
  let positive = 0n;
  let negative = 0n;
  let adjustments = 0n;
  const items = [];
  for (const row of timeline) {
    const isAdjustment = row.type === 'openingAdjustment';
    const delta = amount(row.amount) - (isAdjustment ? running : 0n);
    running += delta;
    if (row.date < from) { opening = running; continue; }
    if (isAdjustment) {
      if (!delta) continue;
      adjustments += delta;
    } else if (delta >= 0n) positive += delta;
    else negative += delta;
    items.push({ ...row, amount: money(delta), balance: money(running) });
  }
  return { currency, opening: money(opening), positive: money(positive), negative: money(negative),
    adjustments: money(adjustments), closing: money(running), rows: items };
}

function readCursor(cursor, version) {
  const offset = Number(String(cursor || ':0').split(':')[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || (cursor && cursor !== `${version}:${offset}`)) {
    throw fail(409, 'STALE_REPORT_CURSOR', 'The report changed. Reload it before continuing.');
  }
  return offset;
}

function pageRows(query, monetarySection, quantity, scope) {
  const version = digest([scope, monetarySection, quantity]);
  const offset = readCursor(query.cursor, version);
  const size = Math.min(500, Math.max(1, Math.trunc(Number(query.pageSize)) || 100));
  const rows = monetarySection.rows.slice(offset, offset + size);
  const movements = quantity?.movements.slice(offset, offset + size);
  return { money: { ...monetarySection, rows }, quantity: quantity && { ...quantity, movements },
    nextCursor: offset + size < Math.max(monetarySection.rows.length, quantity?.movements.length || 0)
      ? `${version}:${offset + size}` : null };
}

async function statement(bid, uid, query) {
  const { business } = await access(bid, uid, reportKey);
  const { type, counterpartyKey, productId, variantKey, unitId } = query;
  const from = date(query.from);
  const to = date(query.to);
  const partyReport = type === 'inventory' || type === 'financial';
  if (from > to || !['inventory', 'financial', 'overallFinancial'].includes(type)
    || (partyReport ? !validKey(counterpartyKey) : counterpartyKey !== undefined)
    || (type === 'inventory' ? typeof productId !== 'string' || !productId || typeof unitId !== 'string' || !unitId
      || (variantKey !== undefined && typeof variantKey !== 'string')
      : [productId, variantKey, unitId].some(value => value !== undefined))) {
    throw fail(400, 'INVALID_STATEMENT_FILTERS', 'Choose valid report filters.');
  }
  const bills = await source.billsFor(business);
  if (partyReport && !(await source.counterparties(business, bills)).some(party => party.key === counterpartyKey)) {
    throw fail(404, 'INELIGIBLE_COUNTERPARTY', 'Choose a customer or vendor for the selected business.');
  }
  let quantity = null;
  if (type === 'inventory') {
    const stockBills = await Bill.find({ businessId: bid }).select('businessId billType partyUserId recipientBusinessId').lean();
    const ids = [...new Set([...stockBills, ...bills]
      .filter(bill => source.billParty(bill, bid) === counterpartyKey).map(bill => String(bill._id)))];
    quantity = await inventory.report(bid, uid, { productId, variantKey, unitKey: unitId, startDate: from, endDate: to }, ids);
  }
  const moneySection = await monetary(business, bills, from, to, type, counterpartyKey);
  return { type, from, to, ...pageRows(query, moneySection, quantity, [bid, uid, type, from, to, counterpartyKey, productId, variantKey, unitId]) };
}

module.exports = { partyOptions, latest, preview, commit, statement };
