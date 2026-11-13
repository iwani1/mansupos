import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { DesktopSyncService } from '../server/desktop-sync.js';
import { openDatabase } from '../server/db.js';
import { Catalog } from '../server/catalog.js';

const deviceId='93d32bc2-f972-4872-adc5-5ed2661f0d17';
const expiration=new Date(Date.now()+24*3600000).toISOString();
const hash=e=>createHash('sha256').update(JSON.stringify(e)).digest('hex');
const env={NODE_ENV:'test',POS_MODE:'live',POS_LIVE_READ_ONLY:'false',WOO_BASE_URL:'https://www.mansutrendzgh.com',
  WOO_CONSUMER_KEY:'ck_fixture',WOO_CONSUMER_SECRET:'cs_fixture',POS_ALLOW_LIVE_WRITES:'true',
  POS_OWNER_APPROVAL_REFERENCE:'separate-live-trading-review',POS_DESKTOP_SETUP_APPROVED:'true',
  POS_DESKTOP_SETUP_REFERENCE:'offline-setup-witnessed-review',POS_DESKTOP_RESERVATION_APPROVED:'true',
  POS_DESKTOP_ACCEPTANCE_REFERENCE:'offline-last-unit-witnessed-review',POS_DESKTOP_WP_APP_USER:'private-app-user',
  POS_DESKTOP_WP_APP_PASSWORD:'not-in-the-desktop',POS_DESKTOP_DEVICE_MASTER_SECRET:'test-only-device-master-secret-longer-than-32',
  POS_OWNER_USERNAME:'owner',POS_OWNER_PASSWORD:'very-long-secret-for-test',
  POS_REQUIRE_SHIFT:'false'};
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-central-offline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const config=readConfig({...env,POS_DATA_DIR:dir});const db=openDatabase(config);t.after(()=>db.close());
  const owner=db.prepare("SELECT id,username,name,role FROM users WHERE role='owner'").get();
  let pluginCalls=0,orderCalls=0;
  const orders=new Map();
  const woo={ async products(){return {pages:1,total:1,data:[{id:101,type:'simple',name:'Shirt',status:'publish',sku:'SHIRT',price:'12.00',
    images:[],categories:[],manage_stock:true,stock_quantity:4,stock_status:'instock',backorders:'no',purchasable:true}]};},
    async order(id){orderCalls++;return orders.get(id);}, async createOrder(){throw new Error('Legacy Woo POST must never import offline sales.');}};
  const reservations={ async status(id){return {deviceId:id,enforced:true,enabled:true,leaseExpiresAt:expiration,
    grants:[{stockKey:'101:0',productId:101,variationId:0,remaining:2,revision:1,expiresAt:expiration}]};},
    async allocate(input){return {deviceId:input.deviceId,stockKey:'101:0',grant:{stockKey:'101:0',productId:101,variationId:0,
      remaining:2,revision:1,expiresAt:expiration}};},
    async sync(event){pluginCalls++;
      if(event.kind==='return')orders.get(9001).refunds=[{id:42,total:(-event.amount/100).toFixed(2)}];
      if(event.kind==='sale')orders.set(9001,{id:9001,currency:'GHS',total:(event.total/100).toFixed(2),total_tax:'0.00',refunds:[],
        line_items:event.items.map(i=>({product_id:i.productId,variation_id:i.variationId,quantity:i.quantity})),
        meta_data:[{key:'_mansu_offline_sale_id',value:event.id},{key:'_mansu_offline_device_id',value:event.deviceId}],
        status:event.paymentMethod==='cash'?'completed':'pending',date_paid:event.paymentMethod==='cash'?new Date().toISOString():null});
      return {id:event.id,fingerprint:hash(event),orderId:9001,...(event.kind==='return'?{refundId:42,amount:event.amount}:{})}; },
  };
  const catalog=new Catalog(db,woo,config);
  const service=new DesktopSyncService(db,config,catalog,woo,reservations,{async list(){return {prices:[]};}});
  return {db,owner,service,config,woo,reservations,get pluginCalls(){return pluginCalls;},get orderCalls(){return orderCalls;}};
}
const sync=(f,event)=>f.service.sync(f.owner,{event,signature:createHmac('sha256',f.service.deviceSecret(event.deviceId)).update(JSON.stringify(event)).digest('hex')});
function sale(f,overrides={}){return {kind:'sale',id:randomUUID(),deviceId,cashierId:f.owner.id,cashierName:'Owner',saleType:'retail',
  buyerName:'',approvedById:null,approvedByName:'',paymentMethod:'cash',paymentReference:'',paymentStatus:'cash_received',
  tendered:1200,total:1200,items:[{productId:101,variationId:0,stockKey:'101:0',quantity:1,name:'Shirt',label:'',sku:'SHIRT',price:1200}],
  note:'',createdAt:new Date().toISOString(),grantRevisions:{'101:0':1},...overrides};}

