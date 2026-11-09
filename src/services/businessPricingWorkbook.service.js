'use strict';
const ExcelJS = require('exceljs');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { access } = require('./businessPeopleTeams.service');
const pricing = require('./businessPricing.service');
const catalog = require('./businessCatalog.service');
const Product = require('../DB/models/BusinessCatalogProduct');
const Category = require('../DB/models/BusinessCatalogCategory');
const productUnits = require('./productUnits');
const User = require('../DB/models/User');
const { parsePhoneE164 } = require('../utils/phone');
const Price = require('../DB/models/BusinessProductPricing');
const getImportSessionModel = require('../DB/models/PricingImportSession');
const jobs = require('./backgroundJobs.service');
async function importSessions() { const { connection } = await jobs.connectJobsDatabase(); return getImportSessionModel(connection); }
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const MAX_BYTES = 5 * 1024 * 1024;
const META_VERSION = 'F012-5';
const text = (cell) => { const v = cell?.value; if (v && typeof v === 'object') { if ('formula' in v || 'sharedFormula' in v) throw fail(400, 'WORKBOOK_FORMULA', 'Formulas are not allowed in writable workbook cells.'); return String(v.text ?? v.result ?? '').trim(); } return v == null ? '' : String(v).trim(); };
const decimalText = (value) => { if (value === '') return ''; const s = String(value).trim(); if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(s)) throw fail(400, 'WORKBOOK_INVALID_NUMBER', 'Enter a non-negative amount with at most four decimal places.'); return s; };
const decimalKey = (value) => { if (value == null || value === '') return null; const [integer, fraction = ''] = String(value).trim().split('.'); return `${integer}.${fraction.replace(/0+$/, '') || '0'}`; };
function heading(sheet) { const map = new Map(); sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => map.set(text(cell).toLowerCase(), col)); return map; }
function column(map, row, key) { const col = map.get(key.toLowerCase()); return col ? text(row.getCell(col)) : ''; }
function categoryPath(category, byId) { const parts = [category.name]; let parent = category.parentId; while (parent && byId.has(String(parent))) { const item = byId.get(String(parent)); parts.unshift(item.name); parent = item.parentId; } return parts.join(' / '); }
function setHeader(sheet, columns) { sheet.addRow(columns); sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF312E81' } }; sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }; }
function workbookBase(type) { const wb = new ExcelJS.Workbook(); wb.creator = 'BillForBill'; wb.subject = `F012 ${type} price maintenance`; wb.created = new Date(); const meta = wb.addWorksheet('_meta', { state: 'veryHidden' }); meta.addRow(['F012 Workbook Version', META_VERSION]); meta.addRow(['Workbook Type', type]); const help = wb.addWorksheet('Help'); help.addRows([['F012 pricing workbook help'], ['Version', META_VERSION], ['Blank cells never clear existing prices. In Price Rules, rows with a Rule ID update that rule; rows without a Rule ID add a rule.'], ['Customer phone numbers must include a country code, such as +919876543210. The Price Rules phone column is formatted as text to preserve +. Select products and Active values from their dropdowns.']]); return wb; }
async function exportWorkbook(bid, uid, type, productIds = []) {
  await access(bid, uid, 'business.pricing.view'); await access(bid, uid, 'business.pricing.export');
  if (!['selling', 'purchase'].includes(type)) throw fail(400, 'INVALID_WORKBOOK_TYPE', 'Choose selling or purchase pricing.');
  const filter = { businessId: bid }; if (productIds.length) { if (productIds.some(id => !mongoose.isValidObjectId(id))) throw fail(400, 'INVALID_PRODUCT_ID', 'Choose valid products.'); filter._id = { $in: [...new Set(productIds)] }; }
  const products = await Product.find(filter).sort({ normalizedName: 1 }).lean();
  const prices = await Price.find({ businessId: bid, productId: { $in: products.map(p => p._id) } }).lean(); const byId = new Map(prices.map(p => [String(p.productId), p]));
  const wb = workbookBase(type); const sheet = wb.addWorksheet('Products');
  const businessCategories = await Category.find({ businessId: bid }).select('_id name parentId').lean(); const categoryById = new Map(businessCategories.map(category => [String(category._id), category])); const categoryNames = new Map(businessCategories.map(category => [String(category._id), categoryPath(category, categoryById)]));
  const columns = type === 'selling' ? ['Product Key', 'Product ID', 'Product Name', 'Product Type', 'Description', 'Categories', 'Base Unit', 'Default Selling Price'] : ['Product Key', 'Product ID', 'Product Name', 'Product Type', 'Description', 'Categories', 'Base Unit', 'Purchase Cost', 'Tax Inclusive', 'Separate Tax'];
  setHeader(sheet, columns);
  for (const col of [3, 4, 5, 6, 7]) sheet.getRow(1).getCell(col).note = 'Read-only reference column. Edit pricing fields only.';
  for (const product of products) { const p = byId.get(String(product._id)); const names = product.categoryIds.map(id => categoryNames.get(String(id))).filter(Boolean).join('; '); const row = type === 'selling' ? [String(product._id), String(product._id), product.name, product.type, product.description, names, productUnits.dto(product).baseUnit?.name || '', p?.defaultSellingPrice?.toString() || ''] : [String(product._id), String(product._id), product.name, product.type, product.description, names, productUnits.dto(product).baseUnit?.name || '', p?.purchaseCost?.toString() || '', p?.taxInclusive === false ? 'No' : 'Yes', p?.separateTaxAmount?.toString() || '']; const excelRow = sheet.addRow(row); for (const col of [1, 2, 3, 4, 5, 6, 7]) { const cell = excelRow.getCell(col); cell.protection = { locked: true }; if (col >= 3 && col <= 7) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }; } for (const col of (type === 'selling' ? [8] : [8, 9, 10])) excelRow.getCell(col).protection = { locked: false }; }
  if (type === 'purchase') sheet.dataValidations.add('I2:I5001', { type: 'list', allowBlank: true, formulae: ['"Yes,No"'], showErrorMessage: true, errorTitle: 'Choose Yes or No', error: 'Tax Inclusive must be Yes or No.' });
  await sheet.protect('F012-locked-reference-fields', { selectLockedCells: false, selectUnlockedCells: true, insertRows: true, deleteRows: true, formatColumns: true });
  if (type === 'selling') {
    const rules = wb.addWorksheet('Price Rules'); setHeader(rules, ['Product Key', 'Product ID', 'Product Name', 'Rule ID', 'Customer User ID', 'Customer Name', 'Customer Phone Number', 'Minimum Quantity', 'Selling Price', 'Active']);
    const userIds = [...new Set(prices.flatMap(price => (price.rules || []).map(rule => rule.customerUserId).filter(Boolean).map(String)))]; const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select('_id displayName phoneE164').lean() : []; const userById = new Map(users.map(user => [String(user._id), user]));
    const productLastRow = Math.max(2, products.length + 1); wb.definedNames.add(`Products!$C$2:$C$${productLastRow}`, 'PricingProductNames'); wb.calcProperties.fullCalcOnLoad = true;
    let rowNumber = 2;
    for (const cell of ['G1']) rules.getCell(cell).note = 'Text field. Enter the full phone number with + and country code.';
    for (const product of products) for (const rule of byId.get(String(product._id))?.rules || []) { const user = rule.customerUserId ? userById.get(String(rule.customerUserId)) : null; const row = rules.addRow([]); row.getCell(1).value = { formula: `IF(C${rowNumber}="","",IFERROR(INDEX(Products!$A$2:$A$${productLastRow},MATCH(C${rowNumber},Products!$C$2:$C$${productLastRow},0)),""))` }; row.getCell(2).value = { formula: `IF(C${rowNumber}="","",IFERROR(INDEX(Products!$B$2:$B$${productLastRow},MATCH(C${rowNumber},Products!$C$2:$C$${productLastRow},0)),""))` }; row.getCell(3).value = product.name; row.getCell(4).value = String(rule._id); row.getCell(5).value = rule.customerUserId ? String(rule.customerUserId) : ''; row.getCell(6).value = user?.displayName || ''; row.getCell(7).value = user?.phoneE164 || ''; row.getCell(7).numFmt = '@'; row.getCell(8).value = rule.minimumQuantity ?? ''; row.getCell(9).value = rule.sellingPrice?.toString() || ''; row.getCell(10).value = rule.active === false ? 'No' : 'Yes'; rowNumber++; }
    const maxRuleRow = 20001; for (let r = rowNumber; r <= maxRuleRow; r++) { const row = rules.getRow(r); row.getCell(1).value = { formula: `IF(C${r}="","",IFERROR(INDEX(Products!$A$2:$A$${productLastRow},MATCH(C${r},Products!$C$2:$C$${productLastRow},0)),""))` }; row.getCell(2).value = { formula: `IF(C${r}="","",IFERROR(INDEX(Products!$B$2:$B$${productLastRow},MATCH(C${r},Products!$C$2:$C$${productLastRow},0)),""))` }; row.getCell(7).numFmt = '@'; }
    rules.dataValidations.add(`C2:C${maxRuleRow}`, { type: 'list', allowBlank: true, formulae: ['=PricingProductNames'], showErrorMessage: true, errorTitle: 'Choose a product', error: 'Select a product listed on the Products sheet.' }); rules.dataValidations.add(`J2:J${maxRuleRow}`, { type: 'list', allowBlank: false, formulae: ['"Yes,No"'], showErrorMessage: true, errorTitle: 'Choose Yes or No', error: 'Active must be Yes or No.' });
    for (let r = 2; r <= maxRuleRow; r++) { for (const col of [1, 2, 4, 5]) rules.getRow(r).getCell(col).protection = { locked: true }; for (const col of [3, 6, 7, 8, 9, 10]) rules.getRow(r).getCell(col).protection = { locked: false }; }
    await rules.protect('F012-rule-reference-fields', { selectLockedCells: false, selectUnlockedCells: true, insertRows: true, deleteRows: true, formatColumns: true });
  }
  for (const s of wb.worksheets) { s.columns.forEach((c, index) => { const headerText = s.getRow(1).getCell(index + 1).value; const header = headerText == null ? '' : String(headerText); c.width = Math.max(14, Math.min(38, header.length + 5)); }); if (['Products', 'Price Rules'].includes(s.name)) { s.getColumn(1).hidden = true; s.getColumn(2).hidden = true; } if (s.name === 'Price Rules') { s.getColumn(4).hidden = true; s.getColumn(5).hidden = true; } if (s.name !== '_meta') s.eachRow((row, rowNo) => { if (rowNo > 1) row.eachCell((cell, col) => { if ([1, 2].includes(col)) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }; }); }); }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
