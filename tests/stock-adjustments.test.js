import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

const note = 'Counted the exact colour and size on the shop shelf';
const req = (productId, variationId, expectedQuantity, targetQuantity) => ({
  productId, variationId, expectedQuantity, targetQuantity, reason: 'recount', note,
});

async function harness(t, { mode = 'demo', readOnly = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-stock-review-'));
  const state = {
    productWrites: 0, product: {
      id: 8001, type: 'simple', status: 'publish', name: 'Mansu outfit fixture',
      sku: 'SKU-8001', manage_stock: true, stock_quantity: 3,
      price: '150.00', stock_status: 'instock', backorders: 'no',
      purchasable: true, categories: [], images: [],
    },
    option: {id: 8002, sku: 'S-8002', manage_stock: 'parent', price:'150.00',
      attributes: [{name:'Size',option:'S'}], stock_status:'instock', purchasable:true},
  };
  const mockApi = {
    async products() { return {data:[state.product],pages:1,total:1}; },
    async variations() { return {data:[state.option],pages:1,total:1}; },
    async product(id) { assert.equal(id,state.product.id); return {...state.product}; },
    async variation(productId,id) {
      assert.equal(productId,state.product.id); assert.equal(id,state.option.id);
      return {...state.option};
    },
    async request(_resource, options = {}) {
      if (options.method && options.method !== 'GET') state.productWrites++;
      throw new Error('Unrelated WooCommerce operation is forbidden in the stock review harness.');
    },
  };
  const env = {
    NODE_ENV: 'test', POS_MODE: mode, POS_DATA_DIR: dir,
    ...(mode === 'live' ? {
      POS_LIVE_READ_ONLY: String(readOnly),
      WOO_BASE_URL: 'https://www.mansutrendzgh.com',
      WOO_CONSUMER_KEY: 'ck_fixture', WOO_CONSUMER_SECRET: 'cs_fixture',
      POS_ALLOW_LIVE_WRITES: 'false',
      POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'stock-review-bootstrap-123',
    } : {}),
  };
  const instance = createApp({env, api:mockApi, logger:{info(){},debug(){},warn(){},error(){}}});
  const server = instance.app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(route,{method='GET',body,token}={}) {
    const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',
      ...(token?{'X-Mansu-Session':token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json()};
  }
  let owner;
  if(mode==='demo') owner=(await call('/auth/demo',{method:'POST',body:{}})).data.token;
  else {
    owner=(await call('/auth/login',{method:'POST',body:{username:'owner',password:env.POS_OWNER_PASSWORD}})).data.token;
    assert.ok(owner);
    assert.equal((await call('/auth/password',{method:'POST',token:owner,
      body:{currentPassword:env.POS_OWNER_PASSWORD,newPassword:'stock-review-rotated-123'}})).status,200);
  }
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    instance.db.close();fs.rmSync(dir,{recursive:true,force:true});
  });
  return {call,owner,state,instance};
}

test('Owner-reviewed demo adjustment updates demo stock atomically and preserves history',async t=>{
  const h=await harness(t);
  const stock=(await h.call('/catalog',{token:h.owner})).data.products[0];
  assert.equal(stock.id,7331);
  assert.equal(stock.stock,6);
  const created=await h.call('/stock-adjustments',{method:'POST',token:h.owner,
    body:req(7331,0,6,9)});
  assert.equal(created.status,201,JSON.stringify(created.data));
  const id=created.data.request.id;
  assert.equal(created.data.request.status,'pending');
  assert.equal((await h.call('/stock-adjustments',{method:'POST',token:h.owner,
    body:req(7331,0,6,11)})).status,409,'One unresolved request per stock owner');
  const approved=await h.call(`/stock-adjustments/${id}/review`,{method:'POST',token:h.owner,
    body:{decision:'approve',note:'Verified count and accepted'}});
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  assert.equal(approved.data.request.status,'verified');
  assert.equal(h.instance.db.prepare('SELECT stock FROM demo_stock WHERE line_key=?').get('7331:0').stock,9);
  assert.equal((await h.call('/catalog',{token:h.owner})).data.products[0].stock,9);
  assert.equal((await h.call(`/stock-adjustments/${id}/review`,{method:'POST',token:h.owner,
    body:{decision:'approve'}})).status,409);
  assert.equal((await h.call('/stock-adjustments',{method:'POST',token:h.owner,
    body:req(7331,0,6,10)})).status,409,'Stale count rejected');
  assert.ok(h.instance.db.prepare("SELECT 1 FROM audit WHERE action='stock_adjustment.demo_applied' AND subject=?").get(id));
  assert.equal(h.state.productWrites,0);
});