test('ordinary write approval, demo/staging and catalogue pilot cannot activate offline allocation',()=>{
  assert.equal(readConfig({...env,POS_DESKTOP_RESERVATION_APPROVED:'false'}).desktopEnabled,false);
  assert.throws(()=>readConfig({...env,POS_LIVE_READ_ONLY:'true',POS_ALLOW_LIVE_WRITES:'false'}),/read-only pilot/);
  assert.throws(()=>readConfig({...env,POS_DESKTOP_ACCEPTANCE_REFERENCE:env.POS_OWNER_APPROVAL_REFERENCE}),/distinct documented/);
  assert.throws(()=>readConfig({...env,POS_DESKTOP_WP_APP_PASSWORD:''}),/WordPress Application Password/);
  assert.throws(()=>readConfig({...env,POS_DESKTOP_DEVICE_MASTER_SECRET:''}),/device signing secret/);
  assert.throws(()=>readConfig({...env,POS_MODE:'staging',WOO_BASE_URL:'https://staging.example.com'}),/separate live trading service/);
});

test('one till, fresh complete catalogue and role-limited bootstrap; private prices never sent to cashier',async t=>{
  const f=fixture(t);
  assert.equal(f.service.enroll(f.owner,{deviceId}).deviceSecret,f.service.deviceSecret(deviceId));
  assert.equal(f.service.enroll(f.owner,{deviceId}).enrolled,true);
  assert.throws(()=>f.service.enroll(f.owner,{deviceId:randomUUID()}),{code:'SINGLE_TILL'});
  const bootstrap=await f.service.bootstrap(f.owner,deviceId);
  assert.equal(bootstrap.catalog.products[0].price,1200);
  assert.equal(bootstrap.canSell,true);assert.equal(bootstrap.canWholesale,false);assert.equal(bootstrap.grants[0].remaining,2);
  const cashier={id:randomUUID(),role:'cashier'};
  assert.deepEqual((await f.service.bootstrap(cashier,deviceId)).wholesalePrices,[]);
  await assert.rejects(()=>f.service.allocate(cashier,{idempotencyKey:randomUUID(),deviceId,productId:101,variationId:0,quantity:1}),{status:403});
  const alloc=await f.service.allocate(f.owner,{idempotencyKey:randomUUID(),deviceId,productId:101,variationId:0,quantity:1});
  assert.equal(alloc.grant.stockKey,'101:0');
});

test('a Woo allocation without a matching published product cannot authorize offline checkout',async t=>{
  const f=fixture(t);f.service.enroll(f.owner,{deviceId});
  f.reservations.status=async id=>({deviceId:id,enforced:true,enabled:true,leaseExpiresAt:expiration,
    grants:[{stockKey:'999:0',productId:999,variationId:0,remaining:1,revision:1,expiresAt:expiration}]});
  await assert.rejects(()=>f.service.bootstrap(f.owner,deviceId),/cached Woo catalogue/);
});

test('tampered or unsigned events never reach Woo or the central inbox',async t=>{
  const f=fixture(t);f.service.enroll(f.owner,{deviceId});
  const event=sale(f);
  await assert.rejects(()=>f.service.sync(f.owner,{event,signature:'0'.repeat(64)}),{code:'DEVICE_SIGNATURE_INVALID'});
  await assert.rejects(()=>f.service.sync(f.owner,{event,signature:''}));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM offline_events').get().n,0);
  assert.equal(f.pluginCalls,0);
  const valid=createHmac('sha256',f.service.deviceSecret(deviceId)).update(JSON.stringify(event)).digest('hex');
  await assert.rejects(()=>f.service.sync(f.owner,{event:{...event,total:999},signature:valid}),{code:'DEVICE_SIGNATURE_INVALID'});
  assert.equal(f.pluginCalls,0);
});

