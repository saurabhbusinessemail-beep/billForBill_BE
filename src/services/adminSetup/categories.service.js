'use strict';
const common = require('./catalogCommon.service');
module.exports = { list: (query) => common.list('categories', query), get: (id) => common.get('categories', id), create: (data) => common.create('categories', data), update: (id, data) => common.update('categories', id, data), remove: (id) => common.remove('categories', id), deleteImpact: (id) => common.deleteImpact('categories', id) };
