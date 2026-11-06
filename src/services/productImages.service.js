'use strict';

const mongoose = require('mongoose');
const CatalogProduct = require('../DB/models/CatalogProduct');
const User = require('../DB/models/User');
const BusinessCatalogProduct = require('../DB/models/BusinessCatalogProduct');
const businessCatalog = require('./businessCatalog.service');
const images = require('./adminSetup/productImages.service');
const { assertDatabaseConnected } = require('../DB/connection');
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });

async function getForProduct(userId, imageId, businessId = null) {
  assertDatabaseConnected();
  if (!mongoose.isValidObjectId(imageId)) throw fail(404, 'CATALOG_ITEM_NOT_FOUND', 'Product image not found.');

  if (businessId) {
    await businessCatalog.authorize(businessId, userId, 'products');
    const businessProduct = await BusinessCatalogProduct.findOne({ businessId, $or: [{ _id: imageId }, { sourceProductId: imageId }] }).select('_id').lean();
    if (!businessProduct) throw fail(404, 'CATALOG_ITEM_NOT_FOUND', 'Product image not found.');
    return images.getProductImage(String(businessProduct._id), String(businessId));
  }

  if (!await User.exists({ _id: userId, isAdmin: true })) throw fail(403, 'ADMIN_REQUIRED', 'Administrator access is required.');

  if (!await CatalogProduct.exists({ _id: imageId, businessId: null })) throw fail(404, 'CATALOG_ITEM_NOT_FOUND', 'Product image not found.');
  return images.getImage(imageId);
}

module.exports = { getForProduct };
