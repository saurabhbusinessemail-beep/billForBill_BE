'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const model = name => require('../src/DB/models/' + name);
const id = () => new mongoose.Types.ObjectId();
const query = rows => ({ select() { return this; }, lean() { return { then: (a,b) => Promise.resolve(rows).then(a,b), cursor: async function* () { yield* rows; } }; } });
const mainNames = ['CatalogProduct','ProductCategory','ProductAttribute','CatalogUnit','ProductImage','BusinessPaymentAllocation','BusinessPaymentJournal','BusinessPayment','BusinessDelivery','BusinessBillImage','BusinessOrderImage','BusinessBill','BusinessOrder','BusinessLead','BusinessInventoryMovement','BusinessProductPricing','BusinessCatalogProduct','BusinessCatalogCategory','BusinessCatalogAttribute','BusinessCatalogUnit'];

function fixture(t, businesses = [{ _id: id() }]) {
  t.mock.method(require('../src/DB/connection'), 'assertDatabaseConnected', () => {});
  const operations = [];
  for (const name of mainNames) t.mock.method(model(name), 'deleteMany', async filter => { operations.push({ name, filter }); return { deletedCount: 2 }; });
  t.mock.method(model('CatalogProduct'), 'distinct', async () => [id()]);
  t.mock.method(model('CatalogProduct'), 'exists', async () => null);
  t.mock.method(model('BusinessCatalogProduct'), 'exists', async () => null);
  t.mock.method(model('BusinessCatalogProduct'), 'find', () => query([]));
  for (const name of ['BusinessBillImage','BusinessOrderImage']) t.mock.method(model(name), 'distinct', async () => []);
  t.mock.method(model('BusinessType'), 'updateMany', async (filter, update) => { operations.push({ name:'BusinessTypeUpdate', filter, update }); return { modifiedCount:1 }; });
  t.mock.method(model('Business'), 'exists', async () => true);
  t.mock.method(model('Business'), 'updateOne', async (filter, update) => { operations.push({ name:'BusinessUpdate', filter, update }); });
  t.mock.method(model('Business'), 'find', () => query(businesses));
  const db = { collection: name => ({ find: filter => { operations.push({ name, filter }); return (async function* () {})(); } }) };
  const oldDb = mongoose.connection.db;
  mongoose.connection.db = db; t.after(() => { mongoose.connection.db = oldDb; });
  const Job = { modelName: 'BackgroundJob', exists: async () => null, find: () => query([]), deleteMany: async filter => { operations.push({ name:'BackgroundJob', filter }); return { deletedCount:1 }; } };
  const sessions = { modelName:'PricingImportSession', deleteMany: async filter => { operations.push({ name:'PricingImportSession', filter }); return { deletedCount:1 }; } };
  const connection = { db, models:{ PricingImportSession:sessions } };
  t.mock.method(require('../src/services/backgroundJobs.service'), 'connectJobsDatabase', async () => ({ Job, connection }));
  return { operations, businesses, Job, db };
}

test('admin cleanup clears shared catalogs and type product links, retaining images used by business copies', async t => {
  const f=fixture(t);
  t.mock.method(model('BusinessCatalogProduct'), 'exists', async () => true);
  const result=await require('../src/services/dataCleanup.service').cleanup('admin');
  assert.equal(result.scope,'admin');
  assert.deepEqual(f.operations.filter(o=>mainNames.includes(o.name)).map(o=>o.name),mainNames.slice(0,4));
  for(const op of f.operations.filter(o=>mainNames.includes(o.name))) assert.deepEqual(op.filter,{businessId:null});
  assert.deepEqual(f.operations.find(o=>o.name==='BusinessTypeUpdate').update.$set,{productIds:[]});
});

test('business cleanup scopes all deletions, attachments, jobs and sessions to requested business', async t => {
  const f=fixture(t);const businessId=String(f.businesses[0]._id);
  const result=await require('../src/services/dataCleanup.service').cleanup('business',businessId);
  assert.equal(result.completedBusinesses,1);
  for(const op of f.operations.filter(o=>mainNames.includes(o.name))) {
    assert.ok(op.name.startsWith('Business'));
    assert.equal(String(op.filter.businessId),businessId);
  }
  assert.ok(f.operations.some(o=>o.name==='BusinessPaymentAllocation'));
  assert.ok(f.operations.some(o=>o.name==='BusinessDelivery'));
  assert.equal(f.operations.find(o=>o.name==='BackgroundJob').filter.businessId,businessId);
  assert.equal(String(f.operations.find(o=>o.name==='PricingImportSession').filter.businessId),businessId);
  assert.ok(!f.operations.some(o=>o.name==='BusinessTypeUpdate'));
});

test('combined endpoint cleans every business then shared catalog', async t => {
  const f=fixture(t,[{_id:id()},{_id:id()}]);
  const result=await require('../src/services/dataCleanup.service').cleanup('all');
  assert.equal(result.completedBusinesses,2);
  assert.equal(f.operations.filter(o=>o.name==='BusinessLead').length,2);
  assert.equal(f.operations.filter(o=>o.name==='CatalogProduct').length,1);
  assert.ok(f.operations.findIndex(o=>o.name==='BusinessLead') < f.operations.findIndex(o=>o.name==='CatalogProduct'));
});

