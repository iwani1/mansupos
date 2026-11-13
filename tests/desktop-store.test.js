import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, randomUUID, createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDesktopDatabase, DesktopStore } from '../desktop/store.js';
import { tradingOrigin, TRADING_ORIGIN } from '../desktop/remote.js';
import { bootstrapSchema } from '../desktop/contracts.js';
import { AppError } from '../server/errors.js';

const ownerId = 'cad158dd-1452-46b9-976d-4d7e70fac792';
const device = '93d32bc2-f972-4872-adc5-5ed2661f0d17';
const expiry = new Date(Date.now() + 12 * 3600000).toISOString();
const product = (id, options = {}) => ({ id, name:`Product ${id}`, type:'simple', sku:`SKU-${id}`,
  price:1200, image:'', category:'Clothing', categories:['Clothing'], manageStock:true, stockSource:'product',
  backorders:'no', backordersAllowed:false, stock:4, stockStatus:'instock', purchasable:true,
  soldIndividually:false, variations:[], ...options });
const catalog = { products:[product(101), product(200,{ type:'variable', stockSource:'parent', price:1000,
  variations:[{ id:201, sku:'BLUE',label:'Blue',price:1000,stockSource:'parent',manageStock:true,stock:3,
    stockStatus:'instock',purchasable:true,backorders:'no',backordersAllowed:false },
  { id:202, sku:'RED',label:'Red',price:1500,stockSource:'parent',manageStock:true,stock:3,
    stockStatus:'instock',purchasable:true,backorders:'no',backordersAllowed:false }] })],
  source:'woocommerce',complete:true,stale:false,fetchedAt:new Date().toISOString() };
const grants = [{ stockKey:'101:0',productId:101,variationId:0,remaining:2,revision:1,expiresAt:expiry },
  { stockKey:'200:0',productId:200,variationId:0,remaining:3,revision:1,expiresAt:expiry }];
const sha = e => createHash('sha256').update(JSON.stringify(e)).digest('hex');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mansu-desktop-'));
  const key = randomBytes(32);
  const codec = {
    encryptString(text) { const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);
      return Buffer.concat([iv,cipher.update(text,'utf8'),cipher.final(),cipher.getAuthTag()]); },
    decryptString(blob) { const iv=blob.subarray(0,12);const decipher=createDecipheriv('aes-256-gcm',key,iv);
      decipher.setAuthTag(blob.subarray(blob.length-16));return Buffer.concat([decipher.update(blob.subarray(12,-16)),decipher.final()]).toString('utf8'); },
  };
  let syncCalls=0, failSync=false, allocationCalls=0, loseAllocationOnce=false, bootstrapCalls=0, failBootstrap=false;
  const localGrants=structuredClone(grants), allocations=new Map();
  const remote={ validateOrigin:tradingOrigin,
    expectedService:{ mode:'live', storeUrl:'https://www.mansutrendzgh.com' },
    async request(_origin,_token,route,_method,body) {
    if(route==='/auth/login')return { user:{ id:ownerId,username:'owner',name:'Owner',role:'owner',mustChangePassword:false },
      config:{ mode:'live',storeUrl:'https://www.mansutrendzgh.com' },token:'central-private-session' };
    if(route==='/desktop/enroll')return { deviceId:device, enrolled:true, deviceSecret:'a'.repeat(64) };
    if(route.startsWith('/desktop/bootstrap')){
      bootstrapCalls++;if(failBootstrap)throw new AppError('Woo reservation service unavailable',503,'RESERVATION_UNCERTAIN');
      return { deviceId:device,canSell:true,canWholesale:true,leaseExpiresAt:expiry,catalog,grants:localGrants,
        wholesalePrices:[{ productId:101,variationId:0,priceCents:750,valid:true }] };
    }
    if(route==='/desktop/allocate'){
      allocationCalls++;
      let ack=allocations.get(body.idempotencyKey);
      if(!ack){const index=localGrants.findIndex(g=>g.productId===body.productId&&g.variationId===body.variationId);
        if(index<0)throw new Error('Unknown fake stock pool');
        localGrants[index]={...localGrants[index],remaining:localGrants[index].remaining+body.quantity,revision:localGrants[index].revision+1};
        ack={deviceId:device,stockKey:localGrants[index].stockKey,grant:localGrants[index]};allocations.set(body.idempotencyKey,ack);}
      if(loseAllocationOnce){loseAllocationOnce=false;throw new AppError('Allocation response lost',503,'RESERVATION_UNCERTAIN');}
      return ack;
    }
    if(route==='/desktop/sync'){syncCalls++;if(failSync)throw new AppError('Lost acknowledgement',503,'SYNC_OFFLINE');
      const {event,signature}=body;
      assert.equal(signature,createHmac('sha256','a'.repeat(64)).update(JSON.stringify(event)).digest('hex'));
      return { id:event.id, fingerprint:sha(event),status:'acked',wooOrderId:9001 };}
    throw new Error(`Unexpected ${route}`);
  }};
  const db=openDesktopDatabase(dir);const store=new DesktopStore(db,codec,remote);
  return { dir,db,store,codec,remote, device,close(){this.store.close();fs.rmSync(dir,{recursive:true,force:true});},
    reopen(){this.store.close();this.db=openDesktopDatabase(dir);this.store=new DesktopStore(this.db,codec,remote);},
    set failSync(value){failSync=value;},get syncCalls(){return syncCalls;},
    set failBootstrap(value){failBootstrap=value;},get bootstrapCalls(){return bootstrapCalls;},
    set loseAllocationOnce(value){loseAllocationOnce=value;},get allocationCalls(){return allocationCalls;},get reservations(){return allocations.size;} };
}
async function connected(t){const f=fixture();t.after(()=>f.close());
  // Fixed ID is supplied by the central enrollment; the till owns its local ID.
  f.store.put('deviceId',device);
  await f.store.connect({origin:'https://trading.mansutrendzgh.com',username:'owner',password:'Super long offline passphrase 2026!'});
  return f;
}
const saleInput=(key=randomUUID(),items=[{productId:101,variationId:0,quantity:1}])=>({idempotencyKey:key,items,note:''});

