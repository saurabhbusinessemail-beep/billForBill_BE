'use strict';

// Load environment variables from .env before anything else
require('dotenv').config();

const express = require('express');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { connectDatabase } = require('./src/DB/connection');
const authRouter = require('./src/routers/auth.router');
const loggedInUserInfoRouter = require('./src/routers/loggedInUserInfo.router');
const userProfileRouter = require('./src/routers/userProfile.router');
const workspacesRouter = require('./src/routers/workspaces.router');
const businessesRouter = require('./src/routers/businesses.router');
const businessLogosRouter = require('./src/routers/businessLogos.router');
const businessPeopleTeamsRouter = require('./src/routers/businessPeopleTeams.router');
const businessPricingRouter = require('./src/routers/businessPricing.router');
const businessOrdersRouter = require('./src/routers/businessOrders.router');
const businessInventoryRouter = require('./src/routers/businessInventory.router');
const businessLeadsRouter = require('./src/routers/businessLeads.router');
const businessBillsPaymentsRouter = require('./src/routers/businessBillsPayments.router');
const businessDeliveriesRouter = require('./src/routers/businessDeliveries.router');
const personalRouter = require('./src/routers/personal.router');
const adminSetupRouter = require('./src/routers/adminSetup.router');
const productImagesRouter = require('./src/routers/productImages.router');
const plansOffersRouter = require('./src/routers/plansOffers.router');

const PORT = Number(process.env.PORT || 3000);
const configuredFrontendOrigins = (process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || 'https://localhost:4200')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || '../certs/localhost-key.pem';
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || '../certs/localhost.pem';
const TLS_MODE = process.env.TLS_MODE || 'local';

// ---------------------------------------------------------------------------
// Validate required environment variables before starting
// ---------------------------------------------------------------------------
if (!process.env.MONGODB_URI || !process.env.OTP_HASH_SECRET || process.env.OTP_HASH_SECRET.length < 32) {
  console.error('[server] ERROR: Set MONGODB_URI and an OTP_HASH_SECRET of at least 32 characters in .env.');
  process.exit(1);
}
if (!['local', 'proxy'].includes(TLS_MODE)) {
  console.error('[server] ERROR: TLS_MODE must be either "local" or "proxy".');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
if (TLS_MODE === 'proxy') app.set('trust proxy', 1);

const allowedFrontendOrigins = new Set(configuredFrontendOrigins);
if (TLS_MODE === 'local') {
  for (const configuredOrigin of configuredFrontendOrigins) {
    try {
      const url = new URL(configuredOrigin);
      const configuredHost = url.hostname.replace(/^\[|\]$/g, '');
      if (['localhost', '127.0.0.1'].includes(configuredHost)) {
        for (const hostname of ['localhost', '127.0.0.1']) {
          allowedFrontendOrigins.add(`${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}`);
        }
      }
    } catch {
      // Invalid origins never match a browser Origin header.
    }
  }
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedFrontendOrigins.has(origin)) {
    return res.status(403).json({ success: false, error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed.' } });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, X-Product-Metadata, X-Catalog-Business-Id, X-Order-Metadata, Idempotency-Key');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health-check endpoint — useful for verifying the server is up
app.get('/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      dbState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    },
  });
});

app.use('/auth', authRouter);
app.use('/auth', loggedInUserInfoRouter);
app.use('/profile', userProfileRouter);
app.use('/workspaces', workspacesRouter);
app.use('/businesses', businessesRouter);
app.use('/businesses', businessLogosRouter);
app.use('/businesses', businessPeopleTeamsRouter);
app.use('/businesses', businessPricingRouter);
app.use('/businesses', businessOrdersRouter);
app.use('/businesses', businessInventoryRouter);
app.use('/businesses', businessLeadsRouter);
app.use('/businesses', businessBillsPaymentsRouter);
app.use('/businesses', businessDeliveriesRouter);
app.use('/personal', personalRouter);
app.use('/admin-setup/plans-offers', plansOffersRouter);
app.use('/admin-setup', adminSetupRouter);
app.use('/product-images', productImagesRouter);

app.use((err, _req, res, _next) => {
  console.error('[server] Request failed:', err.stack || err.message || err.code || err.name || 'UNKNOWN_ERROR');
  if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
  const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : Number.isInteger(err.status) ? err.status : 500;
  const expose = statusCode < 500 || err.expose === true;
  const code = expose && err.code ? err.code : 'INTERNAL_ERROR';
  const message = expose ? err.message : 'An unexpected error occurred.';
  res.status(statusCode).json({ success: false, error: { code, message, ...(expose && err.details ? { details: err.details } : {}) } });
});

// ---------------------------------------------------------------------------
// MongoDB connection
// ---------------------------------------------------------------------------
mongoose.set('strictQuery', true);

async function startServer() {
  try {
    await connectDatabase();
    let server;
    if (TLS_MODE === 'local') {
      const keyPath = path.resolve(__dirname, TLS_KEY_PATH);
      const certPath = path.resolve(__dirname, TLS_CERT_PATH);
      const tlsOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      server = https.createServer(tlsOptions, app).listen(PORT, () => {
        console.log(`[server] BillForBill local HTTPS API listening on port ${PORT}`);
      });
    } else {
      server = app.listen(PORT, () => {
        console.log(`[server] BillForBill API listening behind the HTTPS proxy on port ${PORT}`);
      });
    }

    // Graceful shutdown
    function shutdown(signal) {
      console.log(`[server] ${signal} received — shutting down gracefully`);
      server.close(async () => {
        await mongoose.connection.close();
        console.log('[server] Server and database connection closed');
        process.exit(0);
      });
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('[database] Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }
}

startServer();
