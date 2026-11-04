import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { validateAvailability } from '../server/catalog.js';
import { RemoteError } from '../server/errors.js';

function fakeApi() {
  const state = { orders: [], creates: 0, updates: 0, failCreate: false, failUpdate: false, stock: 10, refunds: [] };
  const rawProduct = { id: 10, name: 'Test Dress', type: 'variable', sku: 'DRESS', price: '100.00', images: [], categories: [{name:'Dresses'}], status: 'publish', purchasable: true, manage_stock: false, stock_status: 'instock', backorders: 'no', permalink: 'https://staging.example.com/product/test' };
  const rawVariation = { id: 11, sku: 'DRESS-M', price: '100.00', attributes: [{name:'Size',option:'M'}], manage_stock: true, stock_quantity: state.stock, stock_status: 'instock', backorders: 'no', purchasable: true };
  const orderView = o => ({ ...o, line_items: o.line_items.map(i => ({ ...i, name:'Test Dress', sku:'DRESS-M', price:100, subtotal:'100.00', total:'100.00', total_tax:'15.00', meta_data:[{key:'Size',value:'M'}] })), refunds: state.refunds });
  return {
    state,
    async request(resource) { if (resource === 'products') return { data:[rawProduct], total:1, pages:1 }; throw new Error('Unexpected request'); },
    async products() { return { data:[rawProduct], total:1, pages:1 }; },
    async variations() { return { data:[{...rawVariation, stock_quantity:state.stock}], total:1, pages:1 }; },
    async product() { return rawProduct; },
    async variation() { return {...rawVariation, stock_quantity:state.stock}; },
    async createOrder(body) { state.creates++; if (state.failCreate) throw new RemoteError('timeout',502,true); const o={...body,id:500+state.creates,number:String(500+state.creates),currency:'GHS',total:'115.00',total_tax:'15.00',date_paid:null};state.orders.push(o);return orderView(o); },
    async updateOrder(id,body) { state.updates++; if (state.failUpdate) throw new RemoteError('timeout',502,true); const o=state.orders.find(o=>o.id===id);const {meta_data,...rest}=body;Object.assign(o,rest);if(meta_data){o.meta_data=o.meta_data||[];for(const m of meta_data){const existing=o.meta_data.find(x=>x.key===m.key);if(existing)existing.value=m.value;else o.meta_data.push(m);}}if(body.set_paid){const paid=new Date().toISOString().replace('Z','');o.date_paid=paid;o.date_paid_gmt=paid;}return orderView(o); },
    async order(id) { return orderView(state.orders.find(o=>o.id===id)); },
    async findOrderByKey(key) { const o=state.orders.find(o=>o.meta_data.some(m=>m.key==='_mansu_pos_key'&&m.value===key));return o?orderView(o):null; },
  };
}
async function harness(t, mode='demo', extra={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-test-'));
  const api=fakeApi();
  const env={POS_MODE:mode,POS_DATA_DIR:dir,NODE_ENV:'test',WOO_BASE_URL:mode==='staging'?'https://staging.example.com':'https://www.mansutrendzgh.com',WOO_CONSUMER_KEY:'ck_test',WOO_CONSUMER_SECRET:'cs_test',POS_OWNER_USERNAME:'owner',POS_OWNER_PASSWORD:'test-secret-passphrase-123',POS_REQUIRE_SHIFT:'false',POS_STAGING_APPROVED:'true',...extra};
  const instance=createApp({env,api,logger:{debug(){},info(){},warn(){},error(){},child(){return this;}}});
  const server=instance.app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(url,{method='GET',body,token,headers={}}={}) {
    const res=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...headers},...(body?{body:JSON.stringify(body)}:{})});
    const data=res.headers.get('content-type')?.includes('json')?await res.json():await res.text();
    return {status:res.status,data,headers:res.headers};
  }
  let token;
  if(mode==='demo') token=(await request('/auth/demo',{method:'POST',body:{}})).data.token;
  else {
    token=(await request('/auth/login',{method:'POST',body:{username:'owner',password:'test-secret-passphrase-123'}})).data.token;
    const changed=await request('/auth/password',{method:'POST',token,body:{currentPassword:'test-secret-passphrase-123',newPassword:'rotated-secret-passphrase-123'}});
    if(changed.status!==200) throw new Error('Owner bootstrap password change failed: '+JSON.stringify(changed.data));
  }
  t.after(async()=>{await new Promise(r=>server.close(r));instance.db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {...instance,request,token,api,base};
}
const cart={idempotencyKey:randomUUID(),items:[{productId:10,variationId:11,quantity:1}]};

test('configuration rejects production as staging and requires explicit live gates',()=>{
  assert.throws(()=>readConfig({POS_MODE:'staging',WOO_BASE_URL:'https://www.mansutrendzgh.com'}),/separate staging/);
  const live=readConfig({POS_MODE:'live',WOO_CONSUMER_KEY:'k',WOO_CONSUMER_SECRET:'s'});
  assert.equal(live.writesEnabled,false);
  assert.equal(readConfig({POS_MODE:'live',WOO_CONSUMER_KEY:'k',WOO_CONSUMER_SECRET:'s',POS_ALLOW_LIVE_WRITES:'true',POS_OWNER_APPROVAL_REFERENCE:'written-owner-approval'}).writesEnabled,true);
});

test('unauthenticated and cross-origin requests are rejected',async t=>{
  const h=await harness(t);
  assert.equal((await h.request('/catalog')).status,401);
  assert.equal((await h.request('/auth/demo',{method:'POST',body:{},headers:{Origin:'https://evil.example'}})).status,403);
});

test('embedded preview session survives stripped Authorization/cookie headers via fallback bearer header',async t=>{
  const h=await harness(t);
  const catalog=await h.request('/catalog',{headers:{'X-Mansu-Session':h.token}});
  assert.equal(catalog.status,200);
  assert.ok(catalog.data.products.length>0);
  const sale=await h.request('/sales/prepare',{method:'POST',headers:{'X-Mansu-Session':h.token},body:{idempotencyKey:randomUUID(),items:[{productId:7331,quantity:1}]}});
  assert.equal(sale.status,201);
  assert.equal((await h.request('/catalog',{headers:{'X-Mansu-Session':'invalid-token'}})).status,401);
});

test('demo checkout records all payment methods, reduces only demo stock, and is idempotent',async t=>{
  const h=await harness(t);
  const before=(await h.request('/catalog',{token:h.token})).data.products.find(p=>p.id===7325).variations.find(v=>v.id===7327).stock;
  for(const method of ['cash','momo','card']) {
    const input={idempotencyKey:randomUUID(),items:[{productId:7325,variationId:7327,quantity:1}]};
    const prepared=await h.request('/sales/prepare',{method:'POST',token:h.token,body:input});
    assert.equal(prepared.status,201);
    const again=await h.request('/sales/prepare',{method:'POST',token:h.token,body:input});
    assert.equal(again.data.sale.id,prepared.data.sale.id);
    const payment={method,confirmed:true,...(method==='cash'?{tendered:30000}:{reference:`TEST-${method}-123`})};
    const paid=await h.request(`/sales/${prepared.data.sale.id}/pay`,{method:'POST',token:h.token,body:payment});
    assert.equal(paid.data.sale.status,'paid');
    assert.equal(paid.data.sale.paymentMethod,method);
    const repeat=await h.request(`/sales/${prepared.data.sale.id}/pay`,{method:'POST',token:h.token,body:payment});
    assert.equal(repeat.data.sale.id,paid.data.sale.id);
  }
  const after=(await h.request('/catalog',{token:h.token})).data.products.find(p=>p.id===7325).variations.find(v=>v.id===7327).stock;
  assert.equal(before-after,3);
  assert.equal(h.api.state.creates,0);
});

test('payment validation rejects insufficient cash, missing external reference, and full card numbers',async t=>{
  const h=await harness(t);
  const sale=(await h.request('/sales/prepare',{method:'POST',token:h.token,body:{...cart,idempotencyKey:randomUUID(),items:[{productId:7331,quantity:1}]}})).data.sale;
  assert.equal((await h.request(`/sales/${sale.id}/pay`,{method:'POST',token:h.token,body:{method:'cash',confirmed:true,tendered:1}})).status,400);
  assert.equal((await h.request(`/sales/${sale.id}/pay`,{method:'POST',token:h.token,body:{method:'momo',confirmed:true}})).status,400);
  assert.equal((await h.request(`/sales/${sale.id}/pay`,{method:'POST',token:h.token,body:{method:'card',confirmed:true,reference:'4111111111111111'}})).status,400);
});

test('overselling and unapproved live checkout are blocked',async t=>{
  const h=await harness(t);
  const response=await h.request('/sales/prepare',{method:'POST',token:h.token,body:{idempotencyKey:randomUUID(),items:[{productId:7331,quantity:999}]}});
  assert.equal(response.status,409);
  const live=await harness(t,'live',{POS_ALLOW_LIVE_WRITES:'false'});
  assert.equal((await live.request('/sales/prepare',{method:'POST',token:live.token,body:cart})).status,403);
  assert.equal(live.api.state.creates,0);
});

test('staging uses WooCommerce authoritative totals and records external payment without processing it',async t=>{
  const h=await harness(t,'staging');
  const prepared=await h.request('/sales/prepare',{method:'POST',token:h.token,body:cart});
  assert.equal(prepared.status,201);
  assert.equal(prepared.data.sale.total,11500);
  assert.equal(prepared.data.sale.tax,1500);
  assert.equal(prepared.data.sale.status,'awaiting_payment');
  assert.equal(h.api.state.orders[0].status,'pending');
  assert.equal(h.api.state.orders[0].line_items[0].price,undefined);
  const paid=await h.request(`/sales/${prepared.data.sale.id}/pay`,{method:'POST',token:h.token,body:{method:'momo',reference:'MOMO-TEST-001',confirmed:true}});
  assert.equal(paid.data.sale.status,'paid');
  assert.equal(h.api.state.orders[0].set_paid,true);
  assert.equal(h.api.state.orders[0].payment_method,'pos_momo');
  assert.equal(h.api.state.orders[0].transaction_id,'MOMO-TEST-001');
  assert.equal(h.api.state.creates,1);
});

test('interrupted create can be reconciled without creating a duplicate order',async t=>{
  const h=await harness(t,'staging');
  h.api.state.failCreate=true;
  const failed=await h.request('/sales/prepare',{method:'POST',token:h.token,body:cart});
  assert.equal(failed.data.code,'RECONCILIATION_REQUIRED');
  const id=(await h.request('/sales',{token:h.token})).data.sales[0].id;
  const retry=await h.request('/sales/prepare',{method:'POST',token:h.token,body:cart});
  assert.equal(retry.status,409);
  h.api.state.failCreate=false;
  // Simulate a response lost after the remote order was committed.
  const order=await h.api.createOrder({status:'pending',line_items:cart.items,meta_data:[{key:'_mansu_pos_key',value:cart.idempotencyKey}]});
  const reconciled=await h.request(`/sales/${id}/reconcile`,{method:'POST',token:h.token,body:{}});
  assert.equal(reconciled.data.sale.wooOrderId,order.id);
  assert.equal(reconciled.data.sale.status,'awaiting_payment');
  assert.equal(h.api.state.creates,2); // one fixture + one reconciliation lookup path, never an automatic checkout retry
});

test('interrupted payment confirmation reconciles to the existing paid order',async t=>{
  const h=await harness(t,'staging');
  const sale=(await h.request('/sales/prepare',{method:'POST',token:h.token,body:cart})).data.sale;
  h.api.state.failUpdate=true;
  const failed=await h.request(`/sales/${sale.id}/pay`,{method:'POST',token:h.token,body:{method:'card',reference:'TERMINAL-001',confirmed:true}});
  assert.equal(failed.data.code,'RECONCILIATION_REQUIRED');
  h.api.state.failUpdate=false;
  await h.api.updateOrder(sale.wooOrderId,{status:'completed',set_paid:true,payment_method:'pos_card',transaction_id:'TERMINAL-001'});
  const reconciled=await h.request(`/sales/${sale.id}/reconcile`,{method:'POST',token:h.token,body:{}});
  assert.equal(reconciled.data.sale.status,'paid');
  assert.equal(reconciled.data.sale.paymentReference,'TERMINAL-001');
  assert.equal(h.api.state.creates,1);
});

test('refunds reconcile into net reports and CSV export stays in the selected window',async t=>{
  const h=await harness(t,'staging');
  const sale=(await h.request('/sales/prepare',{method:'POST',token:h.token,body:cart})).data.sale;
  await h.request(`/sales/${sale.id}/pay`,{method:'POST',token:h.token,body:{method:'cash',tendered:12000,confirmed:true}});
  h.api.state.refunds=[{total:'-40.00'}];
  await h.request(`/sales/${sale.id}/reconcile`,{method:'POST',token:h.token,body:{}});
  const report=(await h.request('/reports?days=1',{token:h.token})).data;
  assert.equal(report.total,7500);
  const csv=await h.request('/reports/export?days=1',{token:h.token});
  assert.match(csv.data,/75\.00/);
  assert.match(csv.headers.get('content-disposition'),/\.csv/);
});

test('cashiers cannot access staff, connection settings, reports, or another cashier sale',async t=>{
  const h=await harness(t,'staging');
  const created=await h.request('/staff',{method:'POST',token:h.token,body:{name:'Test Cashier',username:'cashier',role:'cashier',password:'counter-secret-passphrase-123'}});
  assert.equal(created.status,201);
  const login=await h.request('/auth/login',{method:'POST',body:{username:'cashier',password:'counter-secret-passphrase-123'}});
  const token=login.data.token;
  await h.request('/auth/password',{method:'POST',token,body:{currentPassword:'counter-secret-passphrase-123',newPassword:'counter-rotated-secret-123'}});
  for(const url of ['/staff','/reports','/reports/export']) assert.equal((await h.request(url,{token})).status,403);
  assert.equal((await h.request('/connection/test',{method:'POST',token,body:{}})).status,403);
  const sale=(await h.request('/sales/prepare',{method:'POST',token:h.token,body:cart})).data.sale;
  assert.equal((await h.request(`/sales/${sale.id}/reconcile`,{method:'POST',token,body:{}})).status,403);
  assert.equal((await h.request('/sales',{token})).data.sales.length,0);
});

test('owner can change password and reset staff password; old sessions are revoked',async t=>{
  const h=await harness(t,'staging');
  const created=await h.request('/staff',{method:'POST',token:h.token,body:{name:'Test Cashier',username:'cashier',role:'cashier',password:'counter-secret-passphrase-123'}});
  const login=await h.request('/auth/login',{method:'POST',body:{username:'cashier',password:'counter-secret-passphrase-123'}});
  const cashierToken=login.data.token;
  assert.equal((await h.request('/auth/password',{method:'POST',token:cashierToken,body:{currentPassword:'wrong',newPassword:'counter-rotated-secret-123'}})).status,401);
  assert.equal((await h.request('/auth/password',{method:'POST',token:cashierToken,body:{currentPassword:'counter-secret-passphrase-123',newPassword:'counter-rotated-secret-123'}})).status,200);
  assert.equal((await h.request('/auth/login',{method:'POST',body:{username:'cashier',password:'counter-secret-passphrase-123'}})).status,401);
  assert.equal((await h.request('/auth/login',{method:'POST',body:{username:'cashier',password:'counter-rotated-secret-123'}})).status,200);
  assert.equal((await h.request(`/staff/${created.data.user.id}/password`,{method:'POST',token:h.token,body:{newPassword:'counter-reset-secret-123'}})).status,200);
  assert.equal((await h.request('/catalog',{token:cashierToken})).status,401);
  assert.equal((await h.request('/auth/login',{method:'POST',body:{username:'cashier',password:'counter-reset-secret-123'}})).status,200);
});

test('shared parent stock is aggregated across variations',()=>{
  const line={purchasable:true,manageStock:true,stock:3,stockStatus:'instock',backorders:'no',name:'Dress'};
  assert.throws(()=>validateAvailability([{...line,stockKey:'1:0',quantity:2},{...line,stockKey:'1:0',quantity:2}]),/Not enough stock/);
});

test('production shifts gate checkout, track cash movements, and close with variance',async t=>{
  const h=await harness(t,'staging',{POS_REQUIRE_SHIFT:'true'});
  const blocked=await h.request('/sales/prepare',{method:'POST',token:h.token,body:{...cart,idempotencyKey:randomUUID()}});
  assert.equal(blocked.status,409);
  assert.equal(blocked.data.code,'SHIFT_REQUIRED');
  const opened=await h.request('/shifts/open',{method:'POST',token:h.token,body:{openingFloat:10000,note:'Morning float'}});
  assert.equal(opened.status,201);
  const shiftId=opened.data.shift.id;
  assert.equal((await h.request('/shifts/open',{method:'POST',token:h.token,body:{openingFloat:0}})).status,409);
  const sale=(await h.request('/sales/prepare',{method:'POST',token:h.token,body:{...cart,idempotencyKey:randomUUID()}})).data.sale;
  assert.equal(sale.shiftId,shiftId);
  await h.request(`/sales/${sale.id}/pay`,{method:'POST',token:h.token,body:{method:'cash',tendered:12000,confirmed:true}});
  await h.request(`/shifts/${shiftId}/cash`,{method:'POST',token:h.token,body:{type:'out',amount:500,reason:'Supplier pickup'}});
  const current=(await h.request('/shifts/current',{token:h.token})).data.shift;
  assert.equal(current.expectedCash,21000);
  const closed=await h.request(`/shifts/${shiftId}/close`,{method:'POST',token:h.token,body:{closingCash:20950,note:'Counted'}});
  assert.equal(closed.data.shift.status,'closed');
  assert.equal(closed.data.shift.variance,-50);
  assert.equal((await h.request('/sales/prepare',{method:'POST',token:h.token,body:{...cart,idempotencyKey:randomUUID()}})).data.code,'SHIFT_REQUIRED');
});

test('shift close is blocked while a sale is pending',async t=>{
  const h=await harness(t,'staging',{POS_REQUIRE_SHIFT:'true'});
  const shift=(await h.request('/shifts/open',{method:'POST',token:h.token,body:{openingFloat:0}})).data.shift;
  await h.request('/sales/prepare',{method:'POST',token:h.token,body:{...cart,idempotencyKey:randomUUID()}});
  const closed=await h.request(`/shifts/${shift.id}/close`,{method:'POST',token:h.token,body:{closingCash:0}});
  assert.equal(closed.status,409);
});

test('account lockout, password policy, audit, and readiness behave safely',async t=>{
  const h=await harness(t,'staging');
  assert.equal((await h.request('/staff',{method:'POST',token:h.token,body:{name:'Weak User',username:'weakuser',role:'cashier',password:'weakuser-password-123'}})).status,400);
  const created=await h.request('/staff',{method:'POST',token:h.token,body:{name:'Lock Test',username:'locktest',role:'cashier',password:'counter-secret-passphrase-123'}});
  assert.equal(created.status,201);
  for(let i=0;i<8;i++) await h.request('/auth/login',{method:'POST',body:{username:'locktest',password:'wrong-password-123'}});
  assert.equal((await h.request('/auth/login',{method:'POST',body:{username:'locktest',password:'counter-secret-passphrase-123'}})).status,423);
  const audit=await h.request('/audit',{token:h.token});
  assert.equal(audit.status,200);
  assert.ok(audit.data.events.some(e=>e.action==='auth.locked'));
  const ready=await h.request('/ready');
  assert.equal(ready.status,200);
  assert.equal(ready.data.ok,true);
});
