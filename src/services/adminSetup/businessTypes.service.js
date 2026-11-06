'use strict';
const common = require('./catalogCommon.service');
module.exports = { list: (query) => common.list('business-types', query), get: (id) => common.get('business-types', id), create: (data) => common.create('business-types', data), update: (id, data) => common.update('business-types', id, data), remove: (id) => common.remove('business-types', id), deleteImpact: (id) => common.deleteImpact('business-types', id) };
