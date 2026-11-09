'use strict';

const mongoose = require('mongoose');
const { assertDatabaseConnected } = require('../DB/connection');
const Business = require('../DB/models/Business');
const BusinessType = require('../DB/models/BusinessType');
const Product = require('../DB/models/CatalogProduct');
const BusinessProduct = require('../DB/models/BusinessCatalogProduct');
const ProductImage = require('../DB/models/ProductImage');
const jobs = require('./backgroundJobs.service');

const businessModels = [
  'BusinessPaymentAllocation', 'BusinessPaymentJournal', 'BusinessPayment',
  'BusinessDelivery', 'BusinessBillImage', 'BusinessOrderImage',
  'BusinessBill', 'BusinessOrder', 'BusinessLead', 'BusinessInventoryMovement',
  'BusinessProductPricing', 'BusinessCatalogProduct', 'BusinessCatalogCategory',
  'BusinessCatalogAttribute', 'BusinessCatalogUnit',
].map(name => require('../DB/models/' + name));
const sharedModels = ['CatalogProduct', 'ProductCategory', 'ProductAttribute', 'CatalogUnit']
  .map(name => require('../DB/models/' + name));
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
let cleanupRunning = false;

async function removeRows(Model, filter, counts) {
  const result = await Model.deleteMany(filter);
  counts[Model.modelName] = (counts[Model.modelName] || 0) + (result.deletedCount || 0);
}

// Delete chunks first so an interrupted cleanup can safely retry from the file row.
async function removeFiles(db, bucket, filter, counts) {
  for await (const file of db.collection(bucket + '.files').find(filter, { projection: { _id: 1 } })) {
    const chunks = await db.collection(bucket + '.chunks').deleteMany({ files_id: file._id });
    counts[bucket + '.chunks'] = (counts[bucket + '.chunks'] || 0) + (chunks.deletedCount || 0);
    const result = await db.collection(bucket + '.files').deleteOne({ _id: file._id });
    counts[bucket + '.files'] = (counts[bucket + '.files'] || 0) + (result.deletedCount || 0);
  }
}

async function removeUnusedProductImages(candidateIds, counts) {
  // Shared images remain usable by business copies after Admin Setup-only cleanup.
  for (const productId of candidateIds) {
    if (!await Product.exists({ _id: productId }) && !await BusinessProduct.exists({ $or: [{ _id: productId }, { sourceProductId: productId }] })) {
      await removeRows(ProductImage, { productId }, counts);
    }
  }
}

async function cleanAdminCatalog(counts) {
  const productIds = await Product.distinct('_id', { businessId: null });
  const result = await BusinessType.updateMany({ businessId: null }, {
    $set: { productIds: [] },
  });
  counts.BusinessTypeLinksCleared = result.modifiedCount || 0;
  for (const Model of sharedModels) await removeRows(Model, { businessId: null }, counts);
  await removeUnusedProductImages(productIds, counts);
}

async function cleanBusiness(businessId, jobStore, counts) {
  const scope = { businessId };
  const products = await BusinessProduct.find(scope).select('_id sourceProductId').lean();
  const imageIds = products.flatMap(product => [product._id, product.sourceProductId].filter(Boolean));
  for (const [bucket, name] of [['businessBillImages', 'BusinessBillImage'], ['businessOrderImages', 'BusinessOrderImage']]) {
    const fileIds = await require('../DB/models/' + name).distinct('fileId', scope);
    await removeFiles(mongoose.connection.db, bucket, { $or: [
      { 'metadata.businessId': String(businessId) }, { 'metadata.businessId': businessId }, { _id: { $in: fileIds } },
    ] }, counts);
  }
  const jobScope = { businessId: String(businessId), type: /^pricing\./ };
  const jobRows = await jobStore.Job.find(jobScope).select('inputFileId resultFileId outputFileId').lean();
  const jobFileIds = jobRows.flatMap(row => [row.inputFileId, row.resultFileId, row.outputFileId].filter(Boolean));
  // Remove queued jobs before deleting data so a worker cannot start them later.
  await removeRows(jobStore.Job, { ...jobScope, status: { $ne: 'processing' } }, counts);
  if (await jobStore.Job.exists({ ...jobScope, status: 'processing' })) throw fail(409, 'PRICING_JOB_IN_PROGRESS', 'Wait for the active pricing job to finish before cleanup.');
  await removeFiles(jobStore.connection.db, 'jobfiles', { $or: [
    { 'metadata.businessId': String(businessId) }, { 'metadata.businessId': businessId }, { _id: { $in: jobFileIds } },
  ] }, counts);
  const ImportSession = require('../DB/models/PricingImportSession')(jobStore.connection);
  await removeRows(ImportSession, scope, counts);
  for (const Model of businessModels) await removeRows(Model, scope, counts);
  await removeUnusedProductImages(imageIds, counts);
  // Do not trigger template recopy when opening the now-empty business.
  await Business.updateOne({ _id: businessId }, { $set: { catalogCopyState: 'complete', catalogProvenance: null } });
}

