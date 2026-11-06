'use strict';
const common = require('./catalogCommon.service');
module.exports = { list: (query) => common.list('units', query), get: (id) => common.get('units', id), create: (data) => common.create('units', data), update: (id, data) => common.update('units', id, data), remove: (id) => common.remove('units', id), deleteImpact: (id) => common.deleteImpact('units', id) };
