'use strict';
const { assertDatabaseConnected } = require('../../DB/connection');
const ProductImage = require('../../DB/models/ProductImage');
const common = require('./catalogCommon.service');
const fail = common.error;

function validateImage(type, name, bytes) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw fail(415, 'UNSUPPORTED_PRODUCT_IMAGE', 'Choose a JPEG, PNG, or WebP image.');
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw fail(400, 'EMPTY_PRODUCT_IMAGE', 'Choose a product image.');
  if (bytes.length > 512000) throw fail(413, 'PRODUCT_IMAGE_TOO_LARGE', 'Product images must be 500 KiB or smaller.');
  const matches = type === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : type === 'image/png' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!matches) throw fail(415, 'INVALID_PRODUCT_IMAGE_CONTENT', 'The image content does not match its file type.');
  const safeName = typeof name === 'string' ? name.replace(/[\\/\0-\x1f]/g, '').slice(0, 255) : '';
  return safeName || 'product-image';
}

async function createWithImage(input, type, name, bytes, businessId = null) {
  assertDatabaseConnected(); const safeName = validateImage(type, name, bytes);
  const Product = common.modelFor('products', businessId);
  const values = common.normalize('products', input); await common.validateRefs('products', values, businessId);
  await common.assertProductNameUnique({ ...values, categoryIds: values.categoryIds || [] }, null, businessId);
  let product;
  try { product = await Product.create({ ...values, businessId: businessId || null }); }
  catch (error) { if (error.code === 11000) throw fail(409, 'PRODUCT_NAME_EXISTS', 'A product with this name already exists.'); throw error; }
  try {
    await ProductImage.create({ productId: product._id, originalName: safeName, contentType: type, sizeBytes: bytes.length, data: bytes });
    return common.present('products', product);
  } catch (error) { await Promise.all([Product.deleteOne({ _id: product._id }), ProductImage.deleteOne({ productId: product._id })]); throw error; }
}

async function replaceImage(productId, type, name, bytes, businessId = null) {
  assertDatabaseConnected(); const safeName = validateImage(type, name, bytes);
  const Product = common.modelFor('products', businessId);
  if (!(await Product.exists({ _id: productId }))) throw fail(404, 'CATALOG_ITEM_NOT_FOUND', 'Product not found.');
  const image = await ProductImage.findOneAndUpdate({ productId }, { $set: { originalName: safeName, contentType: type, sizeBytes: bytes.length, data: bytes } }, { new: true, upsert: true, runValidators: true }).select('-data');
  return { productId: String(image.productId), sizeBytes: image.sizeBytes, contentType: image.contentType };
}

async function getImage(productId) {
  // Keep this as a hydrated Mongoose document so the Buffer field is cast to
  // a Node Buffer before the controller passes it to Express res.send(). A
  // lean result may expose the underlying BSON Binary wrapper instead.
  assertDatabaseConnected(); const image = await ProductImage.findOne({ productId }).select('+data');
  if (!image) throw fail(404, 'PRODUCT_IMAGE_NOT_FOUND', 'Product image not found.');
  return image;
}

async function getProductImage(productId, businessId = null) {
  assertDatabaseConnected();
  if (!businessId) return getImage(productId);
  const BusinessProduct = require('../../DB/models/BusinessCatalogProduct');
  const product = await BusinessProduct.findOne({ _id: productId, businessId }).select('sourceProductId').lean();
  if (!product) throw fail(404, 'CATALOG_ITEM_NOT_FOUND', 'Product not found.');
  const ownImage = await ProductImage.findOne({ productId }).select('+data');
  if (ownImage) return ownImage;
  if (product.sourceProductId) return getImage(product.sourceProductId);
  throw fail(404, 'PRODUCT_IMAGE_NOT_FOUND', 'Product image not found.');
}

module.exports = { validateImage, createWithImage, replaceImage, getImage, getProductImage };