function distance(a, b) { const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 0; j <= b.length; j++) dp[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return dp[a.length][b.length]; }
function similar(name, rows) { const needle = name.toLocaleLowerCase('en-IN').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); if (!needle) return []; return rows.map(p => { const candidate = p.name.toLocaleLowerCase('en-IN').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); const score = 1 - distance(needle, candidate) / Math.max(needle.length, candidate.length, 1); return { productId: String(p._id), name: p.name, score: Number(score.toFixed(2)) }; }).filter(p => p.score >= .72).sort((a, b) => b.score - a.score).slice(0, 5); }
async function validateWorkbook(bid, uid, type, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BYTES) throw fail(413, 'WORKBOOK_TOO_LARGE', 'Workbook must be smaller than 5 MB.');
  if (buffer.includes(Buffer.from('vbaProject.bin'))) throw fail(415, 'WORKBOOK_MACROS_NOT_ALLOWED', 'Macro-enabled workbooks are not accepted.');
  await access(bid, uid, 'business.pricing.view'); await access(bid, uid, 'business.pricing.import');
  if (!['selling', 'purchase'].includes(type)) throw fail(400, 'INVALID_WORKBOOK_TYPE', 'Choose selling or purchase pricing.');
  let wb; try { wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer); } catch { throw fail(400, 'INVALID_WORKBOOK', 'The uploaded file is not a valid Excel workbook.'); }
  const meta = wb.getWorksheet('_meta'); if (text(meta?.getCell('B1')) !== META_VERSION || text(meta?.getCell('B2')) !== type) throw fail(400, 'WORKBOOK_VERSION', 'Download a current workbook template for this pricing tab.');
  const sheet = wb.getWorksheet('Products'); if (!sheet || (type === 'selling' && !wb.getWorksheet('Price Rules'))) throw fail(400, 'WORKBOOK_SHEETS', 'The workbook is missing a required sheet.');
  const expectedSheets = type === 'selling' ? ['_meta', 'Help', 'Products', 'Price Rules'] : ['_meta', 'Help', 'Products'];
  if (wb.worksheets.some(s => !expectedSheets.includes(s.name))) throw fail(400, 'WORKBOOK_SHEETS', 'The workbook contains an unsupported sheet.');
  if (sheet.rowCount > 5001) throw fail(413, 'WORKBOOK_TOO_MANY_ROWS', 'A workbook may contain at most 5,000 product rows.');
  const products = await Product.find({ businessId: bid }).select('_id name normalizedName type description categoryIds baseUnit units quantityVariants needsUnit variations variants').lean(); const businessCategories = await Category.find({ businessId: bid }).select('_id name parentId').lean(); const categoryById = new Map(businessCategories.map(category => [String(category._id), category])); const categoryIdByPath = new Map(businessCategories.map(category => [categoryPath(category, categoryById).toLocaleLowerCase(), String(category._id)]));
  const byId = new Map(products.map(p => [String(p._id), p])); const data = { products: [], rules: [] }; const errors = []; const keys = new Map(); const ids = new Set(); const nameKeys = new Set();
  const map = heading(sheet); const required = ['product key', 'product id', 'product name', 'product type', 'description', 'categories', 'base unit', type === 'selling' ? 'default selling price' : 'purchase cost', ...(type === 'purchase' ? ['tax inclusive', 'separate tax'] : [])];
  const productColumns = new Set(required);
  for (const field of map.keys()) if (!productColumns.has(field)) errors.push({ sheet: 'Products', row: 1, column: field, message: `Unsupported column: ${field}` });
  for (const field of required) if (!map.has(field)) errors.push({ sheet: 'Products', row: 1, column: field, message: `Missing column: ${field}` });
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i); if (row.cellCount === 0) continue;
    try {
      row.eachCell({ includeEmpty: false }, cell => text(cell));
      const key = column(map, row, 'product key'); const productId = column(map, row, 'product id'); const name = column(map, row, 'product name'); const typeValue = column(map, row, 'product type');
      if (!key && !productId && !name) continue;
      if (!key || keys.has(key)) throw fail(400, 'WORKBOOK_DUPLICATE_KEY', 'Product Key is required and must be unique.');
      keys.set(key, i); if (productId) { if (!mongoose.isValidObjectId(productId) || !byId.has(productId)) throw fail(400, 'WORKBOOK_PRODUCT_REFERENCE', 'Product ID is invalid or does not belong to this business.'); if (ids.has(productId)) throw fail(400, 'WORKBOOK_DUPLICATE_PRODUCT', 'A product appears more than once.'); ids.add(productId); }
      else if (!name || !typeValue || !column(map, row, 'base unit')) throw fail(400, 'WORKBOOK_NEW_PRODUCT_REQUIRED', 'New product rows require a name, product type, and base unit name.');
      const normalizedName = name.toLocaleLowerCase('en-IN').replace(/\s+/g, ' ').trim();
      if (!productId && normalizedName && nameKeys.has(normalizedName)) throw fail(400, 'WORKBOOK_DUPLICATE_NAME', 'The same new product name appears more than once in this workbook.');
      if (!productId && normalizedName) nameKeys.add(normalizedName);
      const categoryNames = column(map, row, 'categories').split(';').map(x => x.trim()).filter(Boolean); const categories = categoryNames.map(name => categoryIdByPath.get(name.toLocaleLowerCase()));
      if (categories.some(id => !id) || new Set(categories).size !== categories.length) throw fail(400, 'WORKBOOK_CATEGORY_REFERENCE', 'One or more Category names do not match a unique category path in this business.');
      const baseUnitName = column(map, row, 'base unit'); const existing = byId.get(productId);
      if (existing && baseUnitName !== (existing.baseUnit?.name || '')) throw fail(400, 'WORKBOOK_UNIT_REFERENCE', 'Base Unit must match the product base unit.');
      const canonical = Object.entries(productUnits.metrics).find(([symbol, unit]) => symbol.toLowerCase() === baseUnitName.toLowerCase() || unit[0].toLowerCase() === baseUnitName.toLowerCase());
      if (!existing && !canonical) throw fail(400, 'WORKBOOK_UNIT_REFERENCE', 'Use a supported canonical base unit or configure the product before importing prices.');
      const config = existing ? productUnits.dto(existing) : productUnits.normalize({ baseUnit: { key: 'base', name: canonical[1][0], symbol: canonical[0], dimension: canonical[1][1], factorToBase: '1' } });
      const product = { rowNumber: i, key, productId: productId || null, name, type: typeValue, description: existing?.description || column(map, row, 'description'), categoryIds: categories, ...config };
      product.version = 0;
      if (type === 'selling') product.defaultSellingPrice = decimalText(column(map, row, 'default selling price'));
      else { product.purchaseCost = decimalText(column(map, row, 'purchase cost')); const inclusive = column(map, row, 'tax inclusive').toLowerCase(); if (!inclusive || !['yes', 'no'].includes(inclusive)) throw fail(400, 'WORKBOOK_TAX_INCLUSIVE', 'Tax Inclusive must be Yes or No.'); product.taxInclusive = inclusive !== 'no'; product.separateTaxAmount = decimalText(column(map, row, 'separate tax')); product.separateTaxId = null; if (!product.taxInclusive && !product.separateTaxAmount) throw fail(400, 'SEPARATE_TAX_REQUIRED', 'Enter a separate tax amount when tax is not inclusive.'); }
      if (!productId) product.similarMatches = similar(name, products);
      data.products.push(product);
    } catch (e) { errors.push({ sheet: 'Products', row: i, column: 'Product data', code: e.code || 'INVALID_ROW', message: e.message }); }
  }
  const existingPriceRows = data.products.some(product => product.productId) ? await Price.find({ businessId: bid, productId: { $in: data.products.filter(product => product.productId).map(product => product.productId) } }).lean() : []; const existingPriceByProduct = new Map(existingPriceRows.map(price => [String(price.productId), price]));
  for (const product of data.products) {
    const current = product.productId ? existingPriceByProduct.get(product.productId) : null;
    if (!product.productId) { product.priceChanged = true; continue; }
    if (type === 'selling') product.priceChanged = Boolean(product.defaultSellingPrice && decimalKey(product.defaultSellingPrice) !== decimalKey(current?.defaultSellingPrice?.toString()));
    else { const nextPurchase = product.purchaseCost || current?.purchaseCost?.toString() || null; const nextTaxInclusive = product.taxInclusive; const nextSeparateTax = nextTaxInclusive ? null : product.separateTaxAmount; product.priceChanged = (Boolean(product.purchaseCost) && decimalKey(nextPurchase) !== decimalKey(current?.purchaseCost?.toString())) || nextTaxInclusive !== (current?.taxInclusive ?? true) || decimalKey(nextSeparateTax) !== decimalKey(current?.separateTaxAmount?.toString()); }
  }
  if (type === 'selling') {
    const ruleSheet = wb.getWorksheet('Price Rules'); if (ruleSheet.rowCount > 20001) throw fail(413, 'WORKBOOK_TOO_MANY_ROWS', 'A workbook may contain at most 20,000 price-rule rows.'); const ruleMap = heading(ruleSheet); const ruleIds = new Set(); const productRowsByName = new Map();
    for (const item of data.products) { const key = item.name.toLocaleLowerCase().trim(); if (!productRowsByName.has(key)) productRowsByName.set(key, []); productRowsByName.get(key).push(item); }
    const ruleColumns = new Set(['product key','product id','product name','rule id','customer user id','customer name','customer phone number','minimum quantity','selling price','active']);
    for (const field of ruleMap.keys()) if (!ruleColumns.has(field)) errors.push({ sheet: 'Price Rules', row: 1, column: field, message: `Unsupported column: ${field}` });
    for (const field of ['product key', 'product id', 'product name', 'rule id', 'customer user id', 'customer name', 'customer phone number', 'minimum quantity', 'selling price', 'active']) if (!ruleMap.has(field)) errors.push({ sheet: 'Price Rules', row: 1, column: field, message: `Missing column: ${field}` });
    const candidates = []; const phones = new Set(); const numericPhoneSuffixes = new Set(); const customerIds = new Set();
    for (let i = 2; i <= ruleSheet.rowCount; i++) {
      const row = ruleSheet.getRow(i);
      try {
        row.eachCell({ includeEmpty: false }, (cell, col) => { if (![1, 2].includes(col)) text(cell); });
        const productName = column(ruleMap, row, 'product name'); const ruleId = column(ruleMap, row, 'rule id'); const customerName = column(ruleMap, row, 'customer name'); const rawPhone = column(ruleMap, row, 'customer phone number'); const q = column(ruleMap, row, 'minimum quantity'); const price = column(ruleMap, row, 'selling price'); const activeText = column(ruleMap, row, 'active').toLowerCase(); const customerUserId = column(ruleMap, row, 'customer user id') || null;
        if (![productName, ruleId, customerName, rawPhone, q, price, activeText].some(Boolean)) continue;
        const matches = productRowsByName.get(productName.toLocaleLowerCase().trim()) || []; if (matches.length !== 1) throw fail(400, 'WORKBOOK_RULE_PRODUCT', matches.length ? 'Product Name is ambiguous in the Products sheet.' : 'Select a Product Name from the Products sheet.'); const productRow = matches[0];
        if (ruleId && (!mongoose.isValidObjectId(ruleId) || ruleIds.has(ruleId))) throw fail(400, 'WORKBOOK_DUPLICATE_RULE', 'Rule ID is invalid or appears more than once.'); if (ruleId) ruleIds.add(ruleId);
        if (customerUserId && !mongoose.isValidObjectId(customerUserId)) throw fail(400, 'WORKBOOK_CUSTOMER', 'Customer User ID is invalid.');
        if (customerUserId) customerIds.add(customerUserId);
        if (Boolean(customerName) !== Boolean(rawPhone)) throw fail(400, 'WORKBOOK_CUSTOMER', 'Enter both Customer Name and Customer Phone Number.');
        if (!ruleId && (!customerName || !rawPhone || !q || !price || !activeText)) throw fail(400, 'WORKBOOK_RULE_REQUIRED', 'New rules require customer name, phone, minimum quantity, selling price, and Active.');
        const phoneCell = row.getCell(ruleMap.get('customer phone number')); const phone = rawPhone ? rawPhone.replace(/[\s().-]/g, '') : ''; let phoneE164 = ''; let phoneDigits = '';
        if (phone) { if (typeof phoneCell.value === 'number') { if (!Number.isSafeInteger(phoneCell.value) || !/^\d{7,15}$/.test(String(phoneCell.value))) throw fail(400, 'WORKBOOK_CUSTOMER_PHONE', 'Customer Phone Number was stored as a number. Download F012-5 and enter it in the text-formatted column with + and country code.'); phoneDigits = String(phoneCell.value); numericPhoneSuffixes.add(phoneDigits); } else { if (!parsePhoneE164(phone)) throw fail(400, 'WORKBOOK_CUSTOMER_PHONE', 'Customer Phone Number must include a valid country calling code, for example +919876543210.'); phoneE164 = phone; phones.add(phoneE164); } }
        const quantity = q ? Number(q) : null; if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1)) throw fail(400, 'WORKBOOK_QUANTITY', 'Minimum Quantity must be a positive whole number.');
        const sellingPrice = decimalText(price); if (!activeText || !['yes','no'].includes(activeText)) throw fail(400, 'WORKBOOK_ACTIVE', 'Active must be Yes or No.');
        candidates.push({ rowNumber: i, productKey: productRow.key, productId: productRow.productId, productName: productRow.name, ruleId: ruleId || null, customerUserId, customerName, phoneE164, phoneDigits, minimumQuantity: quantity, sellingPrice, active: activeText === 'yes' });
      } catch (e) { errors.push({ sheet: 'Price Rules', row: i, column: 'Rule data', code: e.code || 'INVALID_ROW', message: e.message }); }
    }
    const phoneSuffixQueries = [...numericPhoneSuffixes].map(digits => ({ phoneE164: { $regex: `${digits}$` } })); const users = await User.find({ $or: [...(phones.size ? [{ phoneE164: { $in: [...phones] } }] : []), ...phoneSuffixQueries, ...(customerIds.size ? [{ _id: { $in: [...customerIds] } }] : [])] }).select('_id displayName phoneE164').lean(); const userById = new Map(users.map(user => [String(user._id), user])); const userByPhone = new Map(users.map(user => [user.phoneE164, user])); const conditions = new Set();
    for (const candidate of candidates) {
      try {
        let user = candidate.customerUserId ? userById.get(candidate.customerUserId) : null;
        if (candidate.customerUserId && !user) throw fail(400, 'WORKBOOK_CUSTOMER', 'Customer User ID does not belong to a registered user.');
        if (candidate.phoneE164 || candidate.phoneDigits) { let phoneUser = candidate.phoneE164 ? userByPhone.get(candidate.phoneE164) : null; if (candidate.phoneDigits) { const suffixMatches = users.filter(item => item.phoneE164.endsWith(candidate.phoneDigits) && (item.displayName || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase() === candidate.customerName.trim().replace(/\s+/g, ' ').toLocaleLowerCase()); if (suffixMatches.length !== 1) throw fail(400, 'WORKBOOK_CUSTOMER_PHONE', 'Excel converted this phone to a number. Use the F012-5 template and enter the phone as text with + and country code.'); phoneUser = suffixMatches[0]; } if (!phoneUser) throw fail(400, 'WORKBOOK_CUSTOMER_NOT_FOUND', 'No registered user matches this customer phone number.'); user = phoneUser; if ((user.displayName || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase() !== candidate.customerName.trim().replace(/\s+/g, ' ').toLocaleLowerCase()) throw fail(400, 'WORKBOOK_CUSTOMER_MISMATCH', 'Customer Name and Phone Number do not match a registered user.'); }
        if (candidate.customerName && !candidate.phoneE164) throw fail(400, 'WORKBOOK_CUSTOMER_PHONE', 'Enter Customer Phone Number.');
        if (candidate.ruleId && candidate.customerUserId && candidate.phoneE164 && !user) throw fail(400, 'WORKBOOK_CUSTOMER_MISMATCH', 'Customer details do not match the rule.');
        candidate.customerUserId = user ? String(user._id) : null;
        const condition = `${candidate.productKey}:${candidate.customerUserId || '*'}:${candidate.minimumQuantity ?? '*'}`; if (conditions.has(condition)) throw fail(400, 'WORKBOOK_DUPLICATE_RULE', 'Duplicate product, customer, and minimum quantity rule.'); conditions.add(condition);
        if (candidate.ruleId) { const current = existingPriceByProduct.get(candidate.productId); const oldRule = (current?.rules || []).find(rule => String(rule._id) === candidate.ruleId); if (!oldRule) throw fail(400, 'WORKBOOK_RULE_NOT_FOUND', 'Rule ID does not belong to this product.'); candidate.changed = String(oldRule.customerUserId || '') !== String(candidate.customerUserId || '') || (oldRule.minimumQuantity ?? null) !== candidate.minimumQuantity || decimalKey(oldRule.sellingPrice?.toString()) !== decimalKey(candidate.sellingPrice) || Boolean(oldRule.active) !== candidate.active; if (candidate.changed) data.rules.push(candidate); }
        else data.rules.push(candidate);
      } catch (e) { errors.push({ sheet: 'Price Rules', row: candidate.rowNumber, column: 'Customer / rule', code: e.code || 'INVALID_RULE', message: e.message }); }
    }
  }
  const changedRuleProductKeys = new Set(data.rules.map(rule => rule.productKey)); data.products = data.products.filter(product => product.priceChanged || changedRuleProductKeys.has(product.key));
  if (!errors.length && !data.products.length && !data.rules.length) errors.push({ sheet: 'Workbook', row: 0, column: 'Changes', code: 'NO_CHANGES', message: 'No product or price rule changes were found.' });
  const operationId = crypto.randomUUID(); const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  await (await importSessions()).create({ operationId, businessId: bid, userId: uid, workbookType: type, digest, parsedData: data, errors, expiresAt: new Date(Date.now() + 30 * 60 * 1000) });
  return { operationId, digest, expiresAt: new Date(Date.now() + 30 * 60 * 1000), errors, products: data.products.filter(p => p.priceChanged).map(p => ({ rowNumber: p.rowNumber, key: p.key, productId: p.productId, name: p.name, price: type === 'selling' ? p.defaultSellingPrice : p.purchaseCost, similarMatches: p.similarMatches || [] })), rules: data.rules.map(rule => ({ rowNumber: rule.rowNumber, productName: rule.productName, customerName: rule.customerName, minimumQuantity: rule.minimumQuantity, sellingPrice: rule.sellingPrice, active: rule.active, isNew: !rule.ruleId })), ruleCount: data.rules.length, canCommit: errors.length === 0 };
}
async function commitWorkbook(bid, uid, operationId, digest, choices = []) {
  await access(bid, uid, 'business.pricing.view'); await access(bid, uid, 'business.pricing.import');
  const ImportSession = await importSessions(); const session = await ImportSession.findOne({ operationId, businessId: bid, userId: uid, committedAt: null, expiresAt: { $gt: new Date() } }); if (!session) throw fail(409, 'WORKBOOK_SESSION_EXPIRED', 'Validate this workbook again before committing.');
  if (session.digest !== digest || session.errors.length) throw fail(409, 'WORKBOOK_VALIDATION_STALE', 'Workbook validation is stale or contains errors. Validate it again.');
  const choiceMap = new Map(choices.map(x => [Number(x.rowNumber), x])); const results = []; const ruleResults = []; const idsByKey = new Map(); const decisionErrors = [];
  const products = session.parsedData.products || [];
  for (const row of products) {
    if (row.productId) { idsByKey.set(row.key, row.productId); continue; }
    const choice = choiceMap.get(row.rowNumber); if (!choice || !['create', 'ignore', 'update'].includes(choice.action)) { decisionErrors.push({ row: row.rowNumber, code: 'PRODUCT_CHOICE_REQUIRED' }); continue; }
    if (choice.action === 'ignore') { results.push({ rowNumber: row.rowNumber, ignored: true }); continue; }
    if (choice.action === 'update' && (!choice.productId || !mongoose.isValidObjectId(choice.productId) || !await Product.exists({ _id: choice.productId, businessId: bid }))) { decisionErrors.push({ row: row.rowNumber, code: 'PRODUCT_CHOICE_INVALID' }); continue; }
    const hasMatches = (row.similarMatches || []).length > 0; if (hasMatches && choice.action === 'create' && choice.confirmDuplicate !== true) { decisionErrors.push({ row: row.rowNumber, code: 'DUPLICATE_CONFIRMATION_REQUIRED' }); continue; }
    idsByKey.set(row.key, choice.action === 'update' ? choice.productId : `new:${row.key}`);
  }
  if (decisionErrors.length) return { committed: false, decisionErrors, results: [] };
  for (const row of products) {
    const id = idsByKey.get(row.key); const ruleRows = (session.parsedData.rules || []).filter(rule => rule.productKey === row.key);
    if (!id) { for (const rule of ruleRows) ruleResults.push({ rowNumber: rule.rowNumber, productName: row.name, customerName: rule.customerName, sellingPrice: rule.sellingPrice, ignored: true }); continue; }
    try {
      let productId = id;
      const productFields = { name: row.name, type: row.type, categoryIds: row.categoryIds, baseUnit: row.baseUnit, units: row.units, quantityVariants: row.quantityVariants };
      if (id.startsWith('new:')) { const choice = choiceMap.get(row.rowNumber); if (choice.action === 'create') { await access(bid, uid, 'business.catalog.products.manage'); const created = await catalog.createProduct(bid, uid, { ...productFields, description: row.description }); productId = created.id; } else productId = id; }
      else if (!row.productId) { await access(bid, uid, 'business.catalog.products.manage'); const choice = choiceMap.get(row.rowNumber); if (choice.action === 'update') await catalog.updateProduct(bid, uid, productId, productFields); }
      const currentProduct = await Product.findOne({ _id: productId, businessId: bid }).lean();
      if (!currentProduct || JSON.stringify(productUnits.dto(currentProduct).baseUnit) !== JSON.stringify(row.baseUnit)) throw fail(409, 'WORKBOOK_UNIT_REFERENCE', 'Product base units changed. Download and validate a current workbook.');
      const old = await Price.findOne({ businessId: bid, productId }).lean();
      if (session.workbookType === 'selling') {
        await pricing.saveWorkbook(bid, uid, productId, { ...(row.priceChanged ? { defaultSellingPrice: row.defaultSellingPrice || null } : {}), ruleChanges: ruleRows, version: old?.version || 0 });
      } else {
        await pricing.save(bid, uid, productId, { purchaseCost: row.purchaseCost || old?.purchaseCost?.toString() || null, taxInclusive: row.taxInclusive, separateTaxAmount: row.separateTaxAmount || null, separateTaxId: row.separateTaxId || null, version: old?.version || 0 });
      }
      for (const rule of ruleRows) ruleResults.push({ rowNumber: rule.rowNumber, productName: row.name, customerName: rule.customerName, minimumQuantity: rule.minimumQuantity, sellingPrice: rule.sellingPrice, success: true, created: !rule.ruleId });
      if (row.priceChanged) results.push({ rowNumber: row.rowNumber, productId, name: row.name, price: session.workbookType === 'selling' ? (row.defaultSellingPrice || old?.defaultSellingPrice?.toString() || '') : (row.purchaseCost || old?.purchaseCost?.toString() || ''), success: true, priceChanged: true });
    } catch (e) { for (const rule of ruleRows) ruleResults.push({ rowNumber: rule.rowNumber, productName: row.name, customerName: rule.customerName, minimumQuantity: rule.minimumQuantity, sellingPrice: rule.sellingPrice, success: false, code: e.code || 'IMPORT_ROW_FAILED' }); if (row.priceChanged) results.push({ rowNumber: row.rowNumber, productId: row.productId || undefined, name: row.name, price: session.workbookType === 'selling' ? row.defaultSellingPrice : row.purchaseCost, success: false, priceChanged: true, code: e.code || 'IMPORT_ROW_FAILED' }); }
  }
  await ImportSession.updateOne({ _id: session._id, committedAt: null }, { $set: { committedAt: new Date() } });
  return { committed: true, results, rulesSucceeded: ruleResults.filter(rule => rule.success).length, rulesFailed: ruleResults.filter(rule => rule.success === false).length, rulesIgnored: ruleResults.filter(rule => rule.ignored).length, ruleResults };
}
module.exports = { exportWorkbook, validateWorkbook, commitWorkbook, MAX_BYTES };
