'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const copy = require('../src/services/businessCatalogCopy.service');
const model = name => require('../src/DB/models/' + name);
const id = () => new mongoose.Types.ObjectId();
const query = rows => ({ lean: async () => rows, select() { return this; } });

test('incremental push inserts missing product and references, preserves copies on retry', async t => {
  const business = { _id: id(), businessTypeId: id() };
  const source = { _id: id(), businessId: null, name: 'New product', normalizedName: 'new product', type: 'Physical', createdAt: new Date(), updatedAt: new Date(), needsUnit: true, categoryIds: [], attributeIds: [], taxComponentIds: [] };
  let saved = []; const writes = [];
  t.mock.method(model('BusinessType'), 'findOne', () => query({ _id: business.businessTypeId, productIds: [source._id], taxComponentIds: [] }));
  t.mock.method(model('CatalogProduct'), 'find', () => query([source]));
  for (const name of ['TaxComponent', 'ProductCategory', 'ProductAttribute', 'CatalogUnit']) t.mock.method(model(name), 'find', () => query([]));
  t.mock.method(model('ProductImage'), 'find', () => query([{ productId: source._id }]));
  t.mock.method(model('BusinessMutationLock'), 'findOneAndUpdate', async (filter, update) => ({ lockId: update.$set.lockId }));
  t.mock.method(model('BusinessMutationLock'), 'deleteOne', async () => ({}));
  t.mock.method(model('BusinessCatalogProduct'), 'find', filter => query(filter.sourceProductId ? saved : saved));
  t.mock.method(model('BusinessCatalogProduct').collection, 'bulkWrite', async operations => {
    for (const op of operations) {
      const insert = op.updateOne.update.$setOnInsert;
      const set = op.updateOne.update.$set || {};
      assert.ok(!Object.keys(set).some(key => Object.hasOwn(insert, key)), 'MongoDB rejects overlapping update paths');
      assert.ok(!Object.hasOwn(set, 'updatedAt'), 'insert-only push must preserve existing timestamps');
    }
    writes.push(...operations);
    saved = operations.map(op => op.updateOne.update.$setOnInsert);
  });
  await copy.copyBusinessTypeCatalog(business, { additionsOnly: true, productIds: [source._id] });
  assert.equal(writes.length, 1);
  assert.equal(String(saved[0].sourceProductId), String(source._id));
  assert.equal(String(saved[0].businessId), String(business._id));
  saved[0].name = 'Business customization';
  await copy.copyBusinessTypeCatalog(business, { additionsOnly: true, productIds: [source._id] });
  assert.equal(writes.length, 1);
  assert.equal(saved[0].name, 'Business customization');
});

test('push targets every matching business and reports failure after trying remaining businesses', async t => {
  const typeId = id(); const businesses = [1, 2, 3].map(() => ({ _id: id(), businessTypeId: typeId }));
  t.mock.method(model('Business'), 'find', filter => {
    assert.equal(filter.businessTypeId, typeId);
    return { lean: () => ({ cursor: async function* () { yield* businesses; } }) };
  });
  const attempted = [];
  t.mock.method(model('BusinessMutationLock'), 'findOneAndUpdate', async (filter, update) => {
    attempted.push(String(filter.businessId));
    if (attempted.length === 1) throw new Error('write unavailable');
    return { lockId: update.$set.lockId };
  });
  t.mock.method(model('BusinessMutationLock'), 'deleteOne', async () => ({}));
  t.mock.method(model('BusinessType'), 'findOne', () => query({ _id: typeId, productIds: [] }));
  t.mock.method(model('CatalogProduct'), 'find', () => query([]));
  t.mock.method(model('BusinessCatalogProduct'), 'find', () => query([]));
  await assert.rejects(copy.pushBusinessTypeProducts(typeId, []), { code: 'BUSINESS_CATALOG_PUSH_INCOMPLETE' });
  assert.deepEqual(attempted, businesses.map(b => String(b._id)));
});
