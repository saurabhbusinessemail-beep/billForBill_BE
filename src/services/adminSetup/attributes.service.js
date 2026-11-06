'use strict';
const common = require('./catalogCommon.service');
module.exports = { list: (query) => common.list('attributes', query), get: (id) => common.get('attributes', id), create: (data) => common.create('attributes', data), update: (id, data) => common.update('attributes', id, data), remove: (id) => common.remove('attributes', id), deleteImpact: (id) => common.deleteImpact('attributes', id) };
