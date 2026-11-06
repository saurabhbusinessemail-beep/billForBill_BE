'use strict';
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { access } = require('./businessPeopleTeams.service');
const Business = require('../DB/models/Business');
const User = require('../DB/models/User');
const Order = require('../DB/models/BusinessOrder');
const Lead = require('../DB/models/BusinessLead');
const Bill = require('../DB/models/BusinessBill');
const BillCounter = require('../DB/models/BusinessBillCounter');
const Payment = require('../DB/models/BusinessPayment');
const PaymentCounter = require('../DB/models/BusinessPaymentCounter');
const Allocation = require('../DB/models/BusinessPaymentAllocation');
const Journal = require('../DB/models/BusinessPaymentJournal');
const MethodConfig = require('../DB/models/BusinessPaymentMethodConfig');
const NumberConfig = require('../DB/models/BusinessDocumentNumberConfig');
const TransportConfig = require('../DB/models/BusinessTransportConfig');
const BillImage = require('../DB/models/BusinessBillImage');
const FinancialLock = require('../DB/models/BusinessFinancialLock');
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code, expose: statusCode < 500 });
const idOk = value => mongoose.isValidObjectId(value);
const BILL_FILE_MAX = 20 * 1024 * 1024; const BILL_FILE_COUNT = 10; const BILL_FILE_TOTAL = 100 * 1024 * 1024;
const billBucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'businessBillImages' });
const decimal = value => mongoose.Types.Decimal128.fromString(String(value));
function money(value, field = 'amount', allowZero = false) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) throw fail(400, 'INVALID_AMOUNT', `Enter a valid ${field} with up to two decimal places.`);
  const [whole, fraction = ''] = text.split('.'); const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if ((!allowZero && cents <= 0n) || cents > 100000000000000n) throw fail(400, 'INVALID_AMOUNT', `Enter a valid ${field}.`);
  return cents;
}
function moneyText(cents) { return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`; }
async function withFinancialLock(bid, work) {
  const lockId = crypto.randomUUID(); let acquired = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { const row = await FinancialLock.findOneAndUpdate({ businessId: bid, $or: [{ expiresAt: { $lte: new Date() } }, { lockId }] }, { $set: { businessId: bid, lockId, expiresAt: new Date(Date.now() + 5 * 60 * 1000) } }, { upsert: true, new: true, setDefaultsOnInsert: true }); if (row?.lockId === lockId) { acquired = true; break; } }
    catch (error) { if (error.code !== 11000) throw error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  if (!acquired) throw fail(409, 'FINANCIAL_OPERATION_BUSY', 'Another bill or payment update is in progress. Try again.');
  try { return await work(); } finally { await FinancialLock.deleteOne({ businessId: bid, lockId }).catch(error => console.error('[billing] lock release failed:', error.code || error.name)); }
}
function date(value, field) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw fail(400, 'INVALID_DATE', `Choose a valid ${field}.`); return value; }
async function auth(bid, uid, permission) { return access(bid, uid, permission); }
async function nextNumber(Model, bid, type) {
  const filter = type ? { businessId: bid, billType: type } : { businessId: bid };
  const first = await Model.findOne(filter).lean();
  if (first) return (await Model.findOneAndUpdate(filter, { $inc: { value: 1 } }, { new: true })).value;
  try { const created = await Model.create({ ...filter, value: 1000 }); return created.value; }
  catch (error) { if (error.code !== 11000) throw error; return (await Model.findOneAndUpdate(filter, { $inc: { value: 1 } }, { new: true })).value; }
}
function billView(bill, paidCents = 0n) {
  const total = money(String(bill.grandTotal)); const outstanding = total > paidCents ? total - paidCents : 0n;
  const delivery = bill.status === 'cancelled' ? 'cancelled' : bill.status === 'draft' ? 'draft' : bill.deliveryStatus;
  let paymentStatus = bill.status === 'cancelled' ? 'cancelled' : bill.status === 'draft' && total === 0n ? 'unpaid' : outstanding === 0n ? 'paid' : paidCents > 0n ? 'partially_paid' : 'unpaid';
  if (outstanding > 0n && bill.dueDate < new Date().toISOString().slice(0, 10)) paymentStatus = 'overdue';
  return { ...bill, id: String(bill._id), businessId: String(bill.businessId), partyUserId: bill.partyUserId ? String(bill.partyUserId) : null, orderId: bill.orderId ? String(bill.orderId) : null, leadId: bill.leadId ? String(bill.leadId) : null, grandTotal: moneyText(total), paidAmount: moneyText(paidCents), outstanding: moneyText(outstanding), deliveryStatus: delivery, paymentStatus };
}
async function balances(bid, bills) {
  const ids = bills.map(x => x._id);
  const rows = await Allocation.aggregate([{ $match: { businessId: new mongoose.Types.ObjectId(bid), billId: { $in: ids }, reversedAt: null } }, { $group: { _id: '$billId', amount: { $sum: '$amount' } } }]);
  return new Map(rows.map(x => [String(x._id), money(x.amount.toString(), 'allocated amount', true)]));
}
async function listBills(bid, uid, query = {}) {
  const ctx = await auth(bid, uid, 'business.bills.view'); const page = Math.max(1, parseInt(query.page, 10) || 1); const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 25));
  const filter = { businessId: bid, deletedAt: null };
  if (['sale', 'purchase'].includes(query.type)) filter.billType = query.type;
  if (['draft', 'in_transit', 'delivered', 'received', 'cancelled'].includes(query.deliveryStatus)) filter.deliveryStatus = query.deliveryStatus;
  if (query.from && query.to) { filter.billDate = { $gte: String(query.from).slice(0, 10), $lte: String(query.to).slice(0, 10) }; }
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 80) : '';
  if (search) { const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); const users = await User.find({ $or: [{ displayName: rx }, { phoneE164: rx }] }).distinct('_id'); const orders = await Order.find({ businessId: bid, orderNumber: rx }).distinct('_id'); filter.$or = [{ billNumber: rx }, { 'partySnapshot.name': rx }, { 'partySnapshot.phone': rx }, { orderId: { $in: orders } }, { partyUserId: { $in: users } }]; }
  if (query.paymentStatus === 'overdue') filter.dueDate = { $lt: new Date().toISOString().slice(0, 10) };
  const [rows, total] = await Promise.all([Bill.find(filter).sort({ billDate: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(), Bill.countDocuments(filter)]);
  const paid = await balances(bid, rows);
  const orderIds = rows.map(row => row.orderId).filter(Boolean); const orders = orderIds.length ? await Order.find({ businessId: bid, _id: { $in: orderIds } }).select('_id orderNumber').lean() : []; const orderNumbers = new Map(orders.map(order => [String(order._id), order.orderNumber]));
  let items = rows.map(row => ({ ...billView(row, paid.get(String(row._id)) || 0n), orderNumber: orderNumbers.get(String(row.orderId || '')) || '' }));
  if (query.paymentStatus && query.paymentStatus !== 'all') items = items.filter(row => query.paymentStatus === 'overdue' ? BigInt(row.outstanding.replace('.', '')) > 0n && row.dueDate < new Date().toISOString().slice(0, 10) : row.paymentStatus === query.paymentStatus);
  return { items, page, pageSize, total, hasNextPage: page * pageSize < total, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function summary(bid, uid) {
  const ctx = await auth(bid, uid, 'dashboard.view');
  if (!ctx.keys.has('business.bills.view')) return { billCount: null, receivable: null, payable: null, inTransit: null };
  const bills = await Bill.find({ businessId: bid, deletedAt: null, status: { $ne: 'cancelled' } }).lean(); const paid = await balances(bid, bills);
  let receivable = 0n; let payable = 0n; let inTransit = 0;
  for (const bill of bills) { const remaining = money(String(bill.grandTotal), 'total', true) - (paid.get(String(bill._id)) || 0n); if (remaining > 0n) bill.billType === 'sale' ? receivable += remaining : payable += remaining; if (bill.deliveryStatus === 'in_transit') inTransit += 1; }
  const paymentsCount = ctx.keys.has('business.payments.view') ? await Payment.countDocuments({ businessId: bid }) : null;
  return { billCount: bills.length, salesCount: bills.filter(bill => bill.billType === 'sale').length, purchaseCount: bills.filter(bill => bill.billType === 'purchase').length, receivable: moneyText(receivable), payable: moneyText(payable), inTransit, paymentsCount, currencyCode: bills[0]?.currencyCode || '' };
}
async function party(bid, input, type, newParty = null) {
  if (input && idOk(input)) { const user = await User.findById(input).select('_id displayName phoneE164').lean(); if (!user) throw fail(400, 'PARTY_REQUIRED', `Choose a registered ${type}.`); return { id: user._id, snapshot: { type, name: user.displayName || '', phone: user.phoneE164 || '' }, created: false }; }
  const name = typeof newParty?.name === 'string' ? newParty.name.trim().slice(0, 120) : ''; const phone = typeof newParty?.phoneE164 === 'string' ? newParty.phoneE164.trim() : '';
  if (!name || !/^\+[1-9]\d{7,14}$/.test(phone)) throw fail(400, 'PARTY_REQUIRED', `Enter a registered ${type} name and valid phone number.`);
  const existing = await User.findOne({ phoneE164: phone }).select('_id displayName phoneE164').lean(); if (existing) return { id: existing._id, snapshot: { type, name: existing.displayName || name, phone: existing.phoneE164 }, created: false };
  const alreadyExists = await User.findOne({ phoneE164: phone }).select('_id displayName phoneE164').lean();
  if (alreadyExists) return { id: alreadyExists._id, snapshot: { type, name: alreadyExists.displayName || name, phone: alreadyExists.phoneE164 }, created: false };
  return { id: null, snapshot: { type, name, phone }, pending: { name, phone }, created: false };
}
async function createDraft(bid, uid, body = {}, key) {
  await auth(bid, uid, 'business.bills.create');
  if (!['sale', 'purchase'].includes(body.billType) || !['detailed', 'image'].includes(body.entryMode)) throw fail(400, 'INVALID_BILL', 'Choose a bill type and entry mode.');
  if (typeof key !== 'string' || !/^[A-Za-z0-9-]{16,120}$/.test(key)) throw fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Retry creating this bill from the form.');
  const existing = await Bill.findOne({ businessId: bid, idempotencyKey: key }).lean(); if (existing) return billView(existing);
  const billDate = date(body.billDate, 'bill date'); const dueDate = date(body.dueDate, 'due date'); if (dueDate < billDate) throw fail(400, 'INVALID_DUE_DATE', 'Due date cannot be before bill date.');
  const type = body.billType === 'sale' ? 'customer' : 'supplier'; const partyResult = await party(bid, body.partyUserId, type, body.newParty);
  let order = null; let leadId = null; let lines = []; let amounts; let subtotal;
  if (body.orderId) {
    if (!idOk(body.orderId)) throw fail(400, 'INVALID_ORDER', 'Choose a valid order.');
    order = await Order.findOne({ _id: body.orderId, businessId: bid, deletedAt: null, orderType: body.billType === 'sale' ? 'sales' : 'purchase' }).lean();
    if (!order || order.status === 'cancelled') throw fail(400, 'INVALID_ORDER', 'Choose an eligible order of the same type.');
    if (String(order.contactUserId || '') !== String(partyResult.id)) throw fail(400, 'PARTY_ORDER_MISMATCH', 'The party must match the selected order.');
    const existingBill = await Bill.findOne({ businessId: bid, orderId: order._id, status: { $ne: 'cancelled' }, deletedAt: null }).lean();
    if (existingBill) {
      if (existingBill.billType !== body.billType || existingBill.entryMode !== body.entryMode) throw fail(409, 'ORDER_ALREADY_BILLED', 'This order already has an active bill with a different bill type or entry mode.');
      return billView(existingBill);
    }
    if (body.entryMode !== (order.entryMode === 'image_only' ? 'image' : 'detailed')) throw fail(400, 'ORDER_MODE_MISMATCH', 'Bill entry mode must match the selected order.');
    if (body.entryMode === 'detailed') {
      if (!order.grandTotal) throw fail(409, 'ORDER_TOTAL_UNAVAILABLE', 'This order has no verified total and cannot be billed.');
      subtotal = String(order.subtotal || order.grandTotal); amounts = { subtotal: String(order.subtotal || order.grandTotal), discountTotal: String(order.discountTotal || '0'), taxTotal: String(order.taxTotal || '0'), grandTotal: String(order.grandTotal) }; lines = order.lines || [];
    }
    leadId = order.sourceLeadId || null;
  }
  if (body.entryMode === 'image') {
    const taxable = money(body.imageAmounts?.taxableAmount ?? body.imageAmounts?.subtotal, 'taxable amount', true); const tax = money(body.imageAmounts?.taxAmount ?? '0', 'tax amount', true); subtotal = moneyText(taxable); amounts = { subtotal: moneyText(taxable), discountTotal: '0.00', taxTotal: moneyText(tax), grandTotal: moneyText(taxable + tax) };
  } else if (!order) {
    throw fail(409, 'DETAILED_BILL_REQUIRES_ORDER', 'Create a verified detailed bill from an order. Direct detailed bills are unavailable until currency and tax rules are configured.');
  }
  const currencyCode = String(order?.currencyCode || body.currencyCode || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw fail(409, 'CURRENCY_NOT_CONFIGURED', 'Choose a valid three-letter bill currency before saving this bill.');
  if (order?.currencyCode && body.currencyCode && order.currencyCode !== currencyCode) throw fail(400, 'ORDER_CURRENCY_MISMATCH', 'The bill currency must match its order.');
  const existingCurrency = await Bill.findOne({ businessId: bid, deletedAt: null, status: { $ne: 'cancelled' }, currencyCode: { $ne: null } }).select('currencyCode').lean();
  if (existingCurrency && existingCurrency.currencyCode !== currencyCode) throw fail(409, 'BUSINESS_CURRENCY_MISMATCH', 'Bills in one business must use the same currency until business currency settings are available.');
  if (!partyResult.id) {
    try { const created = await User.create({ phoneE164: partyResult.pending.phone, displayName: partyResult.pending.name, accountStatus: 'provisioned' }); partyResult.id = created._id; partyResult.created = true; }
    catch (error) { if (error.code !== 11000) throw error; const existing = await User.findOne({ phoneE164: partyResult.pending.phone }).select('_id displayName phoneE164').lean(); if (!existing) throw error; partyResult.id = existing._id; partyResult.snapshot = { ...partyResult.snapshot, name: existing.displayName || partyResult.snapshot.name, phone: existing.phoneE164 }; }
  }
  const business = await Business.findById(bid).select('ownerUserId').lean(); const owner = await User.findById(business.ownerUserId).select('displayName phoneE164').lean();
  const snapshot = body.partySnapshot && typeof body.partySnapshot === 'object' ? { ...partyResult.snapshot, address: String(body.partySnapshot.address || '').slice(0, 1000) } : partyResult.snapshot;
  try {
    const created = await Bill.create({ businessId: bid, billType: body.billType, entryMode: body.entryMode, status: 'draft', deliveryStatus: 'draft', billDate, dueDate, partyUserId: partyResult.id, partySnapshot: { ...snapshot, businessOwnerUserId: String(owner?._id || business.ownerUserId) }, orderId: order?._id || null, leadId, currencyCode, currencyScale: order?.currencyScale ?? 2, lines, discounts: body.entryMode === 'detailed' ? (order?.discounts || []) : [], afterDiscount: body.entryMode === 'detailed' ? decimal(String(order?.afterDiscount || amounts.subtotal)) : null, taxes: body.entryMode === 'detailed' ? (order?.taxes || []) : [], imageAmounts: body.entryMode === 'image' ? { taxableAmount: amounts.subtotal, taxAmount: amounts.taxTotal, taxDescription: String(body.imageAmounts?.taxDescription || '').slice(0, 120) } : null, subtotal: decimal(amounts.subtotal), discountTotal: decimal(amounts.discountTotal), taxTotal: decimal(amounts.taxTotal), grandTotal: decimal(amounts.grandTotal), deliveredAtIssue: Boolean(body.deliveredAtIssue), imageIds: [], imageMetadata: [], version: 1, idempotencyKey: key, createdByUserId: uid, updatedByUserId: uid, lifecycleEvents: [{ action: 'draft_created', actorUserId: uid, at: new Date() }] });
    if (order) { await Order.updateOne({ _id: order._id, businessId: bid }, { $set: { billStatus: 'draft', billGeneratedAt: null } }); if (leadId) await Lead.updateOne({ _id: leadId, businessId: bid }, { $set: { billStatus: 'draft', billGeneratedAt: null } }); }
    return billView(created.toObject());
  } catch (error) { if (partyResult.created) { const [hasBill, hasOrder, hasLead] = await Promise.all([Bill.exists({ partyUserId: partyResult.id }), Order.exists({ contactUserId: partyResult.id }), Lead.exists({ contactUserId: partyResult.id })]); if (!hasBill && !hasOrder && !hasLead) await User.deleteOne({ _id: partyResult.id, accountStatus: 'provisioned' }).catch(() => undefined); } if (error.code === 11000) { const prior = await Bill.findOne({ businessId: bid, idempotencyKey: key }).lean(); if (prior) return billView(prior); } throw error; }
}
async function updateDraft(bid, uid, billId, body = {}) {
  const ctx = await auth(bid, uid);
  if (!ctx.owner && !ctx.keys.has('business.bills.edit')) throw fail(403, 'PERMISSION_DENIED', 'You do not have permission to edit draft bills.');
  if (!idOk(billId)) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.');
  const bill = await Bill.findOne({ _id: billId, businessId: bid, deletedAt: null });
  if (!bill) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.');
  if (bill.status !== 'draft') throw fail(409, 'BILL_NOT_EDITABLE', 'Only draft bills can be edited.');
  if (!Number.isInteger(Number(body.version)) || Number(body.version) !== bill.version) throw fail(409, 'STALE_DRAFT', 'This draft changed elsewhere. Reload it before saving.');
  const billDate = date(body.billDate, 'bill date'); const dueDate = date(body.dueDate, 'due date');
  if (dueDate < billDate) throw fail(400, 'INVALID_DUE_DATE', 'Due date cannot be before bill date.');
  const changes = { billDate, dueDate, deliveredAtIssue: Boolean(body.deliveredAtIssue), updatedByUserId: uid };
  let nextTotal = money(String(bill.grandTotal));
  if (bill.entryMode === 'image' && body.imageAmounts) {
    const taxable = money(body.imageAmounts.taxableAmount ?? body.imageAmounts.subtotal, 'taxable amount', true);
    const tax = money(body.imageAmounts.taxAmount ?? '0', 'tax amount', true);
    nextTotal = taxable + tax;
    changes.imageAmounts = { taxableAmount: decimal(moneyText(taxable)), taxAmount: decimal(moneyText(tax)), taxDescription: String(body.imageAmounts.taxDescription || '').slice(0, 120) };
    changes.subtotal = decimal(moneyText(taxable)); changes.taxTotal = decimal(moneyText(tax)); changes.discountTotal = decimal('0.00'); changes.grandTotal = decimal(moneyText(nextTotal));
  }
  const paid = (await balances(bid, [bill.toObject()])).get(String(bill._id)) || 0n;
  if (nextTotal < paid) throw fail(409, 'DRAFT_TOTAL_BELOW_PAID', 'The draft total cannot be lower than payments already allocated to it.');
  const updated = await Bill.findOneAndUpdate({ _id: billId, businessId: bid, status: 'draft', version: bill.version, deletedAt: null }, { $set: changes, $inc: { version: 1 }, $push: { lifecycleEvents: { action: 'draft_edited', actorUserId: uid, at: new Date() } } }, { new: true });
  if (!updated) throw fail(409, 'STALE_DRAFT', 'This draft changed elsewhere. Reload it before saving.');
  return billView(updated.toObject());
}
function verifyDetailedOrderSnapshot(order) {
  if (!order || order.entryMode !== 'detailed' || !Array.isArray(order.lines) || !order.lines.length) return false;
  const code = String(order.currencyCode || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    const lineTotal = lines => lines.reduce((sum, line) => sum + money(String(line.lineTotal), 'line total', true), 0n);
    const subtotal = money(String(order.subtotal), 'subtotal', true);
    const discount = money(String(order.discountTotal || '0'), 'discount total', true);
    const afterDiscount = money(String(order.afterDiscount ?? (subtotal > discount ? moneyText(subtotal - discount) : '0')), 'after discount', true);
    const taxTotal = money(String(order.taxTotal || '0'), 'tax total', true);
    const grandTotal = money(String(order.grandTotal), 'grand total', true);
    const taxRows = Array.isArray(order.taxes) ? order.taxes : [];
    const taxSnapshotTotal = taxRows.reduce((sum, tax) => sum + money(String(tax.amount || '0'), 'tax snapshot', true), 0n);
    const taxAmountsComplete = taxRows.every(tax => tax.amount !== undefined && tax.amount !== null && tax.amount !== '');
    return discount <= subtotal && lineTotal(order.lines) === subtotal && subtotal - discount === afterDiscount && afterDiscount + taxTotal === grandTotal && (!taxAmountsComplete || taxSnapshotTotal === taxTotal);
  } catch { return false; }
}
function verifyDetailedBillSnapshot(bill, order) {
  if (!order || order.entryMode !== 'detailed') return null;
  try {
    const billLines = Array.isArray(bill.lines) ? bill.lines : [];
    const orderLines = Array.isArray(order.lines) ? order.lines : [];
    const lines = billLines.length ? billLines : orderLines;
    if (!lines.length || !lines.every(line => line && line.productId && line.lineTotal !== undefined)) return null;
    const code = String(bill.currencyCode || order.currencyCode || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return null;
    const subtotalCents = lines.reduce((sum, line) => sum + money(String(line.lineTotal), 'line total', true), 0n);
    const discountValue = bill.discountTotal ?? order.discountTotal ?? '0';
    const discountCents = money(String(discountValue), 'discount total', true);
    if (discountCents > subtotalCents) return null;
    const afterDiscountCents = subtotalCents - discountCents;
    const storedGrandTotal = bill.grandTotal ?? order.grandTotal;
    const grandTotalCents = money(String(storedGrandTotal), 'grand total', true);
    if (grandTotalCents < afterDiscountCents) return null;
    const taxTotalCents = grandTotalCents - afterDiscountCents;
    return {
      currencyCode: code, currencyScale: order.currencyScale ?? bill.currencyScale ?? 2, lines,
      subtotal: moneyText(subtotalCents), discountTotal: moneyText(discountCents),
      afterDiscount: moneyText(afterDiscountCents), taxTotal: moneyText(taxTotalCents),
      grandTotal: moneyText(grandTotalCents), discounts: bill.discounts?.length ? bill.discounts : (order.discounts || []),
      taxes: bill.taxes?.length ? bill.taxes : (order.taxes || []),
    };
  } catch { return null; }
}
async function issueUnlocked(bid, uid, billId) {
  await auth(bid, uid, 'business.bills.issue'); if (!idOk(billId)) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.');
  const bill = await Bill.findOne({ _id: billId, businessId: bid, deletedAt: null }); if (!bill) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.'); if (bill.status === 'issued') { if (!bill.planId) { bill.planId = require('./businessPlans.service').DEFAULT_FREE_PLAN; await bill.save(); } if (bill.deliveryStatus === 'delivered' || bill.deliveryStatus === 'received') await postBillInventory(bill.toObject(), uid, 'delivered_at_issue'); if(bill.deliveryStatus==='in_transit') await require('./businessDeliveries.service').createDraftFromBill(bill,uid); return billView(bill.toObject()); } if (bill.status !== 'draft') throw fail(409, 'INVALID_BILL_STATE', 'Only a draft bill can be issued.');
  if (bill.entryMode === 'detailed') {
    const order = bill.orderId ? await Order.findOne({ _id: bill.orderId, businessId: bid, deletedAt: null }).lean() : null;
    const orderVerified = verifyDetailedOrderSnapshot(order);
    const billSnapshot = orderVerified ? null : verifyDetailedBillSnapshot(bill.toObject(), order);
    if (!orderVerified && !billSnapshot) throw fail(409, 'FINANCIAL_RULES_UNAVAILABLE', 'Detailed issue requires a linked detailed order, valid currency, and saved item totals.');
    const alreadyPaid = (await balances(bid, [bill.toObject()])).get(String(bill._id)) || 0n;
    const issueTotal = orderVerified ? money(String(order.grandTotal), 'grand total', true) : money(billSnapshot.grandTotal, 'bill grand total', true);
    if (issueTotal < alreadyPaid) throw fail(409, 'DRAFT_TOTAL_BELOW_PAID', 'The verified total cannot be lower than payments already allocated to this draft.');
    if (orderVerified) {
      // Keep drafts consistent with the source order when its complete snapshot is available.
      bill.currencyCode = String(order.currencyCode).trim().toUpperCase();
      bill.currencyScale = order.currencyScale ?? bill.currencyScale ?? 2;
      bill.lines = order.lines || [];
      bill.subtotal = decimal(String(order.subtotal));
      bill.discountTotal = decimal(String(order.discountTotal || '0'));
      bill.grandTotal = decimal(String(order.grandTotal));
      bill.discounts = order.discounts || [];
      bill.afterDiscount = decimal(String(order.afterDiscount ?? order.subtotal));
      bill.taxTotal = decimal(String(order.taxTotal || '0'));
      bill.taxes = order.taxes || [];
    } else {
      // Repair legacy or partially copied drafts using their persisted item lines
      // and the total already stored on the bill, retaining the linked order's tax
      // snapshots for audit display.
      bill.currencyCode = billSnapshot.currencyCode;
      bill.currencyScale = billSnapshot.currencyScale;
      bill.lines = billSnapshot.lines;
      bill.subtotal = decimal(billSnapshot.subtotal);
      bill.discountTotal = decimal(billSnapshot.discountTotal);
      bill.afterDiscount = decimal(billSnapshot.afterDiscount);
      bill.taxTotal = decimal(billSnapshot.taxTotal);
      bill.grandTotal = decimal(billSnapshot.grandTotal);
      bill.discounts = billSnapshot.discounts;
      bill.taxes = billSnapshot.taxes;
    }
  }
  if (bill.entryMode === 'image' && !bill.imageIds.length) throw fail(400, 'BILL_FILE_REQUIRED', 'Upload at least one bill image or PDF before issuing.');
  bill.planId = await require('./businessPlans.service').issueEntitlement(bid, uid);
  const sequence = await nextNumber(BillCounter, bid, bill.billType); const numberConfig = await NumberConfig.findOne({ businessId: bid }).lean(); const prefix = bill.billType === 'sale' ? (numberConfig?.billSalesPrefix || 'SB') : (numberConfig?.billPurchasePrefix || 'PB'); const at = new Date();
  bill.billNumber = `${prefix}-${sequence}`; bill.sequenceNumber = sequence; bill.status = 'issued'; bill.deliveryStatus = bill.deliveredAtIssue ? (bill.billType === 'sale' ? 'delivered' : 'received') : 'in_transit'; bill.issuedAt = at; bill.issuedByUserId = uid; bill.version += 1; bill.updatedByUserId = uid; bill.lifecycleEvents.push({ action: 'issued', actorUserId: uid, at }); await bill.save();
  if (bill.deliveryStatus === 'delivered' || bill.deliveryStatus === 'received') {
    try { await postBillInventory(bill.toObject(), uid, 'delivered_at_issue'); }
    catch (error) {
      bill.status = 'draft'; bill.deliveryStatus = 'draft'; bill.planId = null; bill.billNumber = null; bill.sequenceNumber = null; bill.issuedAt = null; bill.issuedByUserId = null; bill.version += 1; bill.updatedByUserId = uid;
      if (bill.lifecycleEvents.at(-1)?.action === 'issued') bill.lifecycleEvents.pop();
      await bill.save();
      throw error;
    }
  }
  await syncOrderBillStatus(bill, uid); if (bill.deliveryStatus === 'in_transit') await require('./businessDeliveries.service').createDraftFromBill(bill,uid); return billView(bill.toObject());
}
async function issue(bid, uid, billId) { return withFinancialLock(bid, () => issueUnlocked(bid, uid, billId)); }
async function syncOrderBillStatus(bill, uid) {
  if (!bill.orderId) return;
  const delivered = bill.deliveryStatus === 'delivered' || bill.deliveryStatus === 'received';
  const billStatus = delivered ? 'delivered' : 'confirmed';
  const orderStatus = delivered ? 'delivered' : 'billed';
  const order = await Order.findOneAndUpdate({ _id: bill.orderId, businessId: bill.businessId }, {
    $set: { billStatus, status: orderStatus, billGeneratedAt: bill.issuedAt, deliveryCompleted: delivered, updatedByUserId: uid },
    $inc: { version: 1 },
    $push: { lifecycleEvents: { action: 'bill_status_changed', actorUserId: uid, at: new Date(), billId: bill._id } },
  }, { new: true }).select('sourceLeadId').lean();
  const leadId = bill.leadId || order?.sourceLeadId;
  if (leadId) await Lead.updateOne({ _id: leadId, businessId: bill.businessId }, { $set: { status: orderStatus, orderStatus, billStatus, billGeneratedAt: bill.issuedAt, deliveryCompleted: delivered, updatedByUserId: uid }, $inc: { version: 1 } });
}
async function recordDeliveryStarted(bid, uid, billId, deliveryId, at = new Date()) {
  return withFinancialLock(bid, async () => {
    if (!idOk(billId)) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.');
    const bill = await Bill.findOne({ _id: billId, businessId: bid, deletedAt: null });
    if (!bill || bill.status !== 'issued' || bill.deliveryStatus !== 'in_transit') throw fail(409, 'INVALID_BILL_STATE', 'Only an issued bill in transit can start delivery.');
    const alreadyRecorded = (bill.lifecycleEvents || []).some(event => event.action === 'in_transit' && String(event.deliveryId || '') === String(deliveryId));
    if (!alreadyRecorded) {
      bill.version += 1;
      bill.updatedByUserId = uid;
      bill.lifecycleEvents.push({ action: 'in_transit', actorUserId: uid, at, deliveryId });
      await bill.save();
    }
    await postBillInventory(bill.toObject(), uid, 'delivery_on_move', deliveryId);
    const order = bill.orderId ? await Order.findOne({ _id: bill.orderId, businessId: bid }).select('status').lean() : null;
    if (!['delivered', 'completed_billed'].includes(order?.status)) await syncOrderBillStatus(bill, uid);
  });
}
async function postBillInventory(bill, uid, trigger, deliveryId = '') {
  if (bill.entryMode !== 'detailed') return;
  if (bill.status !== 'issued' || bill.inventoryPosted) return;
  const cycle = Number(bill.inventoryCycle || 0) + 1; const inventory = require('./businessInventory.service'); const applied = [];
  try {
    for (let index = 0; index < (bill.lines || []).length; index += 1) { const line = bill.lines[index]; const lineId = String(line.lineId || line._id || index); const direction = bill.billType === 'sale' ? 'out' : 'in'; const result = await inventory.recordBillMovement(bill.businessId, uid, bill, { ...line, lineId }, direction, `f017:${bill._id}:${cycle}:${lineId}`); if (!result.duplicate) applied.push({ line, lineId, direction }); }
    await Bill.updateOne({ _id: bill._id, businessId: bill.businessId, inventoryPosted: { $ne: true } }, { $set: { inventoryCycle: cycle, inventoryPosted: true }, $push: { lifecycleEvents: { action: 'inventory_posted', trigger, deliveryId: deliveryId || null, actorUserId: uid, at: new Date(), cycle } } });
  } catch (error) {
    for (const item of applied.reverse()) { const inverse = item.direction === 'in' ? 'out' : 'in'; await inventory.recordBillMovement(bill.businessId, uid, bill, { ...item.line, lineId: item.lineId }, inverse, `f017:${bill._id}:${cycle}:${item.lineId}:rollback`, true).catch(() => undefined); }
    throw error;
  }
}
async function changeDeliveryUnlocked(bid, uid, billId, body = {}) {
  await auth(bid, uid, 'business.bills.delivery.manage'); if (!idOk(billId)) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.');
  const bill = await Bill.findOne({ _id: billId, businessId: bid, deletedAt: null }); if (!bill) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.');
  const expected = bill.billType === 'sale' ? 'delivered' : 'received'; if (bill.status !== 'issued' || bill.deliveryStatus === 'cancelled') throw fail(409, 'INVALID_BILL_STATE', 'Only an issued, active bill can change delivery status.');
  if (!['in_transit', expected].includes(body.deliveryStatus) || body.deliveryStatus === bill.deliveryStatus) throw fail(400, 'INVALID_DELIVERY_STATUS', 'Choose a valid new delivery status.');
  if (body.deliveryStatus === 'in_transit' && !String(body.reason || '').trim()) throw fail(400, 'REASON_REQUIRED', 'Add a reason for correcting the delivery status.');
  const deliveryFilter = { businessId: bid, status: { $ne: 'delivered' }, $or: [{ billId: bill._id }, ...(bill.orderId ? [{ orderId: bill.orderId }] : [])] };
  const delivery = body.deliveryStatus === expected && !body.deliveryCompletion ? await require('../DB/models/BusinessDelivery').findOne(deliveryFilter).sort({ updatedAt: -1 }) : null;
  const at = new Date();
  if (delivery?.status === 'draft') bill.lifecycleEvents.push({ action: 'in_transit', actorUserId: uid, at, deliveryId: delivery._id });
  bill.deliveryStatus = body.deliveryStatus; bill.version += 1; bill.updatedByUserId = uid; bill.lifecycleEvents.push({ action: body.deliveryStatus, reason: String(body.reason || '').slice(0, 500), actorUserId: uid, at }); await bill.save(); await syncOrderBillStatus(bill, uid);
  if (delivery) await require('./businessDeliveries.service').completeForBill(bid, uid, String(bill._id), body.completionSource || 'Bill', bill.orderId ? String(bill.orderId) : null);
  if (bill.deliveryStatus === 'delivered' || bill.deliveryStatus === 'received') {
    if (!body.deliveryCompletion && (!delivery || ['draft', 'cancelled'].includes(delivery.status))) await postBillInventory(bill.toObject(), uid, delivery ? 'marked_delivered_before_start' : 'marked_delivered_without_delivery', delivery?._id ? String(delivery._id) : '');
  }
  if (bill.deliveryStatus === 'in_transit') await require('./businessDeliveries.service').createDraftFromBill(bill,uid); const paid = await balances(bid, [bill.toObject()]); return billView(bill.toObject(), paid.get(String(bill._id)) || 0n);
}
async function changeDelivery(bid, uid, billId, body = {}) { return withFinancialLock(bid, () => changeDeliveryUnlocked(bid, uid, billId, body)); }
async function cancellationPayments(bid, bills) {
  if (!bills.length) return [];
  const rows = await Allocation.find({ businessId: bid, billId: { $in: bills.map(bill => bill._id) }, reversedAt: null }).populate('paymentId', 'paymentNumber').lean();
  const grouped = new Map();
  for (const row of rows) {
    const paymentId = String(row.paymentId?._id || row.paymentId || ''); if (!paymentId) continue;
    const current = grouped.get(paymentId) || { paymentNumber: row.paymentId?.paymentNumber || paymentId, amount: 0n, bills: new Map() };
    const amount = money(String(row.amount), 'payment allocation', true); current.amount += amount;
    const bill = bills.find(item => String(item._id) === String(row.billId)); if (bill) current.bills.set(bill.billNumber || String(bill._id), (current.bills.get(bill.billNumber || String(bill._id)) || 0n) + amount);
    grouped.set(paymentId, current);
  }
  return [...grouped.values()].map(item => ({ paymentNumber: item.paymentNumber, amount: moneyText(item.amount), bills: [...item.bills].map(([billNumber, amount]) => ({ billNumber, amount: moneyText(amount) })) }));
}
function cancellationBlocked(code, message, details = {}) { throw Object.assign(fail(409, code, message), { details }); }
async function relatedLeads(bid, order, bills) {
  const ids = new Set([...(order?.sourceLeadId ? [String(order.sourceLeadId)] : []), ...bills.map(bill => bill.leadId && String(bill.leadId)).filter(Boolean)]);
  const conditions = [{ convertedOrderId: { $in: order ? [order._id] : [] } }]; if (ids.size) conditions.push({ _id: { $in: [...ids] } });
  return Lead.find({ businessId: bid, $or: conditions }).setOptions({ strictQuery: false });
}
async function cancelLinkedRecords(bid, uid, order, bills, at) {
  for (const bill of bills) {
    if (bill.status === 'cancelled' && bill.deliveryStatus === 'cancelled') continue;
    bill.status = 'cancelled'; bill.deliveryStatus = 'cancelled'; bill.cancelledAt = at; bill.cancelledByUserId = uid; bill.updatedByUserId = uid; bill.version += 1;
    bill.lifecycleEvents.push({ action: 'cancelled', actorUserId: uid, at }); await bill.save();
  }
  if (order && order.status !== 'cancelled') {
    order.status = 'cancelled'; order.billStatus = bills.length ? 'cancelled' : order.billStatus; order.deliveryCompleted = false; order.cancelledAt = at; order.cancelledByUserId = uid; order.updatedByUserId = uid; order.version += 1;
    order.lifecycleEvents.push({ action: 'cancelled', actorUserId: uid, at, billIds: bills.map(bill => bill._id) }); await order.save();
  }
  const leads = await relatedLeads(bid, order, bills);
  for (const lead of leads) {
    lead.status = 'cancelled'; lead.orderStatus = 'cancelled'; if (lead.billStatus || bills.length) lead.billStatus = 'cancelled'; lead.deliveryCompleted = false; lead.cancelledAt = at; lead.cancelledByUserId = uid; lead.updatedByUserId = uid; lead.version += 1;
    lead.lifecycleEvents.push({ action: 'cancelled', actorUserId: uid, at, orderId: order?._id || null, billIds: bills.map(bill => bill._id) }); await lead.save();
  }
}
async function cancelBillUnlocked(bid, uid, billId) {
  await auth(bid, uid, 'business.bills.delete'); if (!idOk(billId)) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.');
  const target = await Bill.findOne({ _id: billId, businessId: bid, deletedAt: null }); if (!target) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.');
  if (target.status === 'cancelled') return billView(target.toObject());
  const order = target.orderId ? await Order.findOne({ _id: target.orderId, businessId: bid, deletedAt: null }) : null;
  const bills = target.orderId ? await Bill.find({ businessId: bid, orderId: target.orderId, deletedAt: null, status: { $ne: 'cancelled' } }) : [target];
  const delivered = bills.filter(bill => ['delivered', 'received'].includes(bill.deliveryStatus) || bill.inventoryPosted || (bill.status === 'issued' && bill.deliveredAtIssue));
  if (delivered.length || (order && (['delivered', 'completed_billed'].includes(order.status) || order.deliveryCompleted || order.billStatus === 'delivered'))) cancellationBlocked('CANCEL_BLOCKED_DELIVERED', 'This bill or linked order has already been delivered. Create a return instead of cancelling it.', { deliveredBills: delivered.map(bill => bill.billNumber || String(bill._id)), orderNumber: order?.orderNumber || '' });
  const payments = await cancellationPayments(bid, bills);
  if (payments.length) cancellationBlocked('CANCEL_BLOCKED_PAYMENT', 'Reverse the recorded payments before cancelling this bill.', { payments });
  const at = new Date(); await cancelLinkedRecords(bid, uid, order, bills, at);
  const cancelled = bills.find(bill => String(bill._id) === String(target._id)) || target; return billView(cancelled.toObject());
}
async function cancelBill(bid, uid, billId) { return withFinancialLock(bid, () => cancelBillUnlocked(bid, uid, billId)); }
async function cancelOrder(bid, uid, orderId, version) {
  return withFinancialLock(bid, async () => {
    await auth(bid, uid, 'business.orders.delete'); if (!idOk(orderId)) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Order not found.');
    const order = await Order.findOne({ _id: orderId, businessId: bid, deletedAt: null }); if (!order) throw fail(404, 'DOCUMENT_NOT_FOUND', 'Order not found.');
    if (order.status === 'cancelled') return { ...order.toObject(), id: String(order._id) };
    if (Number(version) !== order.version) throw fail(409, 'DOCUMENT_STALE', 'This order changed elsewhere. Reload and try again.');
    const bills = await Bill.find({ businessId: bid, orderId, deletedAt: null, status: { $ne: 'cancelled' } });
    if (bills.length) await auth(bid, uid, 'business.bills.delete');
    const delivered = bills.filter(bill => ['delivered', 'received'].includes(bill.deliveryStatus) || bill.inventoryPosted || (bill.status === 'issued' && bill.deliveredAtIssue));
    if (delivered.length || ['delivered', 'completed_billed'].includes(order.status) || order.deliveryCompleted || order.billStatus === 'delivered') cancellationBlocked('CANCEL_BLOCKED_DELIVERED', 'This order or one of its bills has already been delivered. Create a return instead of cancelling it.', { deliveredBills: delivered.map(bill => bill.billNumber || String(bill._id)), orderNumber: order.orderNumber });
    const payments = await cancellationPayments(bid, bills);
    if (payments.length) cancellationBlocked('CANCEL_BLOCKED_PAYMENT', 'Reverse the recorded payments before cancelling this order.', { payments });
    await cancelLinkedRecords(bid, uid, order, bills, new Date()); return { ...order.toObject(), id: String(order._id), status: 'cancelled', billStatus: bills.length ? 'cancelled' : order.billStatus };
  });
}
async function deleteDraft(bid, uid, billId) { await auth(bid, uid, 'business.bills.delete'); const bill = await Bill.findOne({ _id: billId, businessId: bid, status: 'draft', deletedAt: null }); if (!bill) throw fail(404, 'BILL_NOT_FOUND', 'Draft bill not found.'); bill.deletedAt = new Date(); bill.deletedByUserId = uid; await bill.save(); return { deleted: true }; }
function billFileInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > BILL_FILE_MAX) throw fail(413, 'BILL_FILE_TOO_LARGE', 'Each bill file must be 20 MiB or smaller.');
  if (bytes.length >= 8 && bytes.toString('hex', 0, 8) === '89504e470d0a1a0a') return { contentType: 'image/png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { contentType: 'image/jpeg' };
  if (bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-') return { contentType: 'application/pdf' };
  throw fail(400, 'INVALID_BILL_FILE', 'Upload a valid JPEG, PNG, or PDF bill.');
}
function cleanFilename(value) { const name = String(value || 'bill-document').replace(/[\\/\r\n\0]/g, '_').trim().slice(0, 180); return name || 'bill-document'; }
async function uploadFile(bid, uid, billId, bytes, filename) {
  const ctx = await auth(bid, uid); if (!ctx.owner && !ctx.keys.has('business.bills.edit') && !ctx.keys.has('business.bills.create')) throw fail(403, 'PERMISSION_DENIED', 'You do not have permission to upload bill files.'); if (!idOk(billId)) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.');
  const bill = await Bill.findOne({ _id: billId, businessId: bid, status: 'draft', entryMode: 'image', deletedAt: null }); if (!bill) throw fail(404, 'BILL_NOT_FOUND', 'Open image bill not found.');
  if (!ctx.owner && !ctx.keys.has('business.bills.edit') && String(bill.createdByUserId) !== String(uid)) throw fail(403, 'PERMISSION_DENIED', 'You do not have permission to edit this bill.');
  const info = billFileInfo(bytes); const safeName = cleanFilename(filename); const currentSize = (bill.imageMetadata || []).reduce((sum, item) => sum + Number(item.size || 0), 0);
  if (bill.imageIds.length >= BILL_FILE_COUNT || currentSize + bytes.length > BILL_FILE_TOTAL) throw fail(413, 'BILL_FILE_SET_TOO_LARGE', 'A bill can contain up to 10 files and 100 MiB total.');
  const fileId = new mongoose.Types.ObjectId(); const checksum = crypto.createHash('sha256').update(bytes).digest('hex'); const bucket = billBucket();
  // GridFSBucket expects `id`; `_id` is ignored and leaves the metadata row
  // pointing at an ObjectId different from the stored binary's ObjectId.
  const stream = bucket.openUploadStream(safeName, { id: fileId, contentType: info.contentType, metadata: { businessId: String(bid), billId: String(billId), checksum } });
  await new Promise((resolve, reject) => { stream.once('error', reject); stream.once('finish', resolve); stream.end(bytes); });
  try {
    const image = await BillImage.create({ businessId: bid, billId, fileId, filename: safeName, contentType: info.contentType, size: bytes.length, checksum, uploadedByUserId: uid });
    const updated = await Bill.findOneAndUpdate({ _id: billId, businessId: bid, status: 'draft', version: bill.version, deletedAt: null }, { $addToSet: { imageIds: image._id }, $push: { imageMetadata: { id: String(image._id), filename: safeName, contentType: info.contentType, size: bytes.length, checksum, createdAt: image.createdAt } }, $inc: { version: 1 }, $set: { updatedByUserId: uid } }, { new: true });
    if (!updated) throw fail(409, 'STALE_BILL_DRAFT', 'The bill changed while the file was uploading. Refresh and try again.');
    return { id: String(image._id), filename: safeName, contentType: info.contentType, size: bytes.length };
  } catch (error) { await BillImage.deleteOne({ fileId }).catch(() => undefined); await bucket.delete(fileId).catch(() => undefined); throw error; }
}
async function billFileStream(bid, uid, billId, fileId) {
  await auth(bid, uid, 'business.bills.view'); if (!idOk(billId) || !idOk(fileId)) throw fail(404, 'BILL_FILE_NOT_FOUND', 'Bill file not found.');
  const [bill, image] = await Promise.all([Bill.findOne({ _id: billId, businessId: bid, deletedAt: null }).select('_id imageIds').lean(), BillImage.findOne({ _id: fileId, businessId: bid, billId, deletedAt: null }).lean()]);
  if (!bill || !image || !bill.imageIds.some(x => String(x) === String(fileId))) throw fail(404, 'BILL_FILE_NOT_FOUND', 'Bill file not found.');
  const bucket = billBucket(); let storedFileId = image.fileId;
  const files = mongoose.connection.db.collection('businessBillImages.files');
  const storedFile = await files.findOne({ _id: storedFileId }, { projection: { _id: 1 } });
  if (!storedFile) {
    // Recover binaries written before uploads used GridFS's correct `id` option.
    const recovered = await files.findOne({
      'metadata.businessId': String(bid),
      'metadata.billId': String(billId),
      'metadata.checksum': image.checksum,
    }, { projection: { _id: 1 } });
    if (!recovered) throw fail(404, 'BILL_FILE_BINARY_NOT_FOUND', 'The saved bill image could not be found.');
    storedFileId = recovered._id;
    await BillImage.updateOne({ _id: image._id }, { $set: { fileId: storedFileId } });
  }
  return { image, stream: bucket.openDownloadStream(storedFileId) };
}
async function paymentDetails(bid, uid) { const ctx = await auth(bid, uid); if (!ctx.keys.has('business.payments.view') && !ctx.keys.has('business.payments.create') && !ctx.keys.has('business.paymentMethods.manage')) throw fail(403, 'PERMISSION_DENIED', 'You do not have permission to view payment settings.'); return (await MethodConfig.findOne({ businessId: bid }).lean())?.fields || { cash: { paidBy: 'optional' }, upi: { upiId: 'optional', transactionReference: 'optional' }, card: { lastFour: 'optional', approvalCode: 'optional' }, bank_transfer: { reference: 'optional', bankName: 'optional' } }; }
const DEFAULT_NUMBER_CONFIG = { orderSalesPrefix: 'SO', orderPurchasePrefix: 'PO', billSalesPrefix: 'SB', billPurchasePrefix: 'PB', paymentPrefix: 'PAY', deliveryPrefix: 'DLV' };
async function documentNumberConfig(bid, uid) { await auth(bid, uid, 'business.paymentMethods.manage'); const row = await NumberConfig.findOne({ businessId: bid }).lean(); return { ...DEFAULT_NUMBER_CONFIG, ...(row || {}) }; }
async function saveDocumentNumberConfig(bid, uid, values) { await auth(bid, uid, 'business.paymentMethods.manage'); const normalized = {}; for (const key of Object.keys(DEFAULT_NUMBER_CONFIG)) { const value = String(values?.[key] ?? DEFAULT_NUMBER_CONFIG[key]).trim(); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,11}$/.test(value)) throw fail(400, 'INVALID_NUMBER_PREFIX', 'Prefixes must contain 1 to 12 letters, numbers, hyphens, or underscores.'); normalized[key] = value; } await NumberConfig.findOneAndUpdate({ businessId: bid }, { $set: { ...normalized, updatedByUserId: uid } }, { upsert: true, new: true, setDefaultsOnInsert: true }); return normalized; }
const TRANSPORT_FIELDS = { inPerson: ['carriedBy', 'phone', 'notes'], bikeScooter: ['vehicleNumber', 'riderName', 'riderPhone'], autoTempo: ['vehicleNumber', 'driverName', 'driverPhone'], car: ['vehicleNumber', 'driverName', 'driverPhone'], truck: ['vehicleNumber', 'driverName', 'driverPhone', 'lrBiltyNumber', 'ewayBillNumber'], bus: ['busOperator', 'busNumber', 'ticketReceiptNumber', 'departure', 'conductorDriverPhone'], train: ['trainNumber', 'trainName', 'pnr', 'coachParcelVan', 'railwayReceiptNumber', 'departure'], flight: ['airline', 'flightNumber', 'pnr', 'airWaybillNumber', 'departure'], courier: ['courierPartner', 'trackingAwbNumber', 'trackingLink', 'expectedDelivery'], shipCargo: ['vesselName', 'containerNumber', 'billOfLadingNumber', 'portOfLoading'], other: ['describeTransport', 'referenceNumber'], handedToCustomer: ['receivedBy', 'receiverPhone', 'deliveryOtpCode', 'notes'] };
function normalizeTransportFields(values = {}) { if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail(400, 'INVALID_TRANSPORT_CONFIGURATION', 'Transport detail settings must be an object of booleans.'); const normalized = {}; for (const [type, keys] of Object.entries(TRANSPORT_FIELDS)) { normalized[type] = {}; for (const key of keys) { const value = values?.[type]?.[key] ?? false; if (typeof value !== 'boolean') throw fail(400, 'INVALID_TRANSPORT_CONFIGURATION', 'Transport detail settings must be true or false.'); normalized[type][key] = value; } } return normalized; }
async function transportConfig(bid, uid) { const permission=await access(bid,uid); if(!permission.owner&&!permission.keys.has('business.transportConfig.manage')&&!permission.keys.has('business.transport.manage'))throw fail(403,'PERMISSION_DENIED','You do not have permission to view transport details.'); const row = await TransportConfig.findOne({ businessId: bid }).lean(); return normalizeTransportFields(row?.fields || {}); }
async function saveTransportConfig(bid, uid, fields) { await auth(bid, uid, 'business.transportConfig.manage'); const normalized = normalizeTransportFields(fields); await TransportConfig.findOneAndUpdate({ businessId: bid }, { $set: { fields: normalized, updatedByUserId: uid } }, { upsert: true, new: true, setDefaultsOnInsert: true }); return normalized; }
async function lookupBillParty(bid, uid, countryCallingCode, phoneNumber) { await auth(bid, uid, 'business.bills.create'); const code = String(countryCallingCode || '').trim(); const national = String(phoneNumber || '').replace(/\D/g, ''); if (!/^\+[1-9]\d{0,3}$/.test(code) || national.length < 7 || national.length > 12) throw fail(400, 'INVALID_PHONE', 'Enter a valid customer or supplier number.'); const phoneE164 = `${code}${national}`; const user = await User.findOne({ phoneE164 }).select('_id displayName phoneE164').lean(); return user ? { exists: true, userId: String(user._id), name: user.displayName || '', phone: user.phoneE164 } : { exists: false }; }
async function savePaymentMethodConfig(bid, uid, fields) {
  await auth(bid, uid, 'business.paymentMethods.manage'); const allowed = { cash: ['paidBy'], upi: ['upiId', 'transactionReference'], card: ['lastFour', 'approvalCode'], bank_transfer: ['reference', 'bankName'] }; const normalized = {};
  for (const [method, keys] of Object.entries(allowed)) { normalized[method] = {}; for (const key of keys) { const state = fields?.[method]?.[key] || 'optional'; if (!['disabled', 'optional', 'required'].includes(state)) throw fail(400, 'INVALID_METHOD_CONFIGURATION', 'Choose valid payment detail requirements.'); normalized[method][key] = state; } }
  await MethodConfig.findOneAndUpdate({ businessId: bid }, { $set: { fields: normalized, updatedByUserId: uid } }, { upsert: true, new: true, setDefaultsOnInsert: true }); return normalized;
}
function validateMethodDetails(method, details, fields) {
  const config = fields[method] || {}; const allowed = Object.keys(config); const values = {};
  for (const key of allowed) { const value = String(details?.[key] || '').trim().slice(0, 120); if (config[key] === 'required' && !value) throw fail(400, 'PAYMENT_DETAILS_REQUIRED', `Enter the required ${key} payment detail.`); if (config[key] !== 'disabled' && value) { if (key === 'lastFour' && !/^\d{4}$/.test(value)) throw fail(400, 'INVALID_PAYMENT_DETAILS', 'Enter only the last four card digits.'); values[key] = value; } }
  return values;
}
async function pendingBills(bid, uid, query = {}) {
  await auth(bid, uid, 'business.payments.view'); const filter = { businessId: bid, deletedAt: null, status: { $in: ['draft', 'issued'] } };
  if (query.partyUserId) filter.partyUserId = query.partyUserId;
  if (query.direction) filter.billType = query.direction === 'incoming' ? 'sale' : 'purchase';
  const docs = await Bill.find(filter).sort({ dueDate: 1, billDate: 1, billNumber: 1 }).limit(100).lean(); const paid = await balances(bid, docs);
  const today = new Date().toISOString().slice(0, 10);
  return docs.map(x => billView(x, paid.get(String(x._id)) || 0n)).filter(x => BigInt(x.outstanding.replace('.', '')) > 0n).map(x => ({ ...x, paymentStatus: x.dueDate < today ? 'overdue' : x.paymentStatus }));
}
async function createPaymentUnlocked(bid, uid, body = {}, key) {
  const paymentAccess = await auth(bid, uid, 'business.payments.create'); if (!paymentAccess.keys.has('business.bills.view')) throw fail(403, 'PERMISSION_DENIED', 'You also need permission to view the bills being paid.'); if (typeof key !== 'string' || !/^[A-Za-z0-9-]{16,120}$/.test(key)) throw fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Retry recording this payment from the form.');
  const prior = await Payment.findOne({ businessId: bid, idempotencyKey: key }).lean(); if (prior) return { ...prior, id: String(prior._id) };
  const direction = body.direction; if (!['incoming', 'outgoing'].includes(direction)) throw fail(400, 'INVALID_DIRECTION', 'Choose a payment direction.');
  const amount = money(body.amount, 'payment amount'); const paymentDate = date(body.paymentDate, 'payment date'); if (paymentDate > new Date().toISOString().slice(0, 10)) throw fail(400, 'FUTURE_PAYMENT_DATE', 'Payment date cannot be in the future.');
  const method = body.method; if (!['cash', 'upi', 'card', 'bank_transfer'].includes(method)) throw fail(400, 'INVALID_PAYMENT_METHOD', 'Choose a payment method.');
  const ids = [...new Set((Array.isArray(body.allocations) ? body.allocations : []).map(x => String(x.billId || '')))]; if (ids.some(x => !idOk(x))) throw fail(400, 'INVALID_ALLOCATION', 'Choose valid bills.');
  const bills = ids.length ? await Bill.find({ _id: { $in: ids }, businessId: bid, deletedAt: null, status: { $in: ['draft', 'issued'] } }) : [];
  if (bills.length !== ids.length) throw fail(400, 'BILL_NOT_ELIGIBLE', 'One or more selected bills are unavailable.');
  const partyId = body.partyUserId || bills[0]?.partyUserId; const partyResult = await party(bid, partyId, direction === 'incoming' ? 'customer' : 'supplier');
  if (bills.some(b => String(b.partyUserId) !== String(partyResult.id) || (direction === 'incoming' ? b.billType !== 'sale' : b.billType !== 'purchase'))) throw fail(400, 'MIXED_PARTIES', 'Selected bills must have the same party and direction.');
  const currencyCode = String(bills[0]?.currencyCode || body.currencyCode || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode) || bills.some(b => b.currencyCode !== currencyCode)) throw fail(409, 'CURRENCY_NOT_CONFIGURED', 'Choose bills that share a configured currency before recording this payment.');
  const business = await Business.findById(bid).select('ownerUserId').lean(); const fields = await paymentDetails(bid, uid); const details = validateMethodDetails(method, body.methodDetails, fields);
  const totalByBill = await balances(bid, bills); const allocations = []; let allocatedTotal = 0n;
  for (const item of (body.allocations || [])) { const bill = bills.find(x => String(x._id) === String(item.billId)); if (!bill) continue; const part = money(item.amount, 'allocation'); const remaining = money(String(bill.grandTotal), 'bill total', true) - (totalByBill.get(String(bill._id)) || 0n); if (part > remaining) throw fail(409, 'OVER_ALLOCATION', 'An allocation exceeds the bill balance. Refresh and try again.'); allocations.push({ bill, amount: part }); allocatedTotal += part; }
  if (allocatedTotal > amount) throw fail(400, 'ALLOCATION_EXCEEDS_PAYMENT', 'Bill allocations cannot exceed the payment amount.');
  const remainder = amount - allocatedTotal; const number = await nextNumber(PaymentCounter, bid); const numberConfig = await NumberConfig.findOne({ businessId: bid }).lean(); const paymentId = new mongoose.Types.ObjectId(); const now = new Date();
  const payment = { _id: paymentId, businessId: bid, paymentNumber: `${numberConfig?.paymentPrefix || 'PAY'}-${number}`, direction, partyUserId: partyResult.id, partySnapshot: partyResult.snapshot, amount: decimal(moneyText(amount)), currencyCode, paymentDate, method, methodDetails: details, methodConfigurationSnapshot: fields[method] || {}, note: String(body.note || '').trim().slice(0, 1000), idempotencyKey: key, actorUserId: uid };
  const journal = { businessId: bid, paymentId, event: 'payment', currencyCode: payment.currencyCode, amount: payment.amount, entries: direction === 'incoming' ? [{ account: 'business_cash', userId: String(business.ownerUserId), debit: moneyText(amount), credit: '0.00' }, { account: 'party_receivable_or_credit', userId: String(partyResult.id), debit: '0.00', credit: moneyText(amount) }] : [{ account: 'party_payable_or_advance', userId: String(partyResult.id), debit: moneyText(amount), credit: '0.00' }, { account: 'business_cash', userId: String(business.ownerUserId), debit: '0.00', credit: moneyText(amount) }], actorUserId: uid };
  try {
    await Payment.create(payment);
    if (allocations.length) await Allocation.insertMany(allocations.map(x => ({ businessId: bid, paymentId, billId: x.bill._id, amount: decimal(moneyText(x.amount)), kind: 'payment', actorUserId: uid })), { ordered: true });
    await Journal.create(journal);
  } catch (error) {
    await Journal.deleteOne({ businessId: bid, paymentId }).catch(() => undefined); await Allocation.deleteMany({ businessId: bid, paymentId }).catch(() => undefined); await Payment.deleteOne({ _id: paymentId, businessId: bid }).catch(() => undefined); throw error;
  }
  return { ...payment, id: String(paymentId), allocatedAmount: moneyText(allocatedTotal), advanceAmount: moneyText(remainder), allocationCount: allocations.length };
}
async function createPayment(bid, uid, body = {}, key) { return withFinancialLock(bid, () => createPaymentUnlocked(bid, uid, body, key)); }
async function listPayments(bid, uid, query = {}) {
  const ctx = await auth(bid, uid, 'business.payments.view'); const page = Math.max(1, parseInt(query.page, 10) || 1); const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 25)); const filter = { businessId: bid };
  if (['incoming', 'outgoing'].includes(query.direction)) filter.direction = query.direction; if (['cash', 'upi', 'card', 'bank_transfer', 'cheque'].includes(query.method)) filter.method = query.method; if (query.method === 'advance_credit') { const candidates = await Payment.find({ businessId: bid }).select('_id amount').lean(); const allocated = await Allocation.aggregate([{ $match: { businessId: new mongoose.Types.ObjectId(bid), reversedAt: null } }, { $group: { _id: '$paymentId', amount: { $sum: '$amount' } } }]); const sums = new Map(allocated.map(x => [String(x._id), money(String(x.amount), 'allocated amount', true)])); filter._id = { $in: candidates.filter(x => money(String(x.amount)) > (sums.get(String(x._id)) || 0n)).map(x => x._id) }; } if (query.from && query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.from) && /^\d{4}-\d{2}-\d{2}$/.test(query.to)) filter.paymentDate = { $gte: query.from, $lte: query.to }; if (query.search) { const rx = new RegExp(String(query.search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); filter.$or = [{ paymentNumber: rx }, { 'partySnapshot.name': rx }, { 'partySnapshot.phone': rx }, { note: rx }]; } if (query.partyUserId && idOk(query.partyUserId)) filter.partyUserId = query.partyUserId;
  const [items, total] = await Promise.all([Payment.find(filter).sort({ paymentDate: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(), Payment.countDocuments(filter)]);
  const ids = items.map(x => x._id); const allocations = await Allocation.find({ businessId: bid, paymentId: { $in: ids }, reversedAt: null }).populate({ path: 'billId', select: 'billNumber' }).lean(); const byPayment = new Map(); const billsByPayment = new Map(); for (const a of allocations) { byPayment.set(String(a.paymentId), (byPayment.get(String(a.paymentId)) || 0n) + money(String(a.amount), 'allocation', true)); const values = billsByPayment.get(String(a.paymentId)) || []; if (a.billId?.billNumber) values.push(a.billId.billNumber); billsByPayment.set(String(a.paymentId), values); }
  return { items: items.map(x => ({ ...x, id: String(x._id), amount: String(x.amount), allocatedAmount: moneyText(byPayment.get(String(x._id)) || 0n), advanceAmount: moneyText(money(String(x.amount)) - (byPayment.get(String(x._id)) || 0n)), settledBills: billsByPayment.get(String(x._id)) || [] })), page, pageSize, total, hasNextPage: page * pageSize < total, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function listPartyBalances(bid, uid, query = {}) {
  const ctx = await auth(bid, uid, 'business.payments.view');
  const bills = await Bill.find({ businessId: bid, deletedAt: null, status: 'issued', billType: { $in: query.direction === 'incoming' ? ['sale'] : query.direction === 'outgoing' ? ['purchase'] : ['sale', 'purchase'] } }).lean();
  const paidByBill = await balances(bid, bills); const parties = new Map();
  for (const bill of bills) { const outstanding = money(String(bill.grandTotal), 'bill total', true) - (paidByBill.get(String(bill._id)) || 0n); if (outstanding <= 0n || !bill.partyUserId) continue; const side = bill.billType === 'sale' ? 'incoming' : 'outgoing'; if (query.direction && query.direction !== 'all' && query.direction !== side) continue; const id = String(bill.partyUserId); const party = parties.get(id) || { id, name: bill.partySnapshot?.name || '', phone: bill.partySnapshot?.phone || '', type: bill.partySnapshot?.type || (side === 'incoming' ? 'customer' : 'supplier'), billed: 0n, paid: 0n, outstanding: 0n, openBills: 0, overdue: false, direction: side, currencyCode: bill.currencyCode || '' }; party.billed += money(String(bill.grandTotal), 'bill total', true); party.paid += paidByBill.get(String(bill._id)) || 0n; party.outstanding += outstanding; party.openBills++; if (bill.dueDate && bill.dueDate < new Date().toISOString().slice(0,10)) party.overdue = true; parties.set(id, party); }
  const rx = query.search ? new RegExp(String(query.search).slice(0,100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const rows = [...parties.values()].filter(p => !rx || rx.test(p.name) || rx.test(p.phone)).map(p => ({ ...p, billed: moneyText(p.billed), paid: moneyText(p.paid), outstanding: moneyText(p.outstanding) })).sort((a,b) => Number(b.outstanding.replace('.','')) - Number(a.outstanding.replace('.','')));
  return { items: rows, total: rows.length, authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function getPaymentRecord(bid, uid, paymentId) {
  await auth(bid, uid, 'business.payments.view'); if (!idOk(paymentId)) throw fail(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  const payment = await Payment.findOne({ _id: paymentId, businessId: bid }).lean(); if (!payment) throw fail(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  const [allocations, journals] = await Promise.all([
    Allocation.find({ businessId: bid, paymentId }).populate({ path: 'billId', select: 'billNumber billDate grandTotal currencyCode' }).sort({ createdAt: 1 }).lean(),
    Journal.find({ businessId: bid, paymentId }).sort({ createdAt: 1 }).lean(),
  ]);
  const allocated = allocations.filter(x => !x.reversedAt).reduce((sum, x) => sum + money(String(x.amount), 'allocation', true), 0n);
  return {
    ...payment, id: String(payment._id), amount: String(payment.amount), allocatedAmount: moneyText(allocated),
    advanceAmount: moneyText(money(String(payment.amount)) - allocated),
    allocations: allocations.map(x => ({ id: String(x._id), kind: x.kind, amount: String(x.amount), reversedAt: x.reversedAt, bill: x.billId ? { id: String(x.billId._id), billNumber: x.billId.billNumber, billDate: x.billId.billDate, grandTotal: String(x.billId.grandTotal), currencyCode: x.billId.currencyCode } : null })),
    journals: journals.map(x => ({ id: String(x._id), event: x.event, currencyCode: x.currencyCode, amount: String(x.amount), createdAt: x.createdAt, entries: x.entries })),
  };
}
async function reversePaymentUnlocked(bid, uid, paymentId, reason) {
  await auth(bid, uid, 'business.payments.reverse'); if (!idOk(paymentId)) throw fail(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
  const note = typeof reason === 'string' ? reason.trim().slice(0, 500) : ''; if (!note) throw fail(400, 'REVERSAL_REASON_REQUIRED', 'Enter a reason for reversing the payment.');
  const payment = await Payment.findOne({ _id: paymentId, businessId: bid }); if (!payment) throw fail(404, 'PAYMENT_NOT_FOUND', 'Payment not found.'); if (payment.status === 'reversed') return { id: String(payment._id), status: 'reversed', alreadyReversed: true };
  const now = new Date(); const inverseEntries = (await Journal.findOne({ businessId: bid, paymentId, event: 'payment' }).lean())?.entries || [];
  const reversalEntries = inverseEntries.map(entry => ({ ...entry, debit: entry.credit, credit: entry.debit }));
  try {
    payment.status = 'reversed'; payment.reversalReason = note; payment.reversedAt = now; payment.reversedByUserId = uid; await payment.save();
    await Allocation.updateMany({ businessId: bid, paymentId, reversedAt: null }, { $set: { reversedAt: now, reversedByUserId: uid } });
    await Journal.create({ businessId: bid, paymentId, event: 'reversal', currencyCode: payment.currencyCode, amount: payment.amount, entries: reversalEntries, actorUserId: uid });
  } catch (error) {
    await Journal.deleteOne({ businessId: bid, paymentId, event: 'reversal' }).catch(() => undefined); await Allocation.updateMany({ businessId: bid, paymentId }, { $set: { reversedAt: null, reversedByUserId: null } }).catch(() => undefined); await Payment.updateOne({ _id: paymentId, businessId: bid }, { $set: { status: 'recorded', reversalReason: '', reversedAt: null, reversedByUserId: null } }).catch(() => undefined); throw error;
  }
  return { id: String(payment._id), status: 'reversed', reason: note };
}
async function reversePayment(bid, uid, paymentId, reason) { return withFinancialLock(bid, () => reversePaymentUnlocked(bid, uid, paymentId, reason)); }
async function paymentSummary(bid, uid) {
  const ctx = await auth(bid, uid, 'business.payments.view'); const rows = await Payment.find({ businessId: bid }).select('direction amount status currencyCode').lean(); let received = 0n; let paid = 0n; let incomingAdvance = 0n; let outgoingAdvance = 0n;
  const ids = rows.map(row => row._id); const allocatedRows = ids.length ? await Allocation.aggregate([{ $match: { businessId: new mongoose.Types.ObjectId(bid), paymentId: { $in: ids }, reversedAt: null } }, { $group: { _id: '$paymentId', amount: { $sum: '$amount' } } }]) : []; const allocated = new Map(allocatedRows.map(row => [String(row._id), money(row.amount.toString(), 'allocated amount', true)]));
  for (const row of rows) if (row.status === 'recorded') { const amount = money(String(row.amount)); const remainder = amount - (allocated.get(String(row._id)) || 0n); if (row.direction === 'incoming') { received += amount; incomingAdvance += remainder; } else { paid += amount; outgoingAdvance += remainder; } }
  const bills = await Bill.find({ businessId: bid, deletedAt: null, status: { $ne: 'cancelled' } }).lean(); const settled = await balances(bid, bills); let receivable = 0n; let payable = 0n;
  for (const bill of bills) { const outstanding = money(String(bill.grandTotal), 'bill total', true) - (settled.get(String(bill._id)) || 0n); if (outstanding > 0n) bill.billType === 'sale' ? receivable += outstanding : payable += outstanding; }
  return { received: moneyText(received), paid: moneyText(paid), incomingAdvance: moneyText(incomingAdvance), receivable: moneyText(receivable), payable: moneyText(payable), paymentCount: rows.length, currencyCode: bills[0]?.currencyCode || rows[0]?.currencyCode || '', authorization: { isOwner: ctx.owner, permissionKeys: [...ctx.keys] } };
}
async function getBill(bid, uid, billId) { await auth(bid, uid, 'business.bills.view'); if (!idOk(billId)) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.'); const bill = await Bill.findOne({ _id: billId, businessId: bid, deletedAt: null }).lean(); if (!bill) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.'); const paid = await balances(bid, [bill]); const [allocations, images, order] = await Promise.all([Allocation.find({ businessId: bid, billId }).populate('paymentId').sort({ createdAt: 1 }).lean(), BillImage.find({ businessId: bid, billId, deletedAt: null }).select('-fileId').sort({ createdAt: 1 }).lean(), bill.orderId ? Order.findOne({ _id: bill.orderId, businessId: bid }).select('orderNumber').lean() : null]); return { ...billView(bill, paid.get(String(bill._id)) || 0n), orderNumber: order?.orderNumber || '', files: images.map(x => ({ id: String(x._id), filename: x.filename, contentType: x.contentType, size: x.size, url: `/businesses/${bid}/bills/${billId}/files/${x._id}` })), allocations: allocations.map(a => ({ id: String(a._id), amount: String(a.amount), reversedAt: a.reversedAt, payment: a.paymentId ? { id: String(a.paymentId._id), paymentNumber: a.paymentId.paymentNumber, date: a.paymentId.paymentDate, method: a.paymentId.method } : null })) }; }
module.exports = { listBills, summary, createDraft, updateDraft, issue, changeDelivery, recordDeliveryStarted, cancelBill, cancelOrder, deleteDraft, uploadFile, billFileStream, pendingBills, createPayment, listPayments, listPartyBalances, getPaymentRecord, reversePayment, paymentSummary, getBill, paymentDetails, lookupBillParty, savePaymentMethodConfig, documentNumberConfig, saveDocumentNumberConfig, transportConfig, saveTransportConfig, withFinancialLock };