test('invalid/missing business and active pricing job are rejected before application deletes', async t => {
  const f=fixture(t);const service=require('../src/services/dataCleanup.service');
  await assert.rejects(service.cleanup('business','wrong'),{code:'INVALID_BUSINESS_ID'});
  t.mock.method(model('Business'),'exists',async()=>null);
  await assert.rejects(service.cleanup('business',String(id())),{code:'BUSINESS_NOT_FOUND'});
  t.mock.method(model('Business'),'exists',async()=>true);
  f.Job.exists=async()=>true;
  await assert.rejects(service.cleanup('business',String(id())),{code:'PRICING_JOB_IN_PROGRESS'});
  assert.equal(f.operations.length,0);
});

test('partial failures report deletion counts and release cleanup guard for retry', async t => {
  fixture(t);const service=require('../src/services/dataCleanup.service');
  t.mock.method(model('ProductCategory'),'deleteMany',async()=>{throw new Error('offline injected error');});
  await assert.rejects(service.cleanup('admin'),error=>error.code==='CLEANUP_INCOMPLETE' && error.details.deletedCounts.CatalogProduct===2);
  t.mock.method(model('ProductCategory'),'deleteMany',async()=>({deletedCount:0}));
  assert.equal((await service.cleanup('admin')).scope,'admin');
});

test('cleanup routes require session then persisted Super Admin; spoofed client role is denied', async t => {
  const router=require('../src/routers/dataCleanup.router');
  const {requireSession}=require('../src/middleware/requireSession');
  const {requireSuperAdmin}=require('../src/middleware/requireSuperAdmin');
  assert.equal(router.stack[0].handle,requireSession);
  assert.equal(router.stack[1].handle,requireSuperAdmin);
  assert.deepEqual(router.stack.slice(2).filter(layer=>layer.route.methods.delete).map(layer=>[layer.route.path,layer.route.methods.delete]),[['/admin-catalog',true],['/businesses/:businessId/data',true],['/all-data',true]]);
  let status;let next=false;const res={status(value){status=value;return this;},json(value){return value;}};
  await requireSession({headers:{}},res,()=>{next=true;});assert.equal(status,401);assert.equal(next,false);
  t.mock.method(model('User'),'exists',async filter=>{assert.equal(filter.isSuperAdmin,true);return null;});
  await requireSuperAdmin({authUserId:id(),body:{isSuperAdmin:true}},res,()=>{next=true;});assert.equal(status,403);assert.equal(next,false);
  t.mock.method(model('User'),'exists',async()=>true);
  await requireSuperAdmin({authUserId:id()},res,()=>{next=true;});assert.equal(next,true);
});


test('attachment cleanup removes chunks before file records with scoped file selection', async t => {
  const f=fixture(t);const fileId=id();const events=[];
  f.db.collection=name=>({
    find:filter=>{
      assert.ok(filter.$or.some(part=>part['metadata.businessId']===String(f.businesses[0]._id)));
      return (async function*(){if(name==='businessBillImages.files')yield {_id:fileId};})();
    },
    deleteMany:async filter=>{assert.equal(filter.files_id,fileId);events.push(name);return {deletedCount:3};},
    deleteOne:async filter=>{assert.equal(filter._id,fileId);events.push(name);return {deletedCount:1};},
  });
  const result=await require('../src/services/dataCleanup.service').cleanup('business',String(f.businesses[0]._id));
  assert.deepEqual(events,['businessBillImages.chunks','businessBillImages.files']);
  assert.equal(result.deletedCounts['businessBillImages.chunks'],3);
  assert.equal(result.deletedCounts['businessBillImages.files'],1);
});


test('Super Admin business list is paginated and treats search input as literal text', async t => {
  t.mock.method(require('../src/DB/connection'),'assertDatabaseConnected',()=>{});
  const businessId=id();let filterSeen;
  t.mock.method(model('Business'),'find',filter=>{
    filterSeen=filter;
    return { select(value){assert.equal(value,'legalName phone');return this;},sort(){return this;},skip(value){assert.equal(value,25);return this;},limit(value){assert.equal(value,25);return this;},lean:async()=>[{_id:businessId,legalName:'Shop (A)',phone:'123'}] };
  });
  t.mock.method(model('Business'),'countDocuments',async()=>26);
  const service=require('../src/services/dataCleanup.service');
  const result=await service.listBusinesses({page:'2',q:'Shop (A)'});
  assert.equal(result.totalPages,2);assert.equal(result.items[0].id,String(businessId));
  assert.equal(filterSeen.legalName.test('Shop (A)'),true);
  assert.equal(filterSeen.legalName.test('Shop A'),false);
  await assert.rejects(service.listBusinesses({page:0}),{code:'INVALID_PAGE'});
});


test('cleanup business list includes businesses owned by different users and ignores owner filters', async t => {
  t.mock.method(require('../src/DB/connection'),'assertDatabaseConnected',()=>{});
  const rows=[{_id:id(),ownerUserId:id(),legalName:'Owner one shop'},{_id:id(),ownerUserId:id(),legalName:'Owner two shop'}];
  t.mock.method(model('Business'),'find',filter=>{
    assert.deepEqual(filter,{});
    return {select(){return this;},sort(){return this;},skip(){return this;},limit(){return this;},lean:async()=>rows};
  });
  t.mock.method(model('Business'),'countDocuments',async filter=>{assert.deepEqual(filter,{});return rows.length;});
  const result=await require('../src/services/dataCleanup.service').listBusinesses({ownerUserId:String(rows[0].ownerUserId)});
  assert.equal(result.total,2);
  assert.deepEqual(result.items.map(row=>row.id),rows.map(row=>String(row._id)));
});
