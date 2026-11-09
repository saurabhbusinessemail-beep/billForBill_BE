'use strict';
const service = require('../services/businessBillsPayments.service');
const run = (fn, status = 200) => async (req, res, next) => { try { res.status(status).json({ success: true, data: await fn(req) }); } catch (error) { next(error); } };
const raw = req => { if (!Buffer.isBuffer(req.body) || !req.body.length) throw Object.assign(new Error('Choose an image or PDF file.'), { statusCode: 400, code: 'BILL_FILE_REQUIRED', expose: true }); return req.body; };
const sendFile = load => async (req, res, next) => {
  try {
    const { image, stream } = await load(req.params.businessId, req.authUserId, req.params.billId, req.params.fileId);
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', String(image.size));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(image.filename)}"`);
    stream.on('error', next).pipe(res);
  } catch (error) { next(error); }
};
module.exports = {
  summary: run(req => service.summary(req.params.businessId, req.authUserId)),
  lookupParty: run(req => service.lookupBillParty(req.params.businessId, req.authUserId, req.query.countryCallingCode, req.query.phoneNumber)),
  listBills: run(req => service.listBills(req.params.businessId, req.authUserId, req.query)),
  listIncomingBills: run(req => service.listIncomingBills(req.params.businessId, req.authUserId, req.query)),
  getIncomingBill: run(req => service.getIncomingBill(req.params.businessId, req.authUserId, req.params.billId)),
  incomingBillFile: sendFile(service.incomingBillFile),
  createBill: run(req => service.createDraft(req.params.businessId, req.authUserId, req.body, req.get('Idempotency-Key')), 201),
  updateDraft: run(req => service.updateDraft(req.params.businessId, req.authUserId, req.params.billId, req.body)),
  getBill: run(req => service.getBill(req.params.businessId, req.authUserId, req.params.billId)),
  issueBill: run(req => service.issue(req.params.businessId, req.authUserId, req.params.billId)),
  cancelBill: run(req => service.cancelBill(req.params.businessId, req.authUserId, req.params.billId)),
  delivery: run(req => service.changeDelivery(req.params.businessId, req.authUserId, req.params.billId, req.body)),
  deleteDraft: run(req => service.deleteDraft(req.params.businessId, req.authUserId, req.params.billId)),
  uploadFile: run(req => service.uploadFile(req.params.businessId, req.authUserId, req.params.billId, raw(req), req.query.filename), 201),
  file: sendFile(service.billFileStream),
  pendingBills: run(req => service.pendingBills(req.params.businessId, req.authUserId, req.query)),
  listPayments: run(req => service.listPayments(req.params.businessId, req.authUserId, req.query)),
  listPartyBalances: run(req => service.listPartyBalances(req.params.businessId, req.authUserId, req.query)),
  getPayment: run(req => service.getPaymentRecord(req.params.businessId, req.authUserId, req.params.paymentId)),
  paymentSummary: run(req => service.paymentSummary(req.params.businessId, req.authUserId)),
  createPayment: run(req => service.createPayment(req.params.businessId, req.authUserId, req.body, req.get('Idempotency-Key')), 201),
  reversePayment: run(req => service.reversePayment(req.params.businessId, req.authUserId, req.params.paymentId, req.body.reason)),
  getMethodConfig: run(req => service.paymentDetails(req.params.businessId, req.authUserId)),
  saveMethodConfig: run(req => service.savePaymentMethodConfig(req.params.businessId, req.authUserId, req.body.fields)),
  getNumberConfig: run(req => service.documentNumberConfig(req.params.businessId, req.authUserId)),
  saveNumberConfig: run(req => service.saveDocumentNumberConfig(req.params.businessId, req.authUserId, req.body.fields)),
  getTransportConfig: run(req => service.transportConfig(req.params.businessId, req.authUserId)),
  saveTransportConfig: run(req => service.saveTransportConfig(req.params.businessId, req.authUserId, req.body.fields)),
};
