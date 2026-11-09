'use strict';

const express = require('express');
const { requireSession } = require('../middleware/requireSession');
const service = require('../services/businessOpeningBalances.service');
const router = express.Router();
const path = '/:businessId/opening-balances';

const run = (handler, input = req => req.query) => async (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const data = await handler(req.params.businessId, req.authUserId, input(req), req.get('Idempotency-Key'));
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

router.get(`${path}/counterparties`, requireSession, run(service.partyOptions));
router.get(`${path}/statement`, requireSession, run(service.statement));
router.get(`${path}/latest`, requireSession, run(service.latest));
router.post(`${path}/operations/preview`, requireSession, run(service.preview, req => req.body || {}));
router.post(`${path}/operations/commit`, requireSession, run(service.commit, req => req.body || {}));
module.exports = router;
