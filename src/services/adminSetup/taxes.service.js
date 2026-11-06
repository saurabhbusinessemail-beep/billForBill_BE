'use strict';
const common = require('./catalogCommon.service');
module.exports = { list: (query) => common.list('taxes', query), get: (id) => common.get('taxes', id), create: (data) => common.create('taxes', data), update: (id, data) => common.update('taxes', id, data), remove: (id) => common.remove('taxes', id), deleteImpact: (id) => common.deleteImpact('taxes', id) };
