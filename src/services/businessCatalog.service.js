'use strict';
const common = require('./adminSetup/catalogCommon.service');
const products = require('./adminSetup/products.service');
const { access } = require('./businessPeopleTeams.service');
const Business = require('../DB/models/Business');
const Product = require('../DB/models/BusinessCatalogProduct');
const Category = require('../DB/models/BusinessCatalogCategory');
const Attribute = require('../DB/models/BusinessCatalogAttribute');
const Unit = require('../DB/models/BusinessCatalogUnit');
const Tax = require('../DB/models/BusinessCatalogTax');
const ProductPricing = require('../DB/models/BusinessProductPricing');
const keys = { products: 'products', categories: 'categories', attributes: 'attributes', units: 'units', taxes: 'taxes' };
const models = { products: Product, categories: Category, attributes: Attribute, units: Unit, taxes: Tax };
const manageKey = (kind) => `business.catalog.${keys[kind]}.manage`;
async function authorize(businessId, userId, kind, mutate = false) {
  const allowed = await access(businessId, userId, mutate ? manageKey(kind) : 'business.catalog.view');
  if (allowed.business.catalogCopyState === 'pending') throw common.error(409, 'CATALOG_COPY_PENDING', 'The business catalog is being prepared. Try again shortly.');
  return allowed;
}
async function authorization(businessId, userId) { const value = await access(businessId, userId); return { isOwner: value.owner, permissionKeys: [...value.keys] }; }
async function list(bid, uid, kind, query) { await authorize(bid, uid, kind); return common.list(kind, query, bid); }
async function get(bid, uid, kind, id) { await authorize(bid, uid, kind); return common.get(kind, id, bid); }
async function create(bid, uid, kind, body) { await authorize(bid, uid, kind, true); return common.create(kind, body, bid); }
function rejectImageMutation(body, hasImageBytes = false) {
  const imageFields = ['image', 'imageId', 'imageData', 'imageBytes', 'imageRef', 'imageUrl', 'productImage', 'removeImage', 'hasImage'];
  if (hasImageBytes || imageFields.some((field) => Object.hasOwn(body || {}, field))) {
    throw common.error(403, 'BUSINESS_PRODUCT_IMAGE_IMMUTABLE', 'Product images cannot be changed from a business catalog.');
  }
}
async function createProduct(bid, uid, body, type, name, bytes) { await authorize(bid, uid, 'products', true); rejectImageMutation(body, Boolean(type || name || (Buffer.isBuffer(bytes) && bytes.length))); return common.create('products', body, bid); }
async function update(bid, uid, kind, id, body) { await authorize(bid, uid, kind, true); return common.update(kind, id, body, bid); }
async function updateProduct(bid, uid, id, body, type, name, bytes) {
  await authorize(bid, uid, 'products', true);
  rejectImageMutation(body, Boolean(type || name || (Buffer.isBuffer(bytes) && bytes.length)));
  if (!await Product.exists({ _id: id, businessId: bid })) throw common.error(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item not found.');
  return type ? products.updateWithImage(id, body, type, name, bytes, bid) : products.updateDetails(id, body, bid);
}
async function remove(bid, uid, kind, id) {
  await authorize(bid, uid, kind, true);
  if (kind !== 'products') return common.remove(kind, id, bid);
  const pricing = await ProductPricing.findOne({ businessId: bid, productId: id }).lean();
  if (!pricing) return common.remove(kind, id, bid);
  await ProductPricing.deleteOne({ _id: pricing._id });
  try { return await common.remove(kind, id, bid); }
  catch (error) { await ProductPricing.replaceOne({ _id: pricing._id }, pricing, { upsert: true }); throw error; }
}
async function impact(bid, uid, kind, id) { await authorize(bid, uid, kind); return common.deleteImpact(kind, id, bid); }
async function counts(bid, uid) {
  await authorize(bid, uid);
  const entries = await Promise.all(Object.entries(models).map(async ([kind, Model]) => [kind, await Model.countDocuments({ businessId: bid })]));
  return Object.fromEntries(entries);
}
module.exports = { authorize, authorization, list, get, create, createProduct, update, updateProduct, remove, impact, counts, rejectImageMutation };