test('only the proposed separate trading origin can receive a desktop staff password',async t=>{
  const f=fixture();t.after(()=>f.close());
  assert.equal(tradingOrigin(TRADING_ORIGIN+'/'),TRADING_ORIGIN);
  for(const origin of ['https://pos.mansutrendzgh.com','https://www.mansutrendzgh.com',
    'https://shop.mansutrendzgh.com','http://trading.mansutrendzgh.com',
    'https://trading.mansutrendzgh.com:8443','https://trading.mansutrendzgh.com/api']) {
    await assert.rejects(()=>f.store.connect({origin,username:'owner',password:'Super long offline passphrase 2026!'}),
      {code:'INVALID_TRADING_HOST'});
  }
  assert.equal(f.store.session().provisioned,false);
  assert.equal(f.store.setting('deviceId'),'');
});

test('bootstrap grants must match the exact Woo product and its stock-managed pool',()=>{
  const snapshot={deviceId:device,canSell:true,canWholesale:false,leaseExpiresAt:expiry,
    catalog,wholesalePrices:[],grants:[grants[1]]};
  assert.equal(bootstrapSchema.safeParse(snapshot).success,true);
  assert.equal(bootstrapSchema.safeParse({...snapshot,grants:[{...grants[1],stockKey:'200:201',variationId:201}]}).success,false,
    'Parent-managed Blue variation does not own an independent 200:201 pool.');
  assert.equal(bootstrapSchema.safeParse({...snapshot,grants:[{...grants[1],stockKey:'101:201',productId:101,variationId:201}]}).success,false,
    'A variation belonging to a different parent cannot authorize checkout.');
});

test('no credential or sale without online enrollment, and only reserved pools appear sellable',async t=>{
  const f=fixture();t.after(()=>f.close());
  assert.equal(f.store.session().config.writesEnabled,false);
  assert.throws(()=>f.store.prepare(saleInput()),{code:'LOGIN_REQUIRED'});
  f.store.put('deviceId',device);
  await f.store.connect({origin:'https://trading.mansutrendzgh.com',username:'owner',password:'Super long offline passphrase 2026!'});
  const publicView=f.store.catalog();
  assert.equal(publicView.products[0].stock,2);
  assert.equal(publicView.products[1].variations[0].stock,3);
  assert.equal(publicView.products[1].variations[1].stock,3); // one SHARED parent pool, not six units.
  assert.equal(f.store.session().config.writesEnabled,true);
  assert.doesNotMatch(fs.readFileSync(path.join(f.dir,'desktop-ledger.sqlite')).toString('utf8'),/central-private-session/);
  assert.equal(f.store.wholesalePrices().prices[0].priceCents,750);
  f.store.logout();
  assert.throws(()=>f.store.catalog(),{code:'LOGIN_REQUIRED'});
  assert.equal(f.store.login({username:'owner',password:'Super long offline passphrase 2026!'}).user.role,'owner');
});

