'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { connectDatabase } = require('./src/DB/connection');
const jobs = require('./src/services/backgroundJobs.service');
const workbooks = require('./src/services/businessPricingWorkbook.service');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_ATTEMPTS = 3;

async function processJob(job) {
  const leaseFilter = { _id: job._id, status: 'processing', leaseToken: job.leaseToken };
  const report = async (progress, message) => jobs.Job.updateOne(leaseFilter, { $set: { progress, message, leaseUntil: new Date(Date.now() + 60000) } });
  await report(10, 'Starting workbook task');
  if (job.type === 'pricing.export') {
    await report(20, 'Preparing workbook data');
    const buffer = await workbooks.exportWorkbook(job.businessId, job.userId, job.payload.workbookType, job.payload.productIds || []);
    await report(90, 'Saving workbook');
    const outputFileId = await jobs.saveFile(buffer, `${job.payload.workbookType}-pricing.xlsx`, { businessId: job.businessId, userId: job.userId, jobId: String(job._id), kind: 'export' });
    await jobs.Job.updateOne(leaseFilter, { $set: { outputFileId, progress: 100, message: 'Workbook is ready', status: 'completed', leaseUntil: null, leaseToken: null } });
    return;
  }
  if (job.type === 'pricing.validate') {
    await report(20, 'Reading workbook');
    const input = await jobs.readFile(job.inputFileId);
    await report(35, 'Validating workbook rows');
    const result = await workbooks.validateWorkbook(job.businessId, job.userId, job.payload.workbookType, input);
    await report(90, 'Saving validation result');
    const resultFileId = await jobs.saveFile(Buffer.from(JSON.stringify(result)), `${job._id}-validation.json`, { businessId: job.businessId, userId: job.userId, jobId: String(job._id), kind: 'result' });
    await jobs.Job.updateOne(leaseFilter, { $set: { resultFileId, progress: 100, message: 'Workbook validation is ready', status: 'completed', leaseUntil: null, leaseToken: null } });
    return;
  }
  if (job.type === 'pricing.commit') {
    await report(20, 'Applying reviewed changes');
    const result = await workbooks.commitWorkbook(job.businessId, job.userId, job.payload.operationId, job.payload.digest, job.payload.choices || []);
    await report(90, 'Saving import result');
    const resultFileId = await jobs.saveFile(Buffer.from(JSON.stringify(result)), `${job._id}-import-result.json`, { businessId: job.businessId, userId: job.userId, jobId: String(job._id), kind: 'result' });
    await jobs.Job.updateOne(leaseFilter, { $set: { resultFileId, progress: 100, message: 'Import is complete', status: 'completed', leaseUntil: null, leaseToken: null } });
    return;
  }
  throw Object.assign(new Error('Unknown background job type.'), { permanent: true });
}

async function run() {
  await connectDatabase();
  await jobs.connectJobsDatabase();
  await jobs.Job.updateMany({ type: 'pricing.commit', status: 'processing', leaseUntil: { $lt: new Date() } }, { $set: { status: 'failed', leaseUntil: null, leaseToken: null, error: 'COMMIT_WORKER_INTERRUPTED', message: 'Commit stopped unexpectedly. Validate and review the workbook before retrying.' } });
  await jobs.cleanupExpiredFiles();
  console.log('[worker] Background job worker started.');
  let running = true;
  let lastArtifactCleanup = Date.now();
  const stop = signal => { if (!running) return; running = false; console.log(`[worker] ${signal} received; finishing current task before shutdown.`); };
  process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop('SIGTERM'));
  while (running) {
    if (Date.now() - lastArtifactCleanup > 60 * 60 * 1000) { await jobs.cleanupExpiredFiles().catch(error => console.error('[worker] Artifact cleanup failed:', error.message)); lastArtifactCleanup = Date.now(); }
    const now = new Date();
    await jobs.Job.updateMany({ type: 'pricing.commit', status: 'processing', leaseUntil: { $lt: now } }, { $set: { status: 'failed', leaseUntil: null, leaseToken: null, error: 'COMMIT_WORKER_INTERRUPTED', message: 'Commit stopped unexpectedly. Validate and review the workbook before retrying.' } });
    const leaseToken = crypto.randomUUID();
    const job = await jobs.Job.findOneAndUpdate({ $or: [{ status: 'queued', availableAt: { $lte: now } }, { status: 'processing', type: { $ne: 'pricing.commit' }, leaseUntil: { $lt: now } }] }, { $set: { status: 'processing', leaseUntil: new Date(Date.now() + 60000), leaseToken, message: 'Processing' }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, new: true });
    if (!job) { await sleep(700); continue; }
    const heartbeat = setInterval(() => jobs.Job.updateOne({ _id: job._id, status: 'processing', leaseToken }, { $set: { leaseUntil: new Date(Date.now() + 60000) } }).catch(() => {}), 20000);
    try { await processJob(job); }
    catch (error) {
      const safeRetry = job.type !== 'pricing.commit' && !error.permanent && job.attempts < MAX_ATTEMPTS;
      await jobs.Job.updateOne({ _id: job._id, leaseToken }, { $set: { status: safeRetry ? 'queued' : 'failed', availableAt: new Date(Date.now() + job.attempts * 2000), leaseUntil: null, leaseToken: null, error: String(error.code || error.message || 'JOB_FAILED').slice(0, 500), message: safeRetry ? 'Retrying workbook task' : 'Workbook task failed' } });
      console.error(`[worker] Job ${job._id} failed:`, error.message);
    } finally { clearInterval(heartbeat); }
  }
  await mongoose.connection.close();
  await jobs.closeJobsDatabase();
  console.log('[worker] Shutdown complete.');
}

run().catch(error => { console.error('[worker] Fatal error:', error); process.exit(1); });
