'use strict';

const mongoose = require('mongoose');
const { assertDatabaseConnected } = require('../DB/connection');
const User = require('../DB/models/User');
const Business = require('../DB/models/Business');
const Bill = require('../DB/models/BusinessBill');
const BillImage = require('../DB/models/BusinessBillImage');
const Payment = require('../DB/models/BusinessPayment');
const Allocation = require('../DB/models/BusinessPaymentAllocation');
const BusinessDelivery = require('../DB/models/BusinessDelivery');
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code, expose: statusCode < 500 });
const idOk = value => mongoose.isValidObjectId(value);
const pageSizeLimit = 50;
const moneyCents = value => {
  const text = String(value ?? '0');
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) return 0n;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};
const moneyText = cents => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const activeAllocations = async billIds => billIds.length
  ? Allocation.find({ billId: { $in: billIds }, reversedAt: null }).populate({ path: 'paymentId', select: 'paymentNumber paymentDate method methodDetails status direction partyUserId' }).sort({ createdAt: 1 }).lean()
  : [];
function paymentStatus(bill, paidCents) {
  const total = moneyCents(bill.grandTotal);
  const balance = total > paidCents ? total - paidCents : 0n;
  if (bill.status === 'cancelled') return 'cancelled';
  if (balance === 0n) return 'paid';
  if (bill.dueDate < new Date().toISOString().slice(0, 10)) return 'overdue';
  return paidCents > 0n ? 'partially_paid' : 'unpaid';
}
function safePaymentDetails(details = {}) {
  const allowed = new Set(['reference', 'transactionReference', 'utr', 'approvalCode', 'lastFour', 'upiId', 'bankName']);
  return Object.fromEntries(Object.entries(details).filter(([key, value]) => allowed.has(key) && typeof value === 'string' && value.length <= 200));
}
function safeBill(bill, allocations = [], business = null, includeDetails = false, delivery = null) {
  const active = allocations.filter(row => !row.reversedAt && row.paymentId?.status === 'recorded');
  const paid = active.reduce((sum, row) => sum + moneyCents(row.amount), 0n);
  const total = moneyCents(bill.grandTotal);
  const outstanding = total > paid ? total - paid : 0n;
  const deliveryEvents = (bill.lifecycleEvents || []).filter(event => ['delivered', 'received', 'in_transit'].includes(event.action));
  const deliveredEvent = deliveryEvents.find(event => event.action === 'delivered' || event.action === 'received');
  const startedEvent = deliveryEvents.find(event => event.action === 'in_transit');
  const issuedAt = bill.issuedAt || (bill.lifecycleEvents || []).find(event => event.action === 'issued')?.at || null;
  const deliveryStartedEvent = (delivery?.events || []).find(event => event.status === 'on_move');
  const deliveryCancelledEvent = (delivery?.events || []).find(event => event.status === 'cancelled');
  const deliveryTimeline = delivery ? [
    { label: 'personal.deliveryOrigin', address: delivery.legs?.[0]?.from || delivery.fromAddress || '', at: delivery.events?.find(event => event.status === 'on_move' && !event.action)?.at || null },
    ...(delivery.events || []).filter(event => event.action === 'handover').map(event => ({ label: 'personal.deliveryHandover', address: event.address || '', at: event.at || null })),
    { label: delivery.status === 'cancelled' ? 'personal.cancelled' : 'personal.deliveryDestination', address: delivery.toAddress || '', at: delivery.completedAt || null },
  ] : null;
  const startedAt = delivery ? (delivery.status === 'on_move' ? deliveryStartedEvent?.at || null : null) : (bill.deliveredAtIssue ? null : (startedEvent?.at || issuedAt));
  const derivedDeliveryStatus = bill.status === 'cancelled' ? 'cancelled' : delivery ? (delivery.status === 'cancelled' ? 'cancelled' : ['delivered', 'received'].includes(bill.deliveryStatus) ? bill.deliveryStatus : delivery.status === 'on_move' ? 'in_transit' : 'draft') : bill.deliveryStatus;
  const view = {
    id: String(bill._id), billNumber: bill.billNumber, billType: bill.billType, entryMode: bill.entryMode,
    status: bill.status, deliveryStatus: derivedDeliveryStatus, paymentStatus: paymentStatus(bill, paid),
    billDate: bill.billDate, dueDate: bill.dueDate, issuedAt: issuedAt ? new Date(issuedAt).toISOString() : null,
    deliveredAtIssue: Boolean(bill.deliveredAtIssue), deliveryStartedAt: startedAt ? new Date(startedAt).toISOString() : null,
    deliveredAt: delivery?.completedAt ? new Date(delivery.completedAt).toISOString() : (deliveredEvent?.at ? new Date(deliveredEvent.at).toISOString() : (bill.deliveredAtIssue && issuedAt && bill.status !== 'cancelled' ? new Date(issuedAt).toISOString() : null)),
    cancelledAt: delivery?.status === 'cancelled' && deliveryCancelledEvent?.at ? new Date(deliveryCancelledEvent.at).toISOString() : (bill.cancelledAt ? new Date(bill.cancelledAt).toISOString() : null),
    deliveryTimeline: deliveryTimeline?.map(item => ({ ...item, at: item.at ? new Date(item.at).toISOString() : null })) || null,
    currencyCode: bill.currencyCode || '', currencyScale: bill.currencyScale || 2,
    subtotal: String(bill.subtotal), afterDiscount: bill.afterDiscount == null ? null : String(bill.afterDiscount),
    discountTotal: String(bill.discountTotal || '0'), taxTotal: String(bill.taxTotal || '0'), grandTotal: moneyText(total),
    paidAmount: moneyText(paid), outstanding: moneyText(outstanding),
    partySnapshot: { name: bill.partySnapshot?.name || '', phone: bill.partySnapshot?.phone || '', address: bill.partySnapshot?.address || '' },
    lines: (bill.lines || []).map(line => ({ productName: line.productName || '', productDescription: line.productDescription || '', description: line.description || '', quantity: line.quantity ?? '', unitLabel: line.unitLabel || '', unitPrice: line.unitPrice == null ? '' : String(line.unitPrice), lineTotal: line.lineTotal == null ? '' : String(line.lineTotal) })),
    discounts: bill.discounts || [], taxes: bill.taxes || [], imageAmounts: bill.imageAmounts || null,
    business: business ? { id: String(business._id), name: business.legalName, phone: business.phone || '', address: business.address || '', logoUrl: `/businesses/${business._id}/logo` } : null,
  };
  if (includeDetails) {
    view.allocations = active.map(row => ({ id: String(row._id), amount: String(row.amount), payment: row.paymentId ? {
      id: String(row.paymentId._id), number: row.paymentId.paymentNumber, date: row.paymentId.paymentDate,
      method: row.paymentId.method, details: safePaymentDetails(row.paymentId.methodDetails),
    } : null })).filter(row => row.payment);
  }
  return view;
}
function validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
function parseQuery(query) {
  const pageRaw = query.page === undefined ? 1 : Number(query.page);
  const pageSizeRaw = query.pageSize === undefined ? 25 : Number(query.pageSize);
  if (!Number.isInteger(pageRaw) || pageRaw < 1 || !Number.isInteger(pageSizeRaw) || pageSizeRaw < 1) throw fail(400, 'INVALID_PAGINATION', 'Choose a valid page and page size.');
  const from = query.from == null || query.from === '' ? '' : String(query.from);
  const to = query.to == null || query.to === '' ? '' : String(query.to);
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) throw fail(400, 'INVALID_DATE_RANGE', 'Choose a valid date range.');
  const paymentStatus = String(query.paymentStatus || 'all');
  const deliveryStatus = String(query.deliveryStatus || 'all');
  const allowedPayment = new Set(['all', 'unpaid', 'partially_paid', 'paid', 'overdue', 'cancelled']);
  const allowedDelivery = new Set(['all', 'draft', 'in_transit', 'delivered', 'received', 'cancelled']);
  if (!allowedPayment.has(paymentStatus) || !allowedDelivery.has(deliveryStatus)) throw fail(400, 'INVALID_FILTER', 'Choose a supported bill status.');
  const method = String(query.method || 'all');
  if (!new Set(['all', 'cash', 'upi', 'card', 'bank_transfer']).has(method)) throw fail(400, 'INVALID_FILTER', 'Choose a supported payment method.');
  const summary = String(query.summary || 'all');
  if (!new Set(['all', 'paid_by_me', 'i_still_owe', 'on_the_way']).has(summary)) throw fail(400, 'INVALID_FILTER', 'Choose a supported summary filter.');
  const businessId = String(query.businessId || 'all');
  if (businessId !== 'all' && !idOk(businessId)) throw fail(400, 'INVALID_FILTER', 'Choose a valid business.');
  return { page: pageRaw, pageSize: Math.min(pageSizeLimit, pageSizeRaw), from, to, paymentStatus, deliveryStatus, method, summary, businessId, search: String(query.search || '').trim().slice(0, 100) };
}
async function customerBills(userId) {
  return Bill.find({ partyUserId: userId, billType: 'sale', gstin: { $in: [null, ''] }, status: { $in: ['issued', 'cancelled'] }, billNumber: { $type: 'string' }, issuedAt: { $ne: null }, deletedAt: null }).sort({ billDate: -1, _id: -1 }).lean();
}
async function dashboard(userId, rawQuery = {}) {
  assertDatabaseConnected();
  const query = parseQuery(rawQuery);
  const user = await User.findById(userId).select('displayName phoneE164 profilePhotoUrl accountStatus').lean();
  if (!user) throw fail(401, 'SESSION_USER_NOT_FOUND', 'Please sign in again.');
  const allBills = await customerBills(userId);
  const ids = allBills.map(row => row._id);
  const [allocations, businesses, incomingPayments, deliveries] = await Promise.all([
    activeAllocations(ids),
    Business.find({ _id: { $in: [...new Set(allBills.map(row => String(row.businessId)))] } }).select('legalName phone address').lean(),
    Payment.find({ partyUserId: userId, direction: 'incoming', status: 'recorded' }).select('businessId amount').lean(),
    BusinessDelivery.find({ billId: { $in: ids } }).sort({ createdAt: -1 }).lean(),
  ]);
  const byBill = new Map();
  for (const allocation of allocations) { const key = String(allocation.billId); const rows = byBill.get(key) || []; rows.push(allocation); byBill.set(key, rows); }
  const byBusiness = new Map(businesses.map(row => [String(row._id), row]));
  const byDelivery = new Map();
  for (const delivery of deliveries) if (!byDelivery.has(String(delivery.billId))) byDelivery.set(String(delivery.billId), delivery);
  const views = allBills.map(row => safeBill(row, byBill.get(String(row._id)) || [], byBusiness.get(String(row.businessId)), false, byDelivery.get(String(row._id))));
  const businessSummary = new Map();
  for (const row of views) {
    const current = businessSummary.get(row.business.id) || { business: row.business, billCount: 0, billedCents: 0n, paidCents: 0n, currencyCode: row.currencyCode };
    current.billCount += 1;
    if (row.status !== 'cancelled') { current.billedCents += moneyCents(row.grandTotal); current.paidCents += moneyCents(row.paidAmount); }
    businessSummary.set(row.business.id, current);
  }
  const paymentsByBusiness = new Map();
  for (const payment of incomingPayments) { paymentsByBusiness.set(String(payment.businessId), (paymentsByBusiness.get(String(payment.businessId)) || 0n) + moneyCents(payment.amount)); }
  const businessItems = [...businessSummary.values()].map(row => {
    const net = row.billedCents - (paymentsByBusiness.get(row.business.id) || row.paidCents);
    return { ...row.business, billCount: row.billCount, amount: moneyText(net < 0n ? -net : net), amountKind: net < 0n ? 'extra' : 'due', currencyCode: row.currencyCode };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const search = query.search.toLocaleLowerCase();
  const ordinaryFiltered = views.filter(row => {
    if (query.from && row.billDate < query.from) return false;
    if (query.to && row.billDate > query.to) return false;
    if (query.businessId !== 'all' && row.business.id !== query.businessId) return false;
    if (query.paymentStatus !== 'all' && row.paymentStatus !== query.paymentStatus) return false;
    if (query.deliveryStatus !== 'all' && row.deliveryStatus !== query.deliveryStatus) return false;
    if (query.method !== 'all' && !(byBill.get(row.id) || []).some(a => !a.reversedAt && a.paymentId?.method === query.method && a.paymentId?.status === 'recorded')) return false;
    if (search && !`${row.billNumber || ''} ${row.business.name} ${row.business.phone} ${row.partySnapshot.name} ${row.partySnapshot.phone}`.toLocaleLowerCase().includes(search)) return false;
    return true;
  });
  const counts = {
    myBills: ordinaryFiltered.length,
    paidByMe: ordinaryFiltered.filter(row => row.status !== 'cancelled' && moneyCents(row.paidAmount) > 0n).length,
    iStillOwe: ordinaryFiltered.filter(row => row.status !== 'cancelled' && moneyCents(row.outstanding) > 0n).length,
    onTheWay: ordinaryFiltered.filter(row => row.deliveryStatus === 'in_transit').length,
  };
  const filtered = ordinaryFiltered.filter(row => {
    if (query.summary === 'paid_by_me') return row.status !== 'cancelled' && moneyCents(row.paidAmount) > 0n;
    if (query.summary === 'i_still_owe') return row.status !== 'cancelled' && moneyCents(row.outstanding) > 0n;
    if (query.summary === 'on_the_way') return row.deliveryStatus === 'in_transit';
    return true;
  });
  const resultItems = filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  return {
    user: { name: user.displayName || '', phone: user.phoneE164 || '', photoUrl: /^https:\/\//i.test(user.profilePhotoUrl || '') ? user.profilePhotoUrl : '', status: user.accountStatus || 'active' },
    counts, businesses: businessItems,
    items: resultItems.map(row => ({ ...row, paidVia: [...new Set((byBill.get(row.id) || []).filter(a => !a.reversedAt && a.paymentId?.status === 'recorded').map(a => a.paymentId.method))] })),
    page: query.page, pageSize: query.pageSize, total: filtered.length, hasNextPage: query.page * query.pageSize < filtered.length,
  };
}
async function authorizedBill(userId, billId) {
  assertDatabaseConnected();
  if (!idOk(billId)) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.');
  const bill = await Bill.findOne({ _id: billId, partyUserId: userId, billType: 'sale', gstin: { $in: [null, ''] }, status: { $in: ['issued', 'cancelled'] }, billNumber: { $type: 'string' }, issuedAt: { $ne: null }, deletedAt: null }).lean();
  if (!bill) throw fail(404, 'BILL_NOT_FOUND', 'Bill not found.');
  return bill;
}
async function bill(userId, billId) {
  const row = await authorizedBill(userId, billId);
  return readBillDetails(row, `/personal/bills/${row._id}/files`);
}
async function readBillDetails(row, fileBase, fileIds) {
  const fileFilter = { businessId: row.businessId, billId: row._id, deletedAt: null };
  if (fileIds) fileFilter._id = { $in: fileIds };
  const [allocations, business, files, delivery] = await Promise.all([
    activeAllocations([row._id]), Business.findById(row.businessId).select('legalName phone address').lean(),
    BillImage.find(fileFilter).select('-fileId').sort({ createdAt: 1 }).lean(),
    BusinessDelivery.findOne({ businessId: row.businessId, billId: row._id }).sort({ createdAt: -1 }).lean(),
  ]);
  const view = safeBill(row, allocations, business || { _id: row.businessId, legalName: '' }, true, delivery);
  view.files = files.map(file => ({ id: String(file._id), filename: file.filename, contentType: file.contentType, size: file.size, url: `${fileBase}/${file._id}` }));
  return view;
}
async function billFile(userId, billId, fileId) {
  const billRow = await authorizedBill(userId, billId);
  if (!idOk(fileId)) throw fail(404, 'BILL_FILE_NOT_FOUND', 'File not found.');
  const image = await BillImage.findOne({ _id: fileId, billId: billRow._id, businessId: billRow.businessId, deletedAt: null }).lean();
  if (!image) throw fail(404, 'BILL_FILE_NOT_FOUND', 'File not found.');
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'businessBillImages' });
  return { image, stream: bucket.openDownloadStream(image.fileId) };
}
module.exports = { dashboard, bill, billFile, readBillDetails };