test('an existing grant can replenish an exhausted allocation while the approved lease is valid',async t=>{
  const f=await connected(t);
  f.db.prepare('UPDATE allocations SET remaining=0').run();
  assert.equal(f.store.session().config.writesEnabled,false);
  await f.store.allocate({idempotencyKey:randomUUID(),productId:101,variationId:0,quantity:1});
  assert.equal(f.store.session().config.writesEnabled,true);
  assert.equal(f.store.catalog().products[0].stock,3); // Mock central grant: original 2 plus 1 newly reserved.
});

test('atomic local cash commit, one shared pool, idempotent retry, durable queue and rollback on failure',async t=>{
  const f=await connected(t);
  assert.throws(()=>f.store.prepare(saleInput(randomUUID(),[{productId:200,variationId:201,quantity:2},{productId:200,variationId:202,quantity:2}])),
    {code:'ALLOCATED_STOCK_CHANGED'}); // Two options share ONE parent-managed pool of three.
  const draft=f.store.prepare(saleInput(randomUUID(),[{productId:200,variationId:201,quantity:2},{productId:200,variationId:202,quantity:1}]));
  const receipt=f.store.pay(draft.id,{method:'cash',tendered:4000,confirmed:true,reference:''});
  assert.equal(receipt.total,3500);
  assert.equal(receipt.changeDue,500);
  assert.equal(f.db.prepare("SELECT remaining FROM allocations WHERE stock_key='200:0'").get().remaining,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM movements').get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n,1);
  assert.equal(f.store.pay(draft.id,{method:'cash',tendered:4000,confirmed:true}).id,receipt.id);
  assert.throws(()=>f.store.pay(draft.id,{method:'cash',tendered:4200,confirmed:true}),{code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,1);
  const failing=f.store.prepare(saleInput());
  f.db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON queue BEGIN SELECT RAISE(ABORT,'test queue failure'); END;");
  assert.throws(()=>f.store.pay(failing.id,{method:'cash',tendered:1200,confirmed:true}),/test queue failure/);
  assert.equal(f.db.prepare("SELECT remaining FROM allocations WHERE stock_key='101:0'").get().remaining,2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM movements').get().n,1);
  f.db.exec('DROP TRIGGER fail_queue');
  const cash=f.store.pay(failing.id,{method:'cash',tendered:1200,confirmed:true});
  assert.equal(cash.total,1200);
  assert.equal(f.db.prepare("SELECT remaining FROM allocations WHERE stock_key='101:0'").get().remaining,1);
  assert.doesNotMatch(fs.readFileSync(path.join(f.dir,'desktop-ledger.sqlite')).toString('utf8'),/Product 101/);
});

test('timeout never drops a completed sale; retries use the original ID and block later events',async t=>{
  const f=await connected(t);const draft=f.store.prepare(saleInput());f.store.pay(draft.id,{method:'cash',tendered:1200,confirmed:true});
  f.failSync=true;
  let status=await f.store.sync();
  assert.equal(status.pending,1);assert.equal(status.rows[0].state,'retry');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,1);
  f.failSync=false;
  status=await f.store.sync(true);
  assert.equal(status.pending,0);assert.equal(status.rows[0].state,'acked');
  assert.equal(f.store.sale(draft.id).wooOrderId,9001);
  assert.equal(f.syncCalls,2);
  assert.equal((await f.store.sync()).pending,0);
});

test('expired stock lease and pending cash do not block online re-sign-in or replace local stock',async t=>{
  const f=await connected(t);
  const draft=f.store.prepare(saleInput());f.store.pay(draft.id,{method:'cash',tendered:1200,confirmed:true});
  assert.equal(f.db.prepare("SELECT remaining FROM allocations WHERE stock_key='101:0'").get().remaining,1);
  const past=new Date(Date.now()-60000).toISOString();
  f.store.put('leaseExpiresAt',past);
  f.db.prepare('UPDATE staff SET offline_until=? WHERE id=?').run(past,ownerId);
  f.store.logout();
  assert.throws(()=>f.store.login({username:'owner',password:'Super long offline passphrase 2026!'}),{code:'OFFLINE_LOGIN_EXPIRED'});
  // Woo may be down or its allocation has changed. Re-authenticate for sync
  // WITHOUT asking for/using a new grant, even after the old lease expires.
  f.failBootstrap=true;
  const reconnected=await f.store.connect({origin:TRADING_ORIGIN,username:'owner',password:'Super long offline passphrase 2026!'});
  assert.equal(reconnected.user.role,'owner');
  assert.equal(reconnected.config.writesEnabled,false);
  assert.equal(f.bootstrapCalls,1);
  assert.equal(f.db.prepare("SELECT remaining FROM allocations WHERE stock_key='101:0'").get().remaining,1);
  assert.equal(f.store.queueStatus().pending,1);
  assert.throws(()=>f.store.prepare(saleInput()),{code:'OFFLINE_CHECKOUT_LOCKED'});
  await assert.rejects(()=>f.store.refresh(),{code:'PENDING_LOCAL_SALES'});
  assert.equal(f.bootstrapCalls,1);
  assert.equal((await f.store.sync(true)).pending,0);
  assert.equal(f.store.sale(draft.id).wooOrderId,9001);
  assert.equal(f.store.session().config.writesEnabled,false,'Only an explicit clean Woo refresh can re-authorize selling.');
});

test('a sale committed during an in-flight Woo refresh cannot be overwritten by the old snapshot',async t=>{
  const f=await connected(t);const draft=f.store.prepare(saleInput());
  const remote=f.remote.request.bind(f.remote);
  f.remote.request=async (...args)=>{
    const result=await remote(...args);
    if(args[2].startsWith('/desktop/bootstrap'))f.store.pay(draft.id,{method:'cash',tendered:1200,confirmed:true});
    return result;
  };
  await assert.rejects(()=>f.store.refresh(),{code:'PENDING_LOCAL_SALES'});
  assert.equal(f.db.prepare("SELECT remaining FROM allocations WHERE stock_key='101:0'").get().remaining,1);
  assert.equal(f.store.queueStatus().pending,1);
  assert.equal(f.store.sale(draft.id).syncState,'pending');
});

test('online re-sign-in racing a cash commit locks new sales without losing that receipt',async t=>{
  const f=await connected(t);const draft=f.store.prepare(saleInput());
  const remote=f.remote.request.bind(f.remote);
  f.remote.request=async (...args)=>{
    const result=await remote(...args);
    if(args[2].startsWith('/desktop/bootstrap'))f.store.pay(draft.id,{method:'cash',tendered:1200,confirmed:true});
    return result;
  };
  const session=await f.store.connect({origin:TRADING_ORIGIN,username:'owner',password:'Super long offline passphrase 2026!'});
  assert.equal(session.config.writesEnabled,false);
  assert.equal(f.db.prepare("SELECT remaining FROM allocations WHERE stock_key='101:0'").get().remaining,1);
  assert.equal(f.store.queueStatus().pending,1);
  assert.equal((await f.store.sync(true)).pending,0);
  assert.equal(f.store.sale(draft.id).wooOrderId,9001);
  assert.equal(f.store.session().config.writesEnabled,false);
});

test('wholesale approved prices are private and returns require a manager, refund cash and restore only allocated units',async t=>{
  const f=await connected(t);
  const draft=f.store.prepare({ ...saleInput(), saleType:'wholesale',wholesaleApproved:true,buyerName:'Trade buyer',
    items:[{productId:101,variationId:0,quantity:1,agreedUnitPrice:750}] });
  const sale=f.store.pay(draft.id,{method:'cash',tendered:750,confirmed:true});
  const key=randomUUID();
  const input={ idempotencyKey:key,saleId:sale.id,items:[{productId:101,variationId:0,quantity:1}],reason:'Customer returned item',cashRefunded:true };
  const result=f.store.returnSale(input);
  assert.equal(result.sale.status,'returned_local_pending_sync');
  assert.equal(result.sale.refunded,750);
  assert.equal(f.db.prepare("SELECT remaining FROM allocations WHERE stock_key='101:0'").get().remaining,2);
  assert.equal(f.store.returnSale(input).returnId,key);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n,2);
  assert.throws(()=>f.store.returnSale({ ...input,idempotencyKey:randomUUID() }),{status:409});
  f.db.prepare('UPDATE staff SET role=? WHERE id=?').run('cashier',ownerId);
  f.store.logout();f.store.login({username:'owner',password:'Super long offline passphrase 2026!'});
  assert.throws(()=>f.store.returnSale({ ...input,idempotencyKey:randomUUID() }),{code:'ROLE_DENIED'});
  assert.throws(()=>f.store.wholesalePrices(),{code:'ROLE_DENIED'});
});

test('new offline checkout is cash-only; unverified MoMo cannot consume reserved goods',async t=>{
  const f=await connected(t);const draft=f.store.prepare(saleInput());
  assert.deepEqual(f.store.session().config.paymentMethods,['cash']);
  assert.throws(()=>f.store.pay(draft.id,{method:'momo',reference:'merchant-notice-only',confirmed:true}),{code:'OFFLINE_CASH_ONLY'});
  assert.throws(()=>f.store.pay(draft.id,{method:'card',reference:'terminal-ref',confirmed:true}),{code:'OFFLINE_CASH_ONLY'});
  assert.equal(f.db.prepare("SELECT remaining FROM allocations WHERE stock_key='101:0'").get().remaining,2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM queue').get().n,0);
});

test('expiry and clock reversal lock selling while preserving completed sales and pending sync',async t=>{
  const f=await connected(t);const draft=f.store.prepare(saleInput());
  f.store.pay(draft.id,{method:'cash',tendered:1200,confirmed:true});
  f.store.put('lastClock',String(Date.now()+3600000));
  assert.equal(f.store.session().config.writesEnabled,false);
  assert.throws(()=>f.store.prepare(saleInput()),{code:'CLOCK_REVIEW'});
  assert.equal(f.store.sales().sales.length,1);
  assert.equal(f.store.queueStatus().pending,1);
});

test('uncertain Woo allocation keeps the SAME durable request ID across a desktop restart',async t=>{
  const f=await connected(t);
  const input={idempotencyKey:randomUUID(),productId:101,variationId:0,quantity:1};
  f.loseAllocationOnce=true;
  await assert.rejects(()=>f.store.allocate(input),{code:'RESERVATION_UNCERTAIN'});
  assert.equal(f.reservations,1); // Woo already held this stock, but its acknowledgement was lost.
  assert.equal(f.store.session().pendingAllocation.idempotencyKey,input.idempotencyKey);
  assert.equal(f.store.session().pendingAllocation.stockKey,'101:0');
  await assert.rejects(()=>f.store.allocate({...input,idempotencyKey:randomUUID()}),{code:'ALLOCATION_UNCERTAIN'});
  assert.equal(f.allocationCalls,1);
  f.reopen();f.store.login({username:'owner',password:'Super long offline passphrase 2026!'});
  assert.equal(f.store.session().pendingAllocation.idempotencyKey,input.idempotencyKey);
  await f.store.allocate(input);
  assert.equal(f.store.session().pendingAllocation,null);
  assert.equal(f.db.prepare("SELECT remaining,revision FROM allocations WHERE stock_key='101:0'").get().remaining,3);
  assert.equal(f.reservations,1);assert.equal(f.allocationCalls,2);
});

test('an integrity-checked local snapshot preserves pending events but needs the original DPAPI profile',async t=>{
  const f=await connected(t);
  const draft=f.store.prepare(saleInput());f.store.pay(draft.id,{method:'cash',tendered:1200,confirmed:true});
  const result=await f.store.backupLedger();
  assert.equal(result.verified,true);assert.equal(path.dirname(result.path),path.join(f.dir,'backups'));
  if(process.platform!=='win32') assert.equal(fs.statSync(result.path).mode & 0o777,0o600);
  const copy=new DatabaseSync(result.path,{readOnly:true});
  try {
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM queue WHERE state='pending'").get().n,1);
    const row=copy.prepare('SELECT payload FROM sales WHERE id=?').get(draft.id);
    assert.equal(f.store.unseal(row.payload).total,1200);
  } finally { copy.close(); }
  f.db.prepare('UPDATE staff SET role=? WHERE id=?').run('cashier',ownerId);
  f.store.logout();f.store.login({username:'owner',password:'Super long offline passphrase 2026!'});
  await assert.rejects(()=>f.store.backupLedger(),{code:'ROLE_DENIED'});
});
