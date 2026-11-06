'use strict';
const mongoose = require('mongoose');
const BusinessBill = require('../DB/models/BusinessBill');
const BusinessPlanPurchase = require('../DB/models/BusinessPlanPurchase');
const BusinessExtraCreditPurchase = require('../DB/models/BusinessExtraCreditPurchase');
const BusinessPlanConfiguration = require('../DB/models/BusinessPlanConfiguration');
const Plan = require('../DB/models/Plan');
const ExtraCreditPack = require('../DB/models/ExtraCreditPack');
const PlanOffer = require('../DB/models/PlanOffer');
const BusinessType = require('../DB/models/BusinessType');
const { access } = require('./businessPeopleTeams.service');
const { assertDatabaseConnected } = require('../DB/connection');
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code, expose: statusCode < 500 });
const DEFAULT_FREE_PLAN = 'DEFAULT_FREE_PLAN';
const validId = value => mongoose.isValidObjectId(value);
const amount = value => Math.round(Number(value || 0) * 100) / 100;

function localMonth(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}
function localDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function zonedStart(year, monthNumber, timeZone) {
  const utcGuess = Date.UTC(year, monthNumber - 1, 1);
  const fields = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(utcGuess));
  const val = type => Number(fields.find(part => part.type === type).value);
  const localAsUtc = Date.UTC(val('year'), val('month') - 1, val('day'), val('hour'), val('minute'), val('second'));
  return new Date(utcGuess - (localAsUtc - utcGuess));
}
function monthBounds(month, timeZone = 'Asia/Kolkata') {
  const [year, number] = month.split('-').map(Number);
  const nextYear = number === 12 ? year + 1 : year; const nextNumber = number === 12 ? 1 : number + 1;
  return { start: zonedStart(year, number, timeZone), end: zonedStart(nextYear, nextNumber, timeZone) };
}
function nextMonth(month) { const [year, number] = month.split('-').map(Number); return `${number === 12 ? year + 1 : year}-${String(number === 12 ? 1 : number + 1).padStart(2, '0')}`; }
function idempotencyKey(value) {
  const key = String(value || '').trim();
  if (key.length < 8 || key.length > 120) throw fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required.');
  return key;
}
function publicPlanPurchase(row) { return { id: String(row._id), businessId: String(row.businessId), planId: String(row.planId), planSnapshot: row.planSnapshot, effectiveMonth: row.effectiveMonth, offerSnapshot: row.offerSnapshot, amountPaid: Number(row.amountPaid), paymentStatus: row.paymentStatus, createdAt: row.createdAt }; }
function publicCreditPurchase(row) { return { id: String(row._id), businessId: String(row.businessId), extraCreditPackId: String(row.extraCreditPackId), packSnapshot: row.packSnapshot, amountPaid: Number(row.amountPaid), paymentStatus: row.paymentStatus, createdAt: row.createdAt }; }
async function context(businessId, userId, permission) {
  assertDatabaseConnected();
  if (!validId(businessId)) throw fail(404, 'BUSINESS_NOT_FOUND', 'Business not found.');
  return access(businessId, userId, permission);
}
async function config() {
  return BusinessPlanConfiguration.findOneAndUpdate({ _id: 'default' }, { $setOnInsert: { defaultBills: 10 } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
}
async function planState(businessId, month) {
  const purchases = await BusinessPlanPurchase.find({ businessId, effectiveMonth: { $lte: month } }).sort({ effectiveMonth: -1, createdAt: -1 }).limit(1).lean();
  return purchases[0] || null;
}
async function billCount(businessId, planId, range) {
  const filter = { businessId, planId, status: 'issued', deletedAt: null, issuedAt: { $gte: range.start, $lt: range.end } };
  return BusinessBill.countDocuments(filter);
}
async function billCountsByPlan(businessId, planIds, range = null) {
  if (!planIds.length) return new Map();
  const match = { businessId: new mongoose.Types.ObjectId(businessId), planId: { $in: planIds }, status: 'issued', deletedAt: null };
  if (range) match.issuedAt = { $gte: range.start, $lt: range.end };
  const rows = await BusinessBill.aggregate([{ $match: match }, { $group: { _id: '$planId', count: { $sum: 1 } } }]);
  return new Map(rows.map(row => [String(row._id), Number(row.count)]));
}
async function ensureLegacyPlanIds(businessId) {
  // Older bills predate F024. Attribute them to the fixed free-plan ID without
  // changing any issued invoice content or its financial snapshots.
  await BusinessBill.updateMany({ businessId, status: { $in: ['issued', 'cancelled'] }, $or: [{ planId: { $exists: false } }, { planId: null }, { planId: '' }] }, { $set: { planId: DEFAULT_FREE_PLAN } });
}
async function dashboard(businessId, userId) {
  const { business, owner, keys } = await context(businessId, userId, 'business.plans.view');
  await ensureLegacyPlanIds(businessId);
  const timeZone = business.timeZone || process.env.BUSINESS_DEFAULT_TIME_ZONE || 'Asia/Kolkata';
  const month = localMonth(new Date(), timeZone); const range = monthBounds(month, timeZone);
  const [currentPlan, credits, defaults] = await Promise.all([
    planState(businessId, month),
    BusinessExtraCreditPurchase.find({ businessId, paymentStatus: 'completed' }).sort({ createdAt: 1 }).lean(),
    config(),
  ]);
  const businessType = business.businessTypeId ? await BusinessType.findById(business.businessTypeId).select('name').lean() : null;
  const activePlanId = currentPlan ? String(currentPlan.planId) : DEFAULT_FREE_PLAN;
  const creditIds = credits.map(credit => String(credit._id));
  const [planUsed, creditCounts, monthCreditCounts] = await Promise.all([
    billCount(businessId, activePlanId, range),
    billCountsByPlan(businessId, creditIds),
    billCountsByPlan(businessId, creditIds, range),
  ]);
  const creditRows = credits.map(credit => ({ credit, used: creditCounts.get(String(credit._id)) || 0, monthUsed: monthCreditCounts.get(String(credit._id)) || 0 }));
  const planTotal = currentPlan ? Number(currentPlan.planSnapshot.includedBills) : Number(defaults.defaultBills);
  const extraCredits = creditRows.map(({ credit, used }) => {
    const total = Number(credit.packSnapshot.billCount); const pending = Math.max(0, total - used);
    return { id: String(credit._id), packId: String(credit.extraCreditPackId), name: credit.packSnapshot.name, code: credit.packSnapshot.code, price: Number(credit.packSnapshot.price), status: localMonth(credit.createdAt, timeZone) < month ? 'carriedForward' : 'delivered', used, pending, total, purchasedAt: credit.createdAt };
  }).filter(credit => credit.pending > 0);
  const extraMonthUsed = creditRows.reduce((sum, row) => sum + row.monthUsed, 0);
  const extraPending = extraCredits.reduce((sum, credit) => sum + credit.pending, 0);
  const planPending = Math.max(0, planTotal - planUsed);
  let featuredOffers = [];
  if (!currentPlan) {
    const [offers, activePlans] = await Promise.all([PlanOffer.find({ isActive: true }).lean(), Plan.find({ isActive: true }).lean()]);
    const today = localDate(new Date(), timeZone);
    const matches = (values, id) => !values?.length || values.some(value => String(value) === String(id));
    for (const offer of offers) {
      if ((offer.validTill && offer.validTill < today) || offer.amount == null || !matches(offer.userIds, userId) || !matches(offer.businessIds, businessId) || !matches(offer.businessTypeIds, business.businessTypeId)) continue;
      for (const plan of activePlans) {
        if (!matches(offer.planIds, plan._id)) continue;
        const price = amount(plan.monthlyPrice); const discountAmount = Math.min(price, amount(offer.discountType === 'percent' ? price * Number(offer.amount) / 100 : Number(offer.amount)));
        featuredOffers.push({ offerName: offer.name, code: offer.code, planId: String(plan._id), planName: plan.name, includedBills: Number(plan.includedBills), monthlyPrice: price, discountAmount, amountDue: amount(price - discountAmount) });
      }
    }
  }
  return {
    businessId: String(businessId), businessName: business.legalName, businessTypeName: businessType?.name || '', month, activePlan: currentPlan ? { id: activePlanId, name: currentPlan.planSnapshot.name, monthlyPrice: currentPlan.planSnapshot.monthlyPrice, includedBills: planTotal, status: 'active', effectiveMonth: currentPlan.effectiveMonth } : { id: DEFAULT_FREE_PLAN, name: 'Free', monthlyPrice: 0, includedBills: planTotal, status: 'active', effectiveMonth: month },
    activePlanUsage: { used: planUsed, pending: planPending, total: planTotal },
    monthUsage: { used: planUsed + extraMonthUsed, pending: Math.max(0, planTotal + extraMonthUsed + extraPending - planUsed - extraMonthUsed), total: planTotal + extraMonthUsed + extraPending },
    exhausted: planPending + extraPending <= 0,
    extraCredits,
    featuredOffers,
    authorization: { isOwner: owner, permissionKeys: [...keys] },
  };
}
async function availablePlans(businessId, userId) {
  await context(businessId, userId, 'business.plans.view');
  return Plan.find({ isActive: true }).sort({ monthlyPrice: 1, name: 1 }).lean().then(rows => rows.map(row => ({ id: String(row._id), name: row.name, monthlyPrice: Number(row.monthlyPrice), includedBills: Number(row.includedBills) })));
}
async function availableExtraCredits(businessId, userId) {
  await context(businessId, userId, 'business.plans.view');
  return ExtraCreditPack.find({ isActive: true }).sort({ price: 1, name: 1 }).lean().then(rows => rows.map(row => ({ id: String(row._id), code: row.code, name: row.name, price: Number(row.price), billCount: Number(row.billCount) })));
}
async function offerForPlan({ business, userId, plan, code }) {
  if (typeof code !== 'string' || !code.trim()) return null;
  if (code.trim().length > 40) throw fail(400, 'INVALID_OFFER_CODE', 'Enter a valid offer code.');
  const offers = await PlanOffer.find({ isActive: true }).lean();
  const offer = offers.find(row => String(row.code).trim().toLocaleLowerCase() === code.trim().toLocaleLowerCase());
  const timeZone = business.timeZone || process.env.BUSINESS_DEFAULT_TIME_ZONE || 'Asia/Kolkata';
  if (!offer || (offer.validTill && offer.validTill < localDate(new Date(), timeZone))) throw fail(422, 'OFFER_NOT_APPLICABLE', 'This offer is invalid, inactive, or expired.');
  const matches = (values, id) => !values?.length || values.some(value => String(value) === String(id));
  if (!matches(offer.planIds, plan._id) || !matches(offer.userIds, userId) || !matches(offer.businessIds, business._id) || !matches(offer.businessTypeIds, business.businessTypeId)) throw fail(422, 'OFFER_NOT_APPLICABLE', 'This offer does not apply to the selected plan, user, or business.');
  if (offer.amount == null) throw fail(422, 'OFFER_NOT_APPLICABLE', 'This offer has no discount value configured.');
  const price = amount(plan.monthlyPrice);
  const discountAmount = Math.min(price, amount(offer.discountType === 'percent' ? price * Number(offer.amount) / 100 : Number(offer.amount)));
  return { name: offer.name, code: offer.code, discountType: offer.discountType, amount: Number(offer.amount), discountAmount, amountDue: amount(price - discountAmount) };
}
async function validateOffer(businessId, userId, body = {}) {
  const { business } = await context(businessId, userId, 'business.plans.purchase');
  if (!validId(body.planId)) throw fail(400, 'INVALID_PLAN', 'Choose a valid plan.');
  const plan = await Plan.findOne({ _id: body.planId, isActive: true }).lean();
  if (!plan) throw fail(404, 'PLAN_NOT_AVAILABLE', 'This plan is no longer available.');
  const offer = await offerForPlan({ business, userId, plan, code: body.code });
  const price = amount(plan.monthlyPrice); const discountAmount = offer?.discountAmount || 0;
  return { eligible: true, offer, discountAmount, amountDue: amount(price - discountAmount), plan: { id: String(plan._id), name: plan.name, includedBills: plan.includedBills, monthlyPrice: price } };
}
async function purchasePlanUnlocked(businessId, userId, body = {}, key) {
  await context(businessId, userId, 'business.plans.purchase'); key = idempotencyKey(key);
  const prior = await BusinessPlanPurchase.findOne({ businessId, idempotencyKey: key }).lean(); if (prior) return { purchase: publicPlanPurchase(prior), replay: true };
  if (!validId(body.planId)) throw fail(400, 'INVALID_PLAN', 'Choose a valid plan.');
  const plan = await Plan.findOne({ _id: body.planId, isActive: true }).lean(); if (!plan) throw fail(404, 'PLAN_NOT_AVAILABLE', 'This plan is no longer available.');
  const { business } = await context(businessId, userId, 'business.plans.purchase');
  const timeZone = business.timeZone || process.env.BUSINESS_DEFAULT_TIME_ZONE || 'Asia/Kolkata'; const currentMonth = localMonth(new Date(), timeZone);
  const currentPlan = await planState(businessId, currentMonth);
  const effectiveMonth = currentPlan ? nextMonth(currentMonth) : currentMonth;
  let offer = null;
  if (body.offerCode) offer = await offerForPlan({ business, userId, plan, code: body.offerCode });
  const amountPaid = amount(Number(plan.monthlyPrice) - (offer?.discountAmount || 0));
  let purchase;
  try { purchase = await BusinessPlanPurchase.create({ businessId, planId: plan._id, planSnapshot: { name: plan.name, monthlyPrice: Number(plan.monthlyPrice), includedBills: Number(plan.includedBills) }, effectiveMonth, offerSnapshot: offer, amountPaid, idempotencyKey: key, purchasedByUserId: userId }); }
  catch (error) { if (error.code !== 11000) throw error; purchase = await BusinessPlanPurchase.findOne({ businessId, idempotencyKey: key }).lean(); if (purchase) return { purchase: publicPlanPurchase(purchase), replay: true }; throw error; }
  return { purchase: publicPlanPurchase(purchase.toObject()), replay: false };
}
async function purchaseExtraCreditUnlocked(businessId, userId, body = {}, key) {
  await context(businessId, userId, 'business.plans.purchase'); key = idempotencyKey(key);
  const prior = await BusinessExtraCreditPurchase.findOne({ businessId, idempotencyKey: key }).lean(); if (prior) return { purchase: publicCreditPurchase(prior), replay: true };
  if (!validId(body.extraCreditPackId)) throw fail(400, 'INVALID_EXTRA_CREDIT', 'Choose a valid extra-credit pack.');
  const pack = await ExtraCreditPack.findOne({ _id: body.extraCreditPackId, isActive: true }).lean();
  if (!pack) throw fail(404, 'EXTRA_CREDIT_NOT_AVAILABLE', 'This extra-credit pack is no longer available.');
  let purchase;
  try { purchase = await BusinessExtraCreditPurchase.create({ businessId, extraCreditPackId: pack._id, packSnapshot: { code: pack.code, name: pack.name, price: Number(pack.price), billCount: Number(pack.billCount) }, amountPaid: Number(pack.price), idempotencyKey: key, purchasedByUserId: userId }); }
  catch (error) { if (error.code !== 11000) throw error; purchase = await BusinessExtraCreditPurchase.findOne({ businessId, idempotencyKey: key }).lean(); if (purchase) return { purchase: publicCreditPurchase(purchase), replay: true }; throw error; }
  return { purchase: publicCreditPurchase(purchase.toObject()), replay: false };
}
async function purchasePlan(businessId, userId, body, key) { return require('./businessBillsPayments.service').withFinancialLock(businessId, () => purchasePlanUnlocked(businessId, userId, body, key)); }
async function purchaseExtraCredit(businessId, userId, body, key) { return require('./businessBillsPayments.service').withFinancialLock(businessId, () => purchaseExtraCreditUnlocked(businessId, userId, body, key)); }
async function issueEntitlement(businessId, userId) {
  const { business } = await context(businessId, userId, 'business.bills.issue');
  await ensureLegacyPlanIds(businessId);
  const timeZone = business.timeZone || process.env.BUSINESS_DEFAULT_TIME_ZONE || 'Asia/Kolkata'; const month = localMonth(new Date(), timeZone); const range = monthBounds(month, timeZone);
  const state = await planState(businessId, month); const planId = state ? String(state.planId) : DEFAULT_FREE_PLAN;
  const total = state ? Number(state.planSnapshot.includedBills) : Number((await config()).defaultBills);
  const used = await billCount(businessId, planId, range);
  if (used < total) return planId;
  const lots = await BusinessExtraCreditPurchase.find({ businessId, paymentStatus: 'completed' }).sort({ createdAt: 1 }).lean();
  const creditCounts = await billCountsByPlan(businessId, lots.map(lot => String(lot._id)));
  for (const lot of lots) if ((creditCounts.get(String(lot._id)) || 0) < Number(lot.packSnapshot.billCount)) return String(lot._id);
  throw fail(409, 'PLAN_LIMIT_EXHAUSTED', 'This business has used all available bills for the current month. Purchase extra credits to issue another bill.');
}
module.exports = { DEFAULT_FREE_PLAN, dashboard, availablePlans, availableExtraCredits, validateOffer, purchasePlan, purchaseExtraCredit, issueEntitlement, localMonth, localDate, monthBounds };