async function cleanup(kind, businessId) {
  assertDatabaseConnected();
  if (kind === 'business' && (typeof businessId !== 'string' || !/^[a-f\d]{24}$/i.test(businessId))) throw fail(400, 'INVALID_BUSINESS_ID', 'Enter a valid business ID.');
  if (kind === 'business') businessId = new mongoose.Types.ObjectId(businessId).toHexString();
  if (!['admin', 'business', 'all'].includes(kind)) throw fail(400, 'INVALID_CLEANUP_SCOPE', 'Choose a valid cleanup scope.');
  if (cleanupRunning) throw fail(409, 'CLEANUP_IN_PROGRESS', 'Another cleanup is in progress.');
  cleanupRunning = true;
  const counts = {};
  let completedBusinesses = 0;
  try {
    const scope = kind === 'business' ? { _id: new mongoose.Types.ObjectId(businessId) } : {};
    if (kind === 'business' && !await Business.exists(scope)) throw fail(404, 'BUSINESS_NOT_FOUND', 'Business not found.');
    let jobStore;
    if (kind !== 'admin') {
      jobStore = await jobs.connectJobsDatabase();
      const jobScope = { type: /^pricing\./, status: 'processing', ...(kind === 'business' ? { businessId } : {}) };
      if (await jobStore.Job.exists(jobScope)) throw fail(409, 'PRICING_JOB_IN_PROGRESS', 'Wait for the active pricing job to finish before cleanup.');
      for await (const business of Business.find(scope).select('_id').lean().cursor()) {
        await cleanBusiness(business._id, jobStore, counts);
        completedBusinesses++;
      }
    }
    if (kind !== 'business') await cleanAdminCatalog(counts);
    return { scope: kind, ...(kind === 'business' ? { businessId } : {}), completedBusinesses, deletedCounts: counts };
  } catch (cause) {
    if (Object.keys(counts).length) {
      throw Object.assign(fail(500, 'CLEANUP_INCOMPLETE', 'Cleanup stopped after partial progress. Retry the same endpoint to finish.'), { expose: true, details: { completedBusinesses, deletedCounts: counts }, cause });
    }
    throw cause;
  } finally { cleanupRunning = false; }
}

async function listBusinesses(query = {}) {
  assertDatabaseConnected();
  const page = Number(query.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw fail(400, 'INVALID_PAGE', 'Enter a valid page number.');
  const q = String(query.q || '').trim().slice(0, 160);
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // System-wide Super Admin listing: never restrict by session user or business owner.
  const filter = q ? { legalName: new RegExp(escaped, 'i') } : {};
  const pageSize = 25;
  const [rows, total] = await Promise.all([
    Business.find(filter).select('legalName phone').sort({ legalName: 1, _id: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Business.countDocuments(filter),
  ]);
  return { items: rows.map(row => ({ id: String(row._id), name: row.legalName, phone: row.phone || '' })), page, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

module.exports = { cleanup, listBusinesses };
