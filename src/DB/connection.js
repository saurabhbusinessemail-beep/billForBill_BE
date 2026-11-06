'use strict';

const mongoose = require('mongoose');

async function connectDatabase() {
  await mongoose.connect(process.env.MONGODB_URI);
  mongoose.set('strictQuery', true);
  console.log('[database] Connected to MongoDB.');
}

function assertDatabaseConnected() {
  if (mongoose.connection.readyState !== 1) {
    const error = new Error('Database is unavailable.');
    error.statusCode = 503;
    error.code = 'DATABASE_UNAVAILABLE';
    error.expose = true;
    throw error;
  }
}

module.exports = { connectDatabase, assertDatabaseConnected };
