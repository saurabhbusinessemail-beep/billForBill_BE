'use strict';

const service = require('../services/personal.service');

module.exports = {
  dashboard: async (req, res, next) => {
    try { res.json({ success: true, data: await service.dashboard(req.authUserId, req.query) }); }
    catch (error) { next(error); }
  },
  bill: async (req, res, next) => {
    try { res.json({ success: true, data: await service.bill(req.authUserId, req.params.billId) }); }
    catch (error) { next(error); }
  },
  file: async (req, res, next) => {
    try {
      const { image, stream } = await service.billFile(req.authUserId, req.params.billId, req.params.fileId);
      res.setHeader('Content-Type', image.contentType);
      res.setHeader('Content-Length', String(image.size));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(image.filename)}"`);
      stream.on('error', next).pipe(res);
    } catch (error) { next(error); }
  },
};
