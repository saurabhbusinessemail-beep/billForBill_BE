'use strict';
const mongoose = require('mongoose');
const Delivery = require('../DB/models/BusinessDelivery');
const Business = require('../DB/models/Business');
const Order = require('../DB/models/BusinessOrder');
const Bill = require('../DB/models/BusinessBill');
const User = require('../DB/models/User');
const DeliveryCounter = require('../DB/models/BusinessDeliveryCounter');
const NumberConfig = require('../DB/models/BusinessDocumentNumberConfig');
const TransportConfig = require('../DB/models/BusinessTransportConfig');
const { access } = require('./businessPeopleTeams.service');
const { normalizePhone } = require('../utils/phone');
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code, expose: statusCode < 500 });
const id = value => mongoose.isValidObjectId(value);
const TRANSPORT_FIELDS = { inPerson:['carriedBy','phone','notes'], bikeScooter:['vehicleNumber','riderName','riderPhone'], autoTempo:['vehicleNumber','driverName','driverPhone'], car:['vehicleNumber','driverName','driverPhone'], truck:['vehicleNumber','driverName','driverPhone','lrBiltyNumber','ewayBillNumber'], bus:['busOperator','busNumber','ticketReceiptNumber','departure','conductorDriverPhone'], train:['trainNumber','trainName','pnr','coachParcelVan','railwayReceiptNumber','departure'], flight:['airline','flightNumber','pnr','airWaybillNumber','departure'], courier:['courierPartner','trackingAwbNumber','trackingLink','expectedDelivery'], shipCargo:['vesselName','containerNumber','billOfLadingNumber','portOfLoading'], other:['describeTransport','referenceNumber'], handedToCustomer:['receivedBy','receiverPhone','deliveryOtpCode','notes'] };
async function authorize(bid, uid) { return access(bid, uid, 'business.transport.manage'); }
function clean(body = {}) {
  if (!['order','party'].includes(body.sourceType)) throw fail(400,'INVALID_DELIVERY','Choose an order or party.'); const sourceType = body.sourceType;
  const transportType = String(body.transportType || '').trim();
  if (!Object.hasOwn(TRANSPORT_FIELDS,transportType)) throw fail(400, 'INVALID_DELIVERY', 'Choose a valid transport type.');
  const text = (v, max) => String(v || '').trim().slice(0, max);
  const deliveryDate=String(body.deliveryDate||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)||Number.isNaN(Date.parse(`${deliveryDate}T00:00:00Z`))||new Date(`${deliveryDate}T00:00:00Z`).toISOString().slice(0,10)!==deliveryDate)throw fail(400,'INVALID_DELIVERY_DATE','Choose a valid delivery date.');
  return { sourceType, orderId: body.orderId && id(body.orderId) ? body.orderId : null, partyUserId: body.partyUserId && id(body.partyUserId) ? body.partyUserId : null, partyName: text(body.partyName, 120), partyPhone: text(body.partyPhone, 40), deliveryDate, fromAddress: text(body.fromAddress, 1000), toAddress: text(body.toAddress, 1000), transportType, transportDetails: body.transportDetails && typeof body.transportDetails === 'object' && !Array.isArray(body.transportDetails) ? Object.fromEntries(Object.entries(body.transportDetails).filter(([k])=>TRANSPORT_FIELDS[transportType].includes(k)).map(([k,v]) => [k, String(v).slice(0,300)])) : {} };
}
async function validateRequiredFields(bid,type,details){const config=await TransportConfig.findOne({businessId:bid}).select('fields').lean();const required=config?.fields?.[type]||{};for(const field of TRANSPORT_FIELDS[type]||[])if(required[field]&&!String(details?.[field]||'').trim())throw fail(400,'TRANSPORT_DETAIL_REQUIRED',`Enter ${field}.`);}
function view(row) { const value = row.toObject ? row.toObject() : row; return { ...value, id: String(value._id), businessId: String(value.businessId), orderId: value.orderId ? String(value.orderId) : null, partyUserId: value.partyUserId ? String(value.partyUserId) : null }; }
async function nextDeliveryNumber(bid) { try { return (await DeliveryCounter.findOneAndUpdate({businessId:bid},{$inc:{value:1}},{new:true,upsert:true,setDefaultsOnInsert:true})).value; } catch(error) { if(error.code!==11000) throw error; return (await DeliveryCounter.findOneAndUpdate({businessId:bid},{$inc:{value:1}},{new:true})).value; } }
async function configuredDeliveryPrefix(bid) { const config=await NumberConfig.findOne({businessId:bid}).select('deliveryPrefix').lean(); return config?.deliveryPrefix||'DLV'; }
async function createDraftFromBill(bill, uid) { const existing=await Delivery.findOne({businessId:bill.businessId,billId:bill._id,status:{$ne:'cancelled'}}); if(existing)return view(existing); const [business,party]=await Promise.all([Business.findById(bill.businessId).select('address').lean(),bill.partyUserId?User.findById(bill.partyUserId).select('addresses').lean():null]); const address=party?.addresses?.[0]; const [value,prefix]=await Promise.all([nextDeliveryNumber(bill.businessId),configuredDeliveryPrefix(bill.businessId)]); return view(await Delivery.create({businessId:bill.businessId,deliveryNumber:`${prefix}-${value}`,status:'draft',sourceType:bill.orderId?'order':'party',orderId:bill.orderId,billId:bill._id,partyUserId:bill.partyUserId,partyName:bill.partySnapshot?.name||'',partyPhone:bill.partySnapshot?.phone||'',deliveryDate:new Date().toISOString().slice(0,10),fromAddress:business?.address||'',toAddress:bill.partySnapshot?.address|| (address?[address.line1,address.line2,address.city,address.state,address.pincode,address.country].filter(Boolean).join(', '):''),transportType:'',transportDetails:{},events:[{status:'draft',at:new Date(),actorUserId:uid}],createdByUserId:uid,updatedByUserId:uid})); }
async function list(bid, uid, query) {
  await authorize(bid, uid);
  const filter = { businessId: bid };
  if (['draft','on_move','delivered','cancelled'].includes(String(query.status))) filter.status = query.status;
  const search = String(query.search || '').trim().slice(0,100);
  if (search) {
    const expression = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ deliveryNumber: expression }, { partyName: expression }, { partyPhone: expression }];
  }
  const rows = await Delivery.find(filter).sort({ updatedAt: -1 }).limit(250).lean();
  const orderIds = [...new Set(rows.map(row => String(row.orderId || '')).filter(Boolean))];
  const orderRows = orderIds.length ? await Order.find({ _id: { $in: orderIds }, businessId: bid }).select('orderNumber').lean() : [];
  const orderNumbers = new Map(orderRows.map(row => [String(row._id), row.orderNumber || '']));
  const permission = await access(bid, uid);
  return {
    items: rows.map(row => ({ ...view(row), orderNumber: orderNumbers.get(String(row.orderId || '')) || '' })),
    authorization: { isOwner: permission.owner, permissionKeys: [...permission.keys], canEditDate: permission.owner || permission.keys.has('business.deliveries.date.manage') },
  };
}
async function get(bid, uid, did) { await authorize(bid, uid); if (!id(did)) throw fail(404,'DELIVERY_NOT_FOUND','Delivery not found.'); const row = await Delivery.findOne({ _id: did, businessId: bid }); if (!row) throw fail(404,'DELIVERY_NOT_FOUND','Delivery not found.'); return view(row); }
async function eligibleOrders(bid, uid, deliveryId) {
  await authorize(bid, uid);
  const selectedDelivery = deliveryId && id(deliveryId)
    ? await Delivery.findOne({ _id: deliveryId, businessId: bid }).select('orderId').lean()
    : null;
  const selectedOrderId = selectedDelivery?.orderId || null;
  const [billOrderIds, business, activeDeliveries] = await Promise.all([
    Bill.distinct('orderId', { businessId: bid, status: 'issued', deliveryStatus: 'in_transit', deletedAt: null, orderId: { $ne: null } }),
    Business.findById(bid).select('legalName phone address').lean(),
    Delivery.find({ businessId: bid, status: { $ne: 'cancelled' }, orderId: { $ne: null } }).select('orderId status').lean(),
  ]);
  const deliveryByOrder = new Map(activeDeliveries.map(row => [String(row.orderId), row]));
  const eligibleIds = billOrderIds.filter(orderId => {
    const existing = deliveryByOrder.get(String(orderId));
    return !existing || existing.status === 'draft' || String(orderId) === String(selectedOrderId || '');
  });
  const rows = eligibleIds.length
    ? await Order.find({ _id: { $in: eligibleIds }, businessId: bid, status: { $nin: ['cancelled','delivered','completed_billed'] }, deletedAt: null }).sort({ createdAt: -1 }).limit(250).select('orderNumber status contactUserId contactSnapshot').lean()
    : [];
  if (selectedOrderId && !rows.some(row => String(row._id) === String(selectedOrderId))) {
    const selectedOrder = await Order.findOne({ _id: selectedOrderId, businessId: bid }).select('orderNumber status contactUserId contactSnapshot').lean();
    if (selectedOrder) rows.push(selectedOrder);
  }
  return {
    items: rows.map(row => ({
      id: String(row._id), orderNumber: row.orderNumber, status: row.status,
      deliveryId: deliveryByOrder.get(String(row._id))?.status === 'draft' ? String(deliveryByOrder.get(String(row._id))._id) : null,
      partyUserId: row.contactUserId ? String(row.contactUserId) : null,
      partyName: row.contactSnapshot?.name || '', partyPhone: row.contactSnapshot?.phone || '',
    })),
    businessAddress: business?.address || '', business: { name: business?.legalName || '', phone: business?.phone || '' },
  };
}
async function parties(bid, uid, search) { await authorize(bid, uid); const term = String(search || '').trim().slice(0,80); if (term.length < 2) return []; const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),'i'); const bills = await Bill.find({ businessId: bid, status: { $ne: 'cancelled' }, $or: [{ 'partySnapshot.name': re }, { 'partySnapshot.phone': re }] }).select('partyUserId partySnapshot').sort({ createdAt: -1 }).limit(100).lean(); const seen = new Set(); return bills.filter(row => { const key = String(row.partyUserId || row.partySnapshot?.phone || row.partySnapshot?.name); if (seen.has(key)) return false; seen.add(key); return true; }).map(row => ({ id: row.partyUserId ? String(row.partyUserId) : null, name: row.partySnapshot?.name || '', phone: row.partySnapshot?.phone || '' })); }
function partyAddressView(address,index){return {id:String(address._id),label:address.label,contactName:address.contactName,phone:address.phone,line1:address.line1,line2:address.line2||'',city:address.city,state:address.state,pincode:address.pincode,country:address.country,isDefault:index===0,formatted:[address.line1,address.line2,address.city,address.state,address.pincode,address.country].filter(Boolean).join(', ') };}
async function partyAddresses(bid, uid, partyId) { await authorize(bid, uid); if(!id(partyId)) return []; const user=await User.findById(partyId).select('addresses').lean(); return (user?.addresses||[]).map(partyAddressView); }
async function addPartyAddress(bid,uid,partyId,body={}){await authorize(bid,uid);if(!id(partyId))throw fail(404,'PARTY_NOT_FOUND','Party not found.');const user=await User.findById(partyId);if(!user)throw fail(404,'PARTY_NOT_FOUND','Party not found.');const related=await Bill.exists({businessId:bid,status:{$ne:'cancelled'},deletedAt:null,$or:[{partyUserId:user._id},{'partySnapshot.phone':user.phoneE164}]});if(!related)throw fail(404,'PARTY_NOT_FOUND','Party not found.');const fields=['contactName','phone','line1','line2','city','state','pincode','country'];const limits={contactName:120,phone:30,line1:200,line2:200,city:100,state:100,pincode:20,country:100};const address={label:'other'};for(const field of fields){if(typeof body[field]!=='string')throw fail(422,'INVALID_PARTY_ADDRESS','Complete all required address fields.');const value=body[field].trim();if(value.length>limits[field]||(field!=='line2'&&!value))throw fail(422,'INVALID_PARTY_ADDRESS','Check the address fields and try again.');address[field]=value;}let entry=user.addresses.find(item=>fields.every(field=>String(item[field]||'').trim()===address[field]));if(!entry){user.addresses.push(address);await user.save();entry=user.addresses[user.addresses.length-1];}return partyAddressView(entry,user.addresses.findIndex(item=>String(item._id)===String(entry._id)));}
async function searchUsers(bid,uid,search){await authorize(bid,uid);const term=String(search||'').trim().slice(0,80);if(term.length<2)return [];const re=new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');const rows=await User.find({$or:[{displayName:re},{phoneE164:re}]}).select('displayName phoneE164 addresses').limit(30).lean();return rows.map(user=>({id:String(user._id),name:user.displayName||'',phone:user.phoneE164,addressCount:(user.addresses||[]).length}));}
async function createUser(bid,uid,body){await authorize(bid,uid);const name=String(body.name||'').trim().slice(0,120);const phoneE164=normalizePhone(String(body.countryCallingCode||''),String(body.phoneNumber||''));if(!name)throw fail(400,'NAME_REQUIRED','Enter the person name.');if(!phoneE164)throw fail(400,'INVALID_PHONE','Enter a valid country code and phone number.');let user=await User.findOne({phoneE164});if(!user){try{user=await User.create({phoneE164,displayName:name,accountStatus:'provisioned'});}catch(error){if(error.code!==11000)throw error;user=await User.findOne({phoneE164});}}return {id:String(user._id),name:user.displayName||name,phone:user.phoneE164,addressCount:(user.addresses||[]).length};}
async function create(bid, uid, body) { await authorize(bid, uid); const value = clean(body); const permission=await access(bid,uid); const today=new Date().toISOString().slice(0,10); if(!(permission.owner||permission.keys.has('business.deliveries.date.manage'))&&value.deliveryDate!==today)throw fail(403,'DELIVERY_DATE_PERMISSION_REQUIRED','Only the owner or a permitted user can set another delivery date.'); const business = await Business.findById(bid).select('ownerUserId address').lean(); if (!business) throw fail(404,'BUSINESS_NOT_FOUND','Business not found.'); if (value.sourceType === 'order') { if (!value.orderId) throw fail(400,'ORDER_REQUIRED','Choose an order.'); const order = await Order.findOne({ _id: value.orderId, businessId: bid, status: { $nin: ['cancelled','delivered','completed_billed'] } }).select('contactUserId contactSnapshot').lean(); if (!order) throw fail(400,'ORDER_INELIGIBLE','Choose an eligible order.'); value.partyUserId = order.contactUserId; value.partyName = order.contactSnapshot?.name || ''; value.partyPhone = order.contactSnapshot?.phone || ''; }
  else { if(!value.partyName||!value.partyPhone)throw fail(400,'PARTY_REQUIRED','Choose an existing party.'); const clauses=[{'partySnapshot.phone':value.partyPhone}];if(value.partyUserId)clauses.push({partyUserId:value.partyUserId});const partyBill=await Bill.exists({businessId:bid,status:{$ne:'cancelled'},$or:clauses});if(!partyBill)throw fail(400,'PARTY_INELIGIBLE','Choose a party with a bill in this business.'); }
  if(!value.fromAddress||!value.toAddress)throw fail(400,'ADDRESS_REQUIRED','Enter both route addresses.'); await validateRequiredFields(bid,value.transportType,value.transportDetails);
  const billFilter = value.orderId ? { businessId: bid, orderId: value.orderId, status: 'issued', deliveryStatus: 'in_transit', deletedAt: null } : { businessId: bid, ...(value.partyUserId?{partyUserId:value.partyUserId}:{'partySnapshot.phone':value.partyPhone}), status: 'issued', deliveryStatus: 'in_transit', deletedAt: null };
  const bill = await Bill.findOne(billFilter).sort({ createdAt: -1 }).select('_id').lean(); if(!bill)throw fail(400,'BILL_REQUIRED','A delivery can only be created for an issued bill in transit.'); value.billId = bill._id; const existingDelivery=await Delivery.exists({businessId:bid,billId:bill._id,status:{$ne:'cancelled'}});if(existingDelivery)throw fail(409,'DELIVERY_ALREADY_EXISTS','This bill already has an active delivery. Open it from the Transport list.');
  if (value.partyUserId) { const party = await User.findById(value.partyUserId).select('addresses').lean(); const address = party?.addresses?.[0]; if (!value.toAddress && address) value.toAddress = [address.line1,address.line2,address.city,address.state,address.pincode,address.country].filter(Boolean).join(', '); }
  const [number,prefix]=await Promise.all([nextDeliveryNumber(bid),configuredDeliveryPrefix(bid)]); const row = await Delivery.create({ businessId: bid, deliveryNumber: `${prefix}-${number}`, ...value, fromAddress: value.fromAddress || business.address || '', status: 'draft', createdByUserId: uid, updatedByUserId: uid, events: [{ status: 'draft', at: new Date(), actorUserId: uid }] }); return view(row); }
async function update(bid, uid, did, body) { await authorize(bid, uid); const row = await Delivery.findOne({ _id: did, businessId: bid }); if (!row) throw fail(404,'DELIVERY_NOT_FOUND','Delivery not found.'); if (row.status !== 'draft') throw fail(409,'DELIVERY_NOT_EDITABLE','Only draft deliveries can be edited.'); const value=clean(body); if(!value.fromAddress||!value.toAddress)throw fail(400,'ADDRESS_REQUIRED','Enter both route addresses.'); const permission=await access(bid,uid); const canEditDate=permission.owner||permission.keys.has('business.deliveries.date.manage'); if(!canEditDate)value.deliveryDate=row.deliveryDate; await validateRequiredFields(bid,value.transportType,value.transportDetails); Object.assign(row, value, { updatedByUserId: uid }); await row.save(); return view(row); }
async function action(bid, uid, did, body) {
  await authorize(bid, uid);
  const row = await Delivery.findOne({ _id: did, businessId: bid });
  if (!row) throw fail(404,'DELIVERY_NOT_FOUND','Delivery not found.');
  const at = new Date();
  if (body.action === 'start' && row.status === 'draft') {
    if (row.billId) await require('./businessBillsPayments.service').recordDeliveryStarted(bid,uid,String(row.billId),String(row._id),at);
    row.status = 'on_move';
    row.events.push({ status:'on_move', at, actorUserId:uid });
  } else if (body.action === 'cancel' && !['cancelled','delivered'].includes(row.status)) {
    row.status = 'cancelled';
    row.events.push({ status:'cancelled', at, actorUserId:uid });
  } else if (body.action === 'hand_to_customer' && row.status === 'on_move') {
    const type = 'handedToCustomer';
    const details = Object.fromEntries(Object.entries(body.transportDetails && typeof body.transportDetails === 'object' ? body.transportDetails : {}).filter(([key]) => TRANSPORT_FIELDS[type].includes(key)).map(([key,value])=>[key,String(value).slice(0,300)]));
    if (!details.receivedBy?.trim()) throw fail(400,'TRANSPORT_DETAIL_REQUIRED','Enter who received the delivery.');
    await validateRequiredFields(bid,type,details);
    if (row.billId) {
      const bill = await Bill.findOne({ _id:row.billId,businessId:bid,status:'issued',deliveryStatus:'in_transit' }).lean();
      if (bill) await require('./businessBillsPayments.service').changeDelivery(bid,uid,String(row.billId),{ deliveryStatus:bill.billType==='purchase'?'received':'delivered', deliveryCompletion:true });
    }
    row.legs.push({ from:row.fromAddress,to:row.toAddress,transportType:row.transportType,details:row.transportDetails,action:'handed_to_customer',receiverDetails:details,at });
    row.transportType = type;
    row.transportDetails = details;
    row.status = 'delivered';
    row.completedAt = at;
    row.events.push({ status:'delivered', action:'handed_to_customer', receiverDetails:details, at, actorUserId:uid });
  } else if (body.action === 'handover' && row.status === 'on_move') {
    const point=String(body.address||'').trim().slice(0,1000); const type=String(body.transportType||'').trim().slice(0,40);
    if(!point||!Object.hasOwn(TRANSPORT_FIELDS,type))throw fail(400,'HANDOVER_REQUIRED','Enter a handover address and select next transport.');
    const details=Object.fromEntries(Object.entries(body.transportDetails&&typeof body.transportDetails==='object'?body.transportDetails:{}).filter(([key])=>TRANSPORT_FIELDS[type].includes(key)));
    await validateRequiredFields(bid,type,details);
    const handoverPartyId=body.partyUserId&&id(body.partyUserId)?body.partyUserId:null; const partyName=String(body.partyName||'').trim().slice(0,120); const partyPhone=String(body.partyPhone||'').trim().slice(0,40);
    row.legs.push({ from:row.fromAddress,to:point,transportType:row.transportType,details:row.transportDetails,partyUserId:handoverPartyId,partyName,partyPhone,at });
    row.fromAddress=point; row.transportType=type; row.transportDetails=details;
    row.events.push({status:'on_move',action:'handover',address:point,partyUserId:handoverPartyId,partyName,partyPhone,at,actorUserId:uid});
  } else throw fail(409,'INVALID_DELIVERY_TRANSITION','This delivery cannot make that status change.');
  row.updatedByUserId=uid;
  await row.save();
  return view(row);
}
async function completeForBill(bid, uid, billId, source = 'Bill', orderId = null) {
  const row = await Delivery.findOne({ businessId: bid, status: { $ne: 'delivered' }, $or: [{ billId }, ...(orderId ? [{ orderId }] : [])] }).sort({ updatedAt: -1 });
  if (!row) return null;
  const at = new Date();
  const sourceLabel = String(source || 'Bill').trim().slice(0, 80) || 'Bill';
  const details = { receivedBy: `Marked delivered from ${sourceLabel}`, receiverPhone: '0000000000', deliveryOtpCode: 'Not collected', notes: `Automatically completed from ${sourceLabel} action.` };
  await validateRequiredFields(bid, 'handedToCustomer', details);
  if (row.status === 'draft') {
    row.events.push({ status: 'on_move', at, actorUserId: uid });
    row.status = 'on_move';
  }
  row.legs.push({ from: row.fromAddress, to: row.toAddress, transportType: row.transportType, details: row.transportDetails, action: 'handed_to_customer', receiverDetails: details, at });
  row.transportType = 'handedToCustomer';
  row.transportDetails = details;
  row.status = 'delivered';
  row.completedAt = at;
  row.updatedByUserId = uid;
  row.events.push({ status: 'delivered', action: 'handed_to_customer', receiverDetails: details, source: sourceLabel, at, actorUserId: uid });
  await row.save();
  return view(row);
}
module.exports = { list, get, create, update, action, eligibleOrders, parties, partyAddresses, addPartyAddress, searchUsers, createUser, createDraftFromBill, completeForBill };
