'use strict';
const common = require('./catalogCommon.service');
const images = require('./productImages.service');
const ProductImage = require('../../DB/models/ProductImage');
const { assertDatabaseConnected } = require('../../DB/connection');
const fail = common.error;
async function updateWithImage(id, input, type, name, bytes, businessId = null) {
  const Product = common.modelFor('products', businessId);
  const safeName = images.validateImage(type, name, bytes);
  const current = await Product.findById(id); if (!current) throw fail(404, 'CATALOG_ITEM_NOT_FOUND', 'Product not found.');
  const old = current.toObject();
  const saved = await common.update('products', id, input, businessId);
  try { await images.replaceImage(id, type, safeName, bytes, businessId); return { ...saved, hasImage: true }; }
  catch (error) { await Product.findByIdAndUpdate(id, { $set: old }); throw error; }
}
async function updateDetails(id, input, businessId = null) { return common.update('products', id, input, businessId); }
async function getImage(id, businessId = null) { assertDatabaseConnected(); return images.getProductImage(id, businessId); }
module.exports = { list: (query) => common.list('products', query), get: (id) => common.get('products', id), createWithImage: images.createWithImage, updateWithImage, updateDetails, getImage, remove: (id, options) => common.remove('products', id, null, options), deleteImpact: (id) => common.deleteImpact('products', id) };
