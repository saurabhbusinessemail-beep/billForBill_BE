'use strict';

const mongoose = require('mongoose');
const { GridFSBucket, ObjectId } = require('mongodb');

let connectionPromise;
let jobsConnection;
let Job;
let bucket;

async function connectJobsDatabase() {
  if (!connectionPromise) {
    const uri = process.env.MONGODB_JOBS_URI || process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_JOBS_DB || 'billforbill_jobs';
    if (!uri) throw new Error('Set MONGODB_URI or MONGODB_JOBS_URI for background jobs.');
    const connection = mongoose.createConnection(uri, { dbName, maxPoolSize: 5, serverSelectionTimeoutMS: 10000 });
    jobsConnection = connection;
    connectionPromise = connection.asPromise().then(() => {
      const schema = new mongoose.Schema({
        type: { type: String, required: true, index: true },
        status: { type: String, enum: ['queued', 'processing', 'completed', 'failed'], default: 'queued', index: true },
        businessId: { type: String, required: true, index: true }, userId: { type: String, required: true, index: true },
        payload: { type: mongoose.Schema.Types.Mixed, default: {} }, inputFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
        resultFileId: { type: mongoose.Schema.Types.ObjectId, default: null }, outputFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
        progress: { type: Number, default: 0 }, message: { type: String, default: '' }, error: { type: String, default: '' },
        attempts: { type: Number, default: 0 }, availableAt: { type: Date, default: Date.now, index: true }, leaseUntil: { type: Date, default: null },
        leaseToken: { type: String, default: null },
        idempotencyKey: { type: String, default: null }, expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      }, { timestamps: true, collection: 'backgroundjobs' });
      schema.index({ status: 1, availableAt: 1, createdAt: 1 });
      schema.index({ businessId: 1, userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
      Job = connection.model('BackgroundJob', schema);
      bucket = new GridFSBucket(connection.getClient().db(dbName), { bucketName: 'jobfiles' });
      return connection;
    });
  }
  const connection = await connectionPromise;
  return { connection, Job, bucket };
}

async function closeJobsDatabase() {
  if (!jobsConnection) return;
  await jobsConnection.close();
  jobsConnection = undefined;
  connectionPromise = undefined;
  Job = undefined;
  bucket = undefined;
}

async function saveFile(buffer, filename, metadata = {}) {
  const { bucket: files } = await connectJobsDatabase();
  return new Promise((resolve, reject) => {
    const stream = files.openUploadStream(filename, { metadata, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    stream.on('error', reject); stream.on('finish', () => resolve(stream.id)); stream.end(buffer);
  });
}

async function readFile(id) {
  const { bucket: files } = await connectJobsDatabase();
  if (!id || !ObjectId.isValid(String(id))) throw Object.assign(new Error('Job artifact is unavailable.'), { statusCode: 404, code: 'JOB_FILE_NOT_FOUND' });
  const chunks = [];
  return new Promise((resolve, reject) => { const stream = files.openDownloadStream(new ObjectId(String(id))); stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject); stream.on('end', () => resolve(Buffer.concat(chunks))); });
}

async function cleanupExpiredFiles(retentionDays = 7) {
  const { bucket: files } = await connectJobsDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 86400000);
  const expired = await files.find({ uploadDate: { $lt: cutoff } }).limit(500).toArray();
  for (const file of expired) await files.delete(file._id).catch(() => {});
  return expired.length;
}

async function enqueue({ type, businessId, userId, payload = {}, inputBuffer, idempotencyKey }) {
  const { Job: Model } = await connectJobsDatabase();
  let inputFileId = null;
  if (inputBuffer) inputFileId = await saveFile(inputBuffer, `${type}-${Date.now()}.xlsx`, { businessId, userId, type });
  try {
    return await Model.create({ type, businessId: String(businessId), userId: String(userId), payload, inputFileId, idempotencyKey: idempotencyKey || undefined, expiresAt: new Date(Date.now() + 7 * 86400000) });
  } catch (error) {
    if (inputFileId) await (await connectJobsDatabase()).bucket.delete(inputFileId).catch(() => {});
    if (error.code === 11000 && idempotencyKey) return Model.findOne({ businessId: String(businessId), userId: String(userId), idempotencyKey });
    throw error;
  }
}

async function ownedJob(id, businessId, userId) {
  const { Job: Model } = await connectJobsDatabase();
  if (!ObjectId.isValid(String(id))) return null;
  return Model.findOne({ _id: id, businessId: String(businessId), userId: String(userId) }).lean();
}

module.exports = { connectJobsDatabase, closeJobsDatabase, saveFile, readFile, cleanupExpiredFiles, enqueue, ownedJob, get Job() { return Job; }, get bucket() { return bucket; } };