test('Live owner approval never writes stock; verify requires fresh matching Woo balance',async t=>{
  const h=await harness(t,{mode:'live',readOnly:true});
  const response=await h.call('/stock-adjustments',{method:'POST',token:h.owner,
    body:req(8001,0,3,7)});
  assert.equal(response.status,201,JSON.stringify(response.data));
  const id=response.data.request.id;
  assert.equal((await h.call(`/stock-adjustments/${id}/verify`,{method:'POST',token:h.owner,body:{}})).status,409);
  const approval=await h.call(`/stock-adjustments/${id}/review`,{method:'POST',token:h.owner,
    body:{decision:'approve',note:'Owner physically checked stock'}});
  assert.equal(approval.status,200,JSON.stringify(approval.data));
  assert.equal(approval.data.request.status,'approved');
  assert.equal(h.state.product.stock_quantity,3);
  assert.equal(h.state.productWrites,0);
  assert.equal((await h.call(`/stock-adjustments/${id}/verify`,{method:'POST',token:h.owner,body:{}})).status,409);
  h.state.product.stock_quantity=7; // independent website edit; POS does not do this
  const observed=await h.call(`/stock-adjustments/${id}/verify`,{method:'POST',token:h.owner,body:{}});
  assert.equal(observed.status,200,JSON.stringify(observed.data));
  assert.equal(observed.data.request.status,'verified');
  assert.equal(h.state.productWrites,0);
  assert.ok(h.instance.db.prepare("SELECT 1 FROM audit WHERE action='stock_adjustment.woo_balance_observed' AND subject=?").get(id));
});

test('Staff can request changes, but only owner can approve; stale and shared-parent requests are blocked',async t=>{
  const h=await harness(t,{mode:'live',readOnly:true});
  const cashierPwd='kappa-review-temp-pass-123';
  const managerPwd='omega-review-temp-pass-123';
  for(const [username,password,role] of [['cashier',cashierPwd,'cashier'],['manager',managerPwd,'manager']]){
    const created=await h.call('/staff',{method:'POST',token:h.owner,
      body:{name:username,username,password,role}});
    assert.equal(created.status,201,JSON.stringify(created.data));
  }
  async function login(name,password) {
    const result=await h.call('/auth/login',{method:'POST',body:{username:name,password}});
    assert.equal(result.status,200,JSON.stringify(result.data));
    const token=result.data.token;
    assert.equal((await h.call('/auth/password',{method:'POST',token,
      body:{currentPassword:password,newPassword:`${password}-updated`}})).status,200);
    return token;
  }
  const cashier=await login('cashier',cashierPwd);
  const manager=await login('manager',managerPwd);
  assert.equal((await h.call('/stock-adjustments',{method:'POST',token:cashier,
    body:req(8001,0,3,5)})).status,201);
  const list=await h.call('/stock-adjustments',{token:cashier});
  assert.equal(list.status,200);
  assert.equal(list.data.requests.length,1);
  const id=list.data.requests[0].id;
  assert.equal((await h.call(`/stock-adjustments/${id}/review`,{method:'POST',token:cashier,
    body:{decision:'approve'}})).status,403);
  assert.equal((await h.call(`/stock-adjustments/${id}/review`,{method:'POST',token:manager,
    body:{decision:'approve'}})).status,403);
  assert.equal((await h.call('/stock-adjustments',{method:'POST',token:manager,
    body:req(8001,0,3,6)})).status,409,'one outstanding stock pool request');
  h.state.product.stock_quantity=4;
  assert.equal((await h.call(`/stock-adjustments/${id}/review`,{method:'POST',token:h.owner,
    body:{decision:'approve'}})).status,409,'old count is stale');
  const rejected=await h.call(`/stock-adjustments/${id}/review`,{method:'POST',token:h.owner,
    body:{decision:'reject',note:'Stock changed since initial count'}});
  assert.equal(rejected.status,200,JSON.stringify(rejected.data));
  h.state.product.type='variable';h.state.product.stock_quantity=5;
  assert.equal((await h.call('/stock-adjustments',{method:'POST',token:cashier,
    body:req(8001,8002,5,6)})).status,409,'a shared parent pool is not variation stock');
  assert.equal(h.state.productWrites,0);
});
