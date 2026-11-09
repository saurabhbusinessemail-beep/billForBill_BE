'use strict';
// Opt-in live regression: a fresh, isolated database on the configured server.
require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env') });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const express = require('express');
const ExcelJS = require('exceljs');
const dbName = `f026_verification_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
process.env.MONGODB_JOBS_DB = `${dbName}_jobs`;
if (process.env.F026_UI_REVIEW === '1') process.env.SESSION_COOKIE_NAME = 'f026_verification_session';
const model = name => require('../src/DB/models/' + name);
const config = require('./legacyPackFixture').parseOffQuantity({ quantity: '5kg, 10 kg' });
const base = { key: 'base', name: 'Kilogram', symbol: 'kg', dimension: 'mass', factorToBase: '1' };
const today = new Date().toISOString().slice(0, 10);
const timestamp = `${today}T00:00:00.000+05:30`;
const results = [];
let server; let reviewServer; let testApp; let baseUrl; let owner; let member; let business; let other; let product; let cookies = {};
async function request(method, route, body, who = 'owner', headers = {}) {
  const response = await fetch(baseUrl + route, { method, headers: { ...(who ? { Cookie: cookies[who] } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); return { status: response.status, ...value };
}
async function ok(method, route, body, who, headers) { const r = await request(method, route, body, who, headers); assert.ok(r.success, `${method} ${route}: ${JSON.stringify(r.error)}`); return r.data; }
async function rejected(method, route, body, code, who) { const r = await request(method, route, body, who); assert.equal(r.error?.code, code, JSON.stringify(r)); return r; }
const path = suffix => `/businesses/${business._id}${suffix}`;
async function check(name, work) { try { await work(); results.push({ name, passed: true }); console.log('PASS', name); } catch (e) { results.push({ name, passed: false, error: e.message }); console.log('FAIL', name, e.message); } finally { if (product) await ok('PUT', path(`/catalog/products/${product.id}`), config); } }
function documentBody(type = 'sales', lines) { return { orderType: type, documentDate: timestamp, createdAtClient: timestamp, contactUserId: String(member._id), contact: { name: 'F026 Test Party', countryCallingCode: '+91', phoneNumber: '9999999998' }, lines: lines || [{ productId: product.id, unitKey: 'size_1', quantity: '2', unitPrice: '1' }] }; }
async function setup() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 10000 });
  assert.equal(mongoose.connection.name, dbName);
  assert.equal((await mongoose.connection.db.listCollections().toArray()).length, 0);
  owner = await model('User').create({ phoneE164: '+919999999999', displayName: 'F026 Test Owner', isAdmin: true, firstTimeWorkspaceChoice: 'new-business' });
  member = await model('User').create({ phoneE164: '+919999999998', displayName: 'F026 Test Party' });
  for (const [name, user] of [['owner', owner], ['member', member]]) {
    const token = crypto.randomBytes(32).toString('hex');
    await model('UserSession').create({ userId: user._id, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600000) });
    cookies[name] = `${process.env.SESSION_COOKIE_NAME || 'billforbill_session'}=${token}`;
  }
  business = await model('Business').create({ ownerUserId: owner._id, legalName: 'F026 isolated test' });
  other = await model('Business').create({ ownerUserId: member._id, legalName: 'F026 other isolated test' });
  await model('BusinessMembership').create({ businessId: business._id, userId: member._id, createdByUserId: owner._id });
  const app = express(); testApp = app; app.use(express.json());
  app.use('/auth', require('../src/routers/loggedInUserInfo.router'));
  app.use('/workspaces', require('../src/routers/workspaces.router'));
  app.use('/product-images', require('../src/routers/productImages.router'));
  app.use('/admin-setup', require('../src/routers/adminSetup.router'));
  for (const router of ['businesses', 'businessOrders', 'businessLeads', 'businessInventory', 'businessBillsPayments', 'businessPricing', 'businessPeopleTeams', 'businessPlans', 'businessDeliveries']) app.use('/businesses', require('../src/routers/' + router + '.router'));
  app.use((e, req, res, next) => res.status(e.statusCode || 500).json({ success: false, error: { code: e.code || e.name, message: e.message } }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await Promise.all(Object.values(mongoose.models).map(m => m.init()));
}
async function run() {
  await setup();
  await check('real session middleware and permission denial', async () => {
    assert.equal((await request('GET', path('/orders/options'), null, null)).status, 401);
    await rejected('POST', path('/catalog/products'), { name: 'Denied', type: 'Physical', baseUnit: base }, 'PERMISSION_DENIED', 'member');
    assert.equal((await request('GET', `/businesses/${other._id}/inventory`)).status, 404);
    const team = await model('BusinessTeam').create({ businessId: business._id, name: 'Test grant', normalizedName: 'test grant', createdByUserId: owner._id, updatedByUserId: owner._id });
    await model('TeamMembership').create({ businessId: business._id, teamId: team._id, userId: member._id, createdByUserId: owner._id });
    for (const permissionKey of ['business.catalog.view', 'business.catalog.products.manage']) await model('TeamPermissionGrant').create({ businessId: business._id, teamId: team._id, permissionKey, grantedByUserId: owner._id });
    const granted = await ok('POST', path('/catalog/products'), { name: 'F026 member-created product', type: 'Physical', baseUnit: base }, 'member'); assert.ok(granted.id);
    await model('TeamPermissionGrant').deleteMany({ teamId: team._id });
    await rejected('POST', path('/catalog/products'), { name: 'Denied again', type: 'Physical', baseUnit: base }, 'PERMISSION_DENIED', 'member');
  });
  await check('product CRUD persists Decimal128 config without unit references', async () => {
    product = await ok('POST', path('/catalog/products'), { name: 'F026 Rice', type: 'Physical', ...config });
    assert.equal(product.units.length, 3); assert.equal(product.baseUnit.symbol, 'kg');
    const saved = await model('BusinessCatalogProduct').findById(product.id).lean();
    assert.equal(saved.variants[0].units[1].factorToBase.toString(), '5'); assert.equal(saved.baseUnitId, undefined); assert.equal(saved.additionalUnits, undefined);
    product = await ok('PUT', path(`/catalog/products/${product.id}`), { name: 'F026 Rice edited', ...config });
    await rejected('POST', path('/catalog/products'), { name: 'Invalid', type: 'Physical', baseUnit: base, units: [{ ...base, key: 'bad', factorToBase: '0' }] }, 'INVALID_CONVERSION');
  });
  await check('generic unit category/attribute CRUD stays independent from embedded products', async () => {
    const unit = await ok('POST', path('/catalog/units'), { name: 'Generic gram', symbol: 'g', dimension: 'mass' });
    const category = await ok('POST', path('/catalog/categories'), { name: 'F026 category', unitIds: [unit.id] });
    const attribute = await ok('POST', path('/catalog/attributes'), { name: 'F026 attribute', unitIds: [unit.id] });
    await ok('DELETE', path(`/catalog/units/${unit.id}`));
    assert.equal((await ok('GET', path(`/catalog/categories/${category.id}`))).unitIds.length, 0);
    assert.equal((await ok('GET', path(`/catalog/attributes/${attribute.id}`))).unitIds.length, 0);
    assert.equal((await ok('GET', path(`/catalog/products/${product.id}`))).units.length, 3);
  });
  await check('business creation and unset-type assignment copy all package metadata', async () => {
    const image = Buffer.from([137,80,78,71,13,10,26,10]);
    const response = await fetch(baseUrl + '/admin-setup/products', { method: 'POST', headers: { Cookie: cookies.owner, 'Content-Type': 'image/png', 'X-File-Name': 'test.png', 'X-Product-Metadata': JSON.stringify({ name: 'F026 shared multipack', type: 'Physical', ...require('./legacyPackFixture').parseOffQuantity({ quantity: '6 x 250 ml, 12 x 250 ml' }) }) }, body: image });
    const value = await response.json(); assert.ok(value.success, JSON.stringify(value.error));
    const shared = await model('CatalogProduct').findById(value.data.id);
    await ok('PUT', '/admin-setup/products/' + shared._id, { name: 'F026 shared multipack edited', ...require('../src/services/productUnits').dto(shared) });
    const type = await model('BusinessType').create({ name: 'F026 type', normalizedName: 'f026 type', productIds: [shared._id] });
    const created = await ok('POST', '/businesses', { legalName: 'F026 copied business', businessTypeId: String(type._id) }, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    const copiedId = created.id || created.business?.id;
    assert.ok(copiedId, JSON.stringify(created));
    await ok('PATCH', `/businesses/${business._id}`, { businessTypeId: String(type._id) });
    const copied = await model('BusinessCatalogProduct').find({ businessId: { $in: [business._id, copiedId] }, sourceProductId: shared._id }).lean();
    assert.equal(copied.length, 2);
    for (const row of copied) assert.deepEqual(require('../src/services/productUnits').dto(row), require('../src/services/productUnits').dto(shared));
  });
  await check('scoped document options, forged units, base-quantity price tiers and purchase scaling', async () => {
    await ok('PUT', path(`/pricing/products/${product.id}`), { defaultSellingPrice: '10', purchaseCost: '4', rules: [{ minimumQuantity: 10, sellingPrice: '8', active: true }], version: 0 });
    const options = await ok('GET', path('/orders/options')); assert.equal(options.units, undefined); assert.ok(options.products.find(p => p.id === product.id).unitConfigRevision);
    await rejected('POST', path('/orders'), documentBody('sales', [{ productId: product.id, unitKey: 'foreign', quantity: '2', unitPrice: '1' }]), 'INVALID_PRODUCT_UNIT');
    const order = await ok('POST', path('/orders'), documentBody());
    assert.equal(order.lines[0].unitPrice, '40'); assert.equal(order.lines[0].baseQuantity, '10'); assert.equal(order.grandTotal, '80.00');
    const purchase = await ok('POST', path('/orders'), documentBody('purchase', [{ productId: product.id, unitKey: 'size_1', quantity: '2', unitPrice: '1', factorToBase: '999', unitLabel: 'Forged' }]));
    assert.equal(purchase.lines[0].unitPrice, '20'); assert.equal(purchase.lines[0].factorToBase, '5'); assert.notEqual(purchase.lines[0].unitLabel, 'Forged');
    const foreign = await model('BusinessCatalogProduct').create({ businessId: other._id, name: 'Other', normalizedName: 'other', type: 'Physical', baseUnit: base });
    await rejected('POST', path('/orders'), documentBody('sales', [{ productId: String(foreign._id), unitKey: 'base', quantity: '1', unitPrice: '1' }]), 'INVALID_PRODUCT');
  });
  await check('inventory adjustment, report, reorder, ledger and concurrent writes use base quantities', async () => {
    await Promise.all([1, 2].map(i => ok('POST', path('/inventory/adjustments'), { productId: product.id, unitKey: 'size_1', quantity: '2', direction: 'in', reason: 'opening', effectiveDate: today })));
    const list = await ok('GET', path('/inventory')); assert.equal(list.items.find(p => p.id === product.id).quantity, '20');
    await ok('PUT', path(`/inventory/products/${product.id}/reorder-level`), { reorderLevel: '5' });
    assert.equal((await ok('GET', path(`/inventory/products/${product.id}/ledger`))).items.length, 2);
    const report = await ok('GET', path(`/reports/inventory-balance-sheet?productId=${product.id}&startDate=${today}&endDate=${today}&unitKey=base`)); assert.equal(report.closing, '20');
    await rejected('POST', path('/inventory/adjustments'), { productId: product.id, unitKey: 'foreign', quantity: '1', direction: 'in', reason: 'count', effectiveDate: today }, 'INVALID_UNIT');
    await rejected('PUT', path(`/catalog/products/${product.id}`), { baseUnit: { ...base, symbol: 'g', name: 'Gram' } }, 'PRODUCT_BASE_UNIT_IN_USE');
  });
  await check('inactive variants, stale revisions and stock precision loss are rejected', async () => {
    const disabled = { ...config, quantityVariants: config.quantityVariants.map(v => v.unitKey === 'size_1' ? { ...v, active: false } : v) };
    const before = (await ok('GET', path('/orders/options'))).products.find(p => p.id === product.id);
    await ok('PUT', path(`/catalog/products/${product.id}`), disabled);
    const after = (await ok('GET', path('/orders/options'))).products.find(p => p.id === product.id);
    assert.ok(!after.units.some(u => u.key === 'size_1'));
    await rejected('POST', path('/orders'), documentBody(), 'INVALID_PRODUCT_UNIT');
    await rejected('POST', path('/orders'), documentBody('sales', [{ productId: product.id, unitKey: 'size_2', quantity: '1', unitPrice: '1', unitConfigRevision: before.unitConfigRevision }]), 'PRODUCT_UNIT_CONFIG_STALE');
    const current = await ok('POST', path('/orders'), documentBody('sales', [{ productId: product.id, unitKey: 'size_2', quantity: '1', unitPrice: '1', unitConfigRevision: after.unitConfigRevision }])); assert.equal(current.lines[0].baseQuantity, '10');
    await ok('PUT', path(`/catalog/products/${product.id}`), { ...config, units: [...config.units, { key: 'tiny', name: 'Tiny portion', symbol: 'tiny', dimension: 'mass', factorToBase: '0.00001', conversionKind: 'product_specific', active: true }] });
    await rejected('POST', path('/inventory/adjustments'), { productId: product.id, unitKey: 'tiny', quantity: '0.0001', direction: 'in', reason: 'count', effectiveDate: today }, 'INVALID_CONVERSION');
  });
  await check('Lead snapshots survive removal; conversion retains factors and totals', async () => {
    let lead = await ok('POST', path('/leads'), documentBody());
    const withoutPack = { baseUnit: base, units: config.units.filter(u => u.key !== 'size_1') };
    await ok('PUT', path(`/catalog/products/${product.id}`), withoutPack);
    lead = await ok('PATCH', path(`/leads/${lead.id}`), { ...documentBody(), lines: lead.lines, version: lead.version });
    assert.equal(lead.lines[0].factorToBase, '5'); assert.equal(lead.grandTotal, '80.00');
    await rejected('POST', path('/leads'), documentBody(), 'INVALID_PRODUCT_UNIT');
    const converted = await ok('POST', path(`/leads/${lead.id}/convert`), { mode: 'order', version: lead.version });
    assert.equal(converted.lines[0].factorToBase, '5'); assert.equal(converted.grandTotal, '80.00');
    await ok('PUT', path(`/catalog/products/${product.id}`), config);
  });
  await check('linked bill issue/retry/compensation use immutable conversion snapshots', async () => {
    const order = await ok('POST', path('/orders'), documentBody());
    const bill = await ok('POST', path('/bills'), { billType: 'sale', entryMode: 'detailed', billDate: today, dueDate: today, orderId: order.id, partyUserId: order.contactUserId, currencyCode: 'INR', deliveredAtIssue: true }, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    await ok('PUT', path(`/catalog/products/${product.id}`), { baseUnit: base, units: [] });
    const issued = await ok('POST', path(`/bills/${bill.id}/issue`)); assert.equal(issued.status, 'issued');
    await ok('POST', path(`/bills/${bill.id}/issue`));
    const movements = await model('BusinessInventoryMovement').find({ sourceBillId: bill.id }).lean(); assert.equal(movements.length, 1); assert.equal(movements[0].stockQuantity.toString(), '10');
    await rejected('POST', path(`/bills/${bill.id}/cancel`), null, 'CANCEL_BLOCKED_DELIVERED');
    await require('../src/services/businessInventory.service').recordBillMovement(String(business._id), String(owner._id), { _id: bill.id, billDate: today }, { ...issued.lines[0], factorToBase: '999', quantity: '999' }, 'in', 'f026:test-compensation', true);
    const all = await model('BusinessInventoryMovement').find({ sourceBillId: bill.id }).lean(); assert.equal(all.length, 2); assert.equal(all[1].stockQuantity.toString(), '10');
    await ok('PUT', path(`/catalog/products/${product.id}`), config);
  });
  await check('selling workbook round-trip validates embedded base labels and applies base prices', async () => {
    const workbook = require('../src/services/businessPricingWorkbook.service');
    const buffer = await workbook.exportWorkbook(String(business._id), String(owner._id), 'selling');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer.buffer || buffer);
    const sheet = wb.getWorksheet('Products'); let row;
    sheet.eachRow((r, index) => { if (index > 1 && String(r.getCell(2).value) === product.id) row = r; }); assert.ok(row);
    assert.equal(row.getCell(7).value, 'Kilogram'); row.getCell(8).value = '12';
    const validation = await workbook.validateWorkbook(String(business._id), String(owner._id), 'selling', Buffer.from(await wb.xlsx.writeBuffer())); assert.deepEqual(validation.errors, []);
    const applied = await workbook.commitWorkbook(String(business._id), String(owner._id), validation.operationId, validation.digest, []); assert.equal(applied.committed, true); assert.ok(applied.results.every(r => r.success));
    row.getCell(7).value = 'Litre'; const bad = await workbook.validateWorkbook(String(business._id), String(owner._id), 'selling', Buffer.from(await wb.xlsx.writeBuffer())); assert.ok(bad.errors.some(e => e.code === 'WORKBOOK_UNIT_REFERENCE'));
  });
  await check('failed bill posting compensates all applied lines and remains safe to retry', async () => {
    const order = await ok('POST', path('/orders'), documentBody('sales', [
      { productId: product.id, unitKey: 'size_1', quantity: '1', unitPrice: '1' },
      { productId: product.id, unitKey: 'size_1', quantity: '4', unitPrice: '1' },
    ]));
    const bill = await ok('POST', path('/bills'), { billType: 'sale', entryMode: 'detailed', billDate: today, dueDate: today, orderId: order.id, partyUserId: order.contactUserId, currencyCode: 'INR', deliveredAtIssue: true }, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    for (let attempt = 0; attempt < 2; attempt++) {
      await rejected('POST', path(`/bills/${bill.id}/issue`), null, 'INSUFFICIENT_STOCK');
      const list = await ok('GET', path('/inventory')); assert.equal(list.items.find(p => p.id === product.id).quantity, '20');
      assert.equal((await model('BusinessBill').findById(bill.id)).status, 'draft');
    }
  });
  await check('purchase receipt, sales delivery and image-only bills preserve stock direction', async () => {
    async function create(type, deliveredAtIssue) {
      const order = await ok('POST', path('/orders'), documentBody(type === 'purchase' ? 'purchase' : 'sales', [{ productId: product.id, unitKey: 'size_1', quantity: '1', unitPrice: '1' }]));
      return ok('POST', path('/bills'), { billType: type, entryMode: 'detailed', billDate: today, dueDate: today, orderId: order.id, partyUserId: order.contactUserId, currencyCode: 'INR', deliveredAtIssue }, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    }
    const purchase = await create('purchase', true); await ok('POST', path(`/bills/${purchase.id}/issue`));
    const receipt = await model('BusinessInventoryMovement').findOne({ sourceBillId: purchase.id }).lean(); assert.equal(receipt.direction, 'in'); assert.equal(receipt.stockQuantity.toString(), '5');
    const sale = await create('sale', false); await ok('POST', path(`/bills/${sale.id}/issue`));
    assert.equal(await model('BusinessInventoryMovement').countDocuments({ sourceBillId: sale.id }), 0);
    await ok('POST', path(`/bills/${sale.id}/delivery`), { deliveryStatus: 'delivered' });
    await ok('POST', path(`/bills/${sale.id}/issue`));
    const sent = await model('BusinessInventoryMovement').find({ sourceBillId: sale.id }).lean(); assert.equal(sent.length, 1); assert.equal(sent[0].direction, 'out');
    const image = await ok('POST', path('/bills'), { billType: 'sale', entryMode: 'image', billDate: today, dueDate: today, partyUserId: String(member._id), currencyCode: 'INR', deliveredAtIssue: true, imageAmounts: { taxableAmount: '1', taxAmount: '0' } }, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    const upload = await fetch(baseUrl + path(`/bills/${image.id}/files?filename=test.png`), { method: 'POST', headers: { Cookie: cookies.owner, 'Content-Type': 'image/png' }, body: Buffer.from([137,80,78,71,13,10,26,10]) });
    assert.ok((await upload.json()).success);
    await ok('POST', path(`/bills/${image.id}/issue`));
    assert.equal(await model('BusinessInventoryMovement').countDocuments({ sourceBillId: image.id }), 0);
  });
  console.log(JSON.stringify({ database: dbName, checks: results.length, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed) }, null, 2));
  if (results.some(r => !r.passed)) process.exitCode = 1;
  if (process.env.F026_UI_REVIEW === '1' && !process.exitCode) await review();
}
async function review() {
  const fs = require('node:fs'); const path = require('node:path');
  const root = path.resolve(__dirname, '../../FE/bill_for_bill/dist/bill_for_bill/browser');
  testApp.use((req, res, next) => { res.setHeader('Content-Security-Policy', "connect-src 'self'"); next(); });
  testApp.get('/f026-review', (req, res) => { res.setHeader('Set-Cookie', cookies.owner + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600'); res.redirect(`/dashboard/${business._id}/catalog/products`); });
  testApp.use((req, res, next) => {
    if (!/^\/[A-Za-z0-9_-]+\.js$/.test(req.path)) return next();
    const file = path.join(root, req.path.slice(1)); if (!fs.existsSync(file)) return next();
    res.type('js').send(fs.readFileSync(file, 'utf8').replaceAll('https://bill-for-bill-be.vercel.app', ''));
  });
  testApp.use(express.static(root)); testApp.get('/{*path}', (req, res) => res.sendFile(path.join(root, 'index.html')));
  reviewServer = require('node:https').createServer({ key: fs.readFileSync(path.resolve(__dirname, '../../certs/localhost-key.pem')), cert: fs.readFileSync(path.resolve(__dirname, '../../certs/localhost.pem')) }, testApp);
  await new Promise((resolve, reject) => { reviewServer.once('error', reject); reviewServer.listen(3443, '127.0.0.1', resolve); });
  console.log('Isolated browser review ready: https://localhost:3443/f026-review');
  const stopFile = path.join(require('node:os').tmpdir(), dbName + '.stop');
  console.log('Send Enter, interrupt, or create this stop file to clean generated records: ' + stopFile);
  await new Promise(resolve => {
    const finish = () => { clearInterval(timer); process.stdin.removeListener('data', finish); process.removeListener('SIGINT', finish); if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile); resolve(); };
    const timer = setInterval(() => { if (fs.existsSync(stopFile)) finish(); }, 250);
    process.stdin.once('data', finish); process.once('SIGINT', finish);
  });
}
async function cleanup() {
  if (reviewServer) await new Promise(resolve => reviewServer.close(resolve));
  if (server) await new Promise(resolve => server.close(resolve));
  // Only this invocation's unique databases may be cleaned; never the app DB.
  if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) for (const collection of await mongoose.connection.db.listCollections().toArray()) await mongoose.connection.db.collection(collection.name).deleteMany({});
  const jobs = require('../src/services/backgroundJobs.service');
  if (jobs.Job) { const { connection } = await jobs.connectJobsDatabase(); if (connection.name === `${dbName}_jobs`) for (const collection of await connection.db.listCollections().toArray()) await connection.db.collection(collection.name).deleteMany({}); }
  await jobs.closeJobsDatabase(); await mongoose.disconnect();
}
if (process.env.F026_INTEGRATION !== '1') { console.error('Set F026_INTEGRATION=1 to run isolated live tests.'); process.exitCode = 1; }
else run().catch(e => { console.error(e.name, e.message); process.exitCode = 1; }).finally(cleanup);