test('central inbox survives uncertainty and imports exactly one existing Woo order after idempotent replay',async t=>{
  const f=fixture(t);f.service.enroll(f.owner,{deviceId});
  const event=sale(f);
  let lose=true;const original=f.reservations.sync.bind(f.reservations);
  f.reservations.sync=async data=>{const ack=await original(data);if(lose){lose=false;throw new Error('Response lost after Woo commit');}return ack;};
  await assert.rejects(()=>sync(f,event),/Response lost/);
  assert.equal(f.db.prepare('SELECT status FROM offline_events WHERE id=?').get(event.id).status,'pending');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,0);
  const ack=await sync(f,event);
  assert.equal(ack.status,'acked');assert.equal(ack.fingerprint,hash(event));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,1);
  assert.equal(f.db.prepare('SELECT woo_order_id FROM sales WHERE id=?').get(event.id).woo_order_id,9001);
  assert.equal((await sync(f,event)).wooOrderId,9001);
  assert.equal(f.pluginCalls,2);assert.equal(f.orderCalls,1);
  await assert.rejects(()=>sync(f,{...event,total:500}),{code:'SYNC_CONFLICT'});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,1);
});

test('unverified MoMo remains unpaid in Woo and POS; owner returns use a durable event',async t=>{
  const f=fixture(t);f.service.enroll(f.owner,{deviceId});
  const momo=sale(f,{id:randomUUID(),paymentMethod:'momo',paymentStatus:'unverified',paymentReference:'merchant-ref',tendered:0});
  assert.equal((await sync(f,momo)).status,'acked');
  assert.equal(f.db.prepare('SELECT status,paid_at FROM sales WHERE id=?').get(momo.id).status,'awaiting_payment');
  assert.equal(f.db.prepare('SELECT paid_at FROM sales WHERE id=?').get(momo.id).paid_at,null);
  const original=sale(f,{id:randomUUID()});await sync(f,original);
  const refund={kind:'return',id:randomUUID(),deviceId,saleId:original.id,actorId:f.owner.id,actorName:'Owner',
    items:[{productId:101,variationId:0,stockKey:'101:0',quantity:1,amount:1200}],amount:1200,
    reason:'Customer returned goods',cashRefunded:true,createdAt:new Date().toISOString()};
  assert.equal((await sync(f,refund)).status,'acked');
  assert.equal(f.db.prepare('SELECT refunded,status FROM sales WHERE id=?').get(original.id).status,'refunded');
  await sync(f,refund);
  assert.equal(f.db.prepare('SELECT refunded FROM sales WHERE id=?').get(original.id).refunded,1200);
});

test('a missing Woo refund acknowledgement keeps the original return pending for SAME-ID replay',async t=>{
  const f=fixture(t);f.service.enroll(f.owner,{deviceId});
  const original=sale(f);await sync(f,original);
  const refund={kind:'return',id:randomUUID(),deviceId,saleId:original.id,actorId:f.owner.id,actorName:'Owner',
    items:[{productId:101,variationId:0,stockKey:'101:0',quantity:1,amount:1200}],amount:1200,
    reason:'Customer returned goods',cashRefunded:true,createdAt:new Date().toISOString()};
  const realOrder=f.woo.order.bind(f.woo);
  f.woo.order=async id=>{const order=await realOrder(id);return {...order,refunds:[]};};
  await assert.rejects(()=>sync(f,refund),{code:'SYNC_CONFLICT'});
  assert.equal(f.db.prepare('SELECT status FROM offline_events WHERE id=?').get(refund.id).status,'pending');
  assert.equal(f.db.prepare('SELECT refunded FROM sales WHERE id=?').get(original.id).refunded,0);
  f.woo.order=realOrder;
  assert.equal((await sync(f,refund)).status,'acked');
  assert.equal(f.db.prepare('SELECT refunded FROM sales WHERE id=?').get(original.id).refunded,1200);
});

test('read-only pilot routes never call reservation plugin or create Woo orders',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-locked-desktop-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let calls=0;
  const instance=createApp({env:{NODE_ENV:'test',POS_MODE:'live',POS_LIVE_READ_ONLY:'true',POS_DATA_DIR:dir,
    WOO_BASE_URL:'https://www.mansutrendzgh.com',WOO_CONSUMER_KEY:'read',WOO_CONSUMER_SECRET:'only',
    POS_OWNER_USERNAME:'owner',POS_OWNER_PASSWORD:'very-long-secret-for-test'},
    reservations:{status(){calls++;},allocate(){calls++;},sync(){calls++;}},
    api:{createOrder(){calls++;},updateOrder(){calls++;}},logger:{info(){},error(){},warn(){},debug(){}}});
  const server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));instance.db.close();});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  instance.db.prepare('UPDATE users SET must_change_password=0').run();
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password:'very-long-secret-for-test'})});
  const token=(await login.json()).token;
  const response=await fetch(base+'/desktop/enroll',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({deviceId})});
  assert.equal(response.status,403);assert.equal(calls,0);
});
