'use strict';

const mongoose = require('mongoose');
const Product = require('../DB/models/BusinessCatalogProduct');

const serviceTypes = ['Service', 'Services'];
const isServiceType = type => serviceTypes.includes(type);
const isServiceLine = line => isServiceType(line.productType) || (!line.productType && Boolean(line.serviceRange));

async function stockLines(businessId, lines) {
  const legacyIds = [...new Set(lines.filter(line => !line.productType && !line.serviceRange)
    .map(line => String(line.productId || '')).filter(id => mongoose.isValidObjectId(id)))];
  const services = legacyIds.length
    ? await Product.find({ businessId, _id: { $in: legacyIds }, type: { $in: serviceTypes } }).select('_id').lean()
    : [];
  const serviceIds = new Set(services.map(product => String(product._id)));
  return lines.filter(line => !isServiceLine(line) && (line.productType || !serviceIds.has(String(line.productId))));
}

module.exports = { serviceTypes, isServiceType, isServiceLine, stockLines };
