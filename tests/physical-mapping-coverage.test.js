import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPhysicalMappingCoverage } from '../server/physical-mapping-coverage.js';
import { createApp } from '../server/app.js';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';

const fixed = '2026-11-15T12:00:00.000Z';
const physical = (items, overrides = {}) => ({
  source:'in-store-physical-stock-snapshot',manifestHash:'a'.repeat(64),
  items,summary:{items:items.length},...overrides,
});
const woo = (products, overrides = {}) => ({
  source:'woocommerce',fetchedAt:fixed,products,complete:true,stale:false,
  isDemo:false,...overrides,
});
const row = (sku, reportRow, status='available') => ({
  sku,reportRow,status,name:'PRIVATE PRODUCT',priceCents:15000,
  stock:17,reportedQuantity:17,
});

test('every historical physical row receives exactly one review state, not a stock approval',()=>{
  const items=[
    row(' ab ',1),row('SIZE-M',2),row('DUP',3),row('dup',4),
    row('QUAR',5,'review'),row('',6),row('PARENT',7),
    row('ALSO',8),row('NOTON',9),row('REUSED',10),
  ];
  const products=[
    {type:'simple',id:30,sku:'AB'},
    {type:'simple',id:50,sku:'DUP'},
    {type:'simple',id:51,sku:'QUAR'},
    {type:'variable',id:40,sku:'PARENT',variations:[
      {id:41,sku:'SIZE-M'},{id:42,sku:'ALSO'},{id:42,sku:'REUSED'},
    ]},
  ];
  const result=listPhysicalMappingCoverage(physical(items),woo(products),
    {page:1,pageSize:25},Date.parse(fixed));
  assert.equal(result.kind,'read-only-physical-mapping-coverage');
  assert.equal(result.totalPhysical,10);
  assert.equal(result.total,10);
  assert.equal(result.rows.length,10);
  assert.deepEqual(result.counts,{
    provisional_match:2,
    held:1,
    missing_physical_sku:1,
    duplicate_physical_sku:2,
    parent_sku_only:1,
    missing_on_website:1,
    ambiguous_website_identity:2,
  });
  assert.equal(result.rows[0].productId,30);
  assert.equal(result.rows[1].variationId,41);
  assert.equal(result.rows[7].productId,null);
  assert.equal(result.rows[7].websiteCandidates,1);
  assert.equal(result.rows[6].status,'parent_sku_only');
  assert.equal(result.auditOnly,true);
  assert.equal(result.checkoutAuthorized,false);
  assert.equal(result.sharedStockVerified,false);
  assert.equal(result.mappingApproved,false);
  assert.equal(result.evidenceVerified,true);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE PRODUCT|priceCents|reportedQuantity|stock":17/);
});

test('duplicate Woo option SKU, invalid variation identity and parent collision cannot become matches',()=>{
  const report=listPhysicalMappingCoverage(physical([
    row('DUPW',1),row('NO-ID',2),row('PARENT',3),
  ]),woo([
    {type:'simple',id:50,sku:'DUPW'},
    {type:'variable',id:60,sku:'PARENT',variations:[
      {id:61,sku:'DUPW'}, {id:null,sku:'NO-ID'}, {id:62,sku:'PARENT'},
    ]},
  ]),{},Date.parse(fixed));
  assert.equal(report.counts.provisional_match,0);
  assert.equal(report.counts.ambiguous_website_identity,3);
  assert.equal(report.rows[1].productId,null);
  assert.equal(report.rows[2].productId,null);
});

test('unverified sources still show provisional observations but never approve mapping',()=>{
  const result=listPhysicalMappingCoverage(physical([row('A',1)],{
    manifestHash:'tampered',
  }),woo([{type:'simple',id:22,sku:'A'}],{
    complete:false,stale:true,
  }),{},Date.parse(fixed)+150000);
  assert.equal(result.evidenceVerified,false);
  assert.equal(result.counts.provisional_match,1);
  assert.equal(result.mappingApproved,false);
  assert.equal(result.physicalManifestSha256,null);
});

test('mapping search, class filtering, source order, pagination and snapshot change',()=>{
  const items=Array.from({length:63},(_,i)=>row('ITEM-'+String(i).padStart(3,'0'),i+1));
  const website=woo([{type:'simple',id:7,sku:'ITEM-010'}]);
  const old=physical(items);
  const first=listPhysicalMappingCoverage(old,website,{pageSize:25},Date.parse(fixed));
  assert.equal(first.total,63);
  assert.equal(first.pages,3);
  assert.equal(first.rows.length,25);
  assert.equal(first.hasMore,true);
  assert.equal(first.rows[0].reportRow,1);
  const last=listPhysicalMappingCoverage(old,website,{page:3,pageSize:25},Date.parse(fixed));
  assert.equal(last.rows.length,13);
  assert.equal(last.hasMore,false);
  assert.equal(last.snapshotRef,first.snapshotRef);
  const matched=listPhysicalMappingCoverage(old,website,{
    status:'provisional_match',search:'ITEM-010',
  },Date.parse(fixed));
  assert.equal(matched.total,1);
  assert.equal(matched.rows[0].productId,7);
  const byRow=listPhysicalMappingCoverage(old,website,{search:'25'},Date.parse(fixed));
  assert.ok(byRow.rows.some(r=>r.reportRow===25));
  assert.notEqual(first.snapshotRef,listPhysicalMappingCoverage(old,woo([
    {type:'simple',id:7,sku:'ITEM-011'},
  ]),{},Date.parse(fixed)).snapshotRef);
  assert.notEqual(first.snapshotRef,listPhysicalMappingCoverage(physical(items,{
    manifestHash:'b'.repeat(64),
  }),website,{},Date.parse(fixed)).snapshotRef);
  assert.equal(first.checkoutAuthorized,false);
});

test('mapping filters fail closed on unknown status, oversized requests or malformed pagination',()=>{
  const p=physical([row('A',1)]);
  const w=woo([{type:'simple',id:30,sku:'A'}]);
  for(const options of [
    {status:'approved'},{status:'imported'},{status:'__proto__'},
    {page:0},{page:-1},{page:10001},{pageSize:0},{pageSize:51},
    {search:'x'.repeat(65)},{page:'2'},
  ])assert.throws(()=>listPhysicalMappingCoverage(p,w,options,Date.parse(fixed)),RangeError);
});

test('owner/manager can read physical mapping; cashier/public denied; Woo and sales untouched',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-physical-mapping-'));
  const source=loadInStoreSnapshot();
  const sku=source.items.find(item=>item.status==='available'&&item.sku)?.sku;
  assert.ok(sku,'Signed fixture must contain one eligible physical SKU');
  let websiteSku=sku;
  const calls=[];
  const api={
    async products(){
      calls.push('GET products');
      return {data:[{
        id:901,name:'Synthetic',type:'simple',sku:websiteSku,
        price:'99.00',manage_stock:true,stock_quantity:1,
        stock_status:'instock',backorders:'no',purchasable:true,
        images:[],categories:[],
      }],pages:1,total:1};
    },
    async variations(){throw Error('Unexpected variation read');},
    async order(){throw Error('Woo order read must not occur');},
    async createOrder(){throw Error('Woo order write must not occur');},
    async updateOrder(){throw Error('Woo order write must not occur');},
  };
  const env={
    NODE_ENV:'test',POS_MODE:'live',POS_LIVE_READ_ONLY:'true',
    POS_ALLOW_LIVE_WRITES:'false',WOO_BASE_URL:'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY:'ck_synthetic',WOO_CONSUMER_SECRET:'cs_synthetic',
    POS_PUBLIC_ORIGIN:'https://pos.mansutrendzgh.com',
    POS_DATA_DIR:dir,POS_OWNER_USERNAME:'owner',
    POS_OWNER_PASSWORD:'synthetic-pilot-password-123',
  };
  const {app,db,catalog}=createApp({env,api,logger:{
    debug(){},info(){},warn(){},error(){},
  }});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    db.close();
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const base='http://127.0.0.1:'+server.address().port+'/api';
  const request=async(route,token,method='GET',body)=>{
    const response=await fetch(base+route,{
      method,
      headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    return {status:response.status,data:await response.json(),cache:response.headers.get('cache-control')};
  };
  assert.equal((await request('/stock-safety/physical-mapping')).status,401);
  const login=await request('/auth/login',null,'POST',
    {username:'owner',password:'synthetic-pilot-password-123'});
  assert.equal(login.status,200);
  const token=login.data.token;
  assert.equal((await request('/auth/password',token,'POST',{
    currentPassword:'synthetic-pilot-password-123',
    newPassword:'synthetic-rotated-password-123',
  })).status,200);

  const first=await request('/stock-safety/physical-mapping?page=1',token);
  assert.equal(first.status,200);
  assert.equal(first.data.totalPhysical,source.items.length);
  assert.equal(first.data.counts.provisional_match,1);
  assert.equal(first.data.rows.length,25);
  assert.equal(first.data.checkoutAuthorized,false);
  assert.equal(first.data.mappingApproved,false);
  assert.equal(first.cache,'no-store');

  const next=await request('/stock-safety/physical-mapping?page=2&expectedRef='+first.data.snapshotRef,token);
  assert.equal(next.status,200);
  assert.equal(next.data.snapshotRef,first.data.snapshotRef);
  assert.equal((await request('/stock-safety/physical-mapping?status=approved',token)).status,400);
  assert.equal((await request('/stock-safety/physical-mapping?pageSize=500',token)).status,400);
  assert.equal((await request('/stock-safety/physical-mapping?unknown=1',token)).status,400);
  const actor=db.prepare("SELECT id FROM users WHERE username='owner'").get();
  db.prepare("UPDATE users SET role='manager' WHERE id=?").run(actor.id);
  assert.equal((await request('/stock-safety/physical-mapping',token)).status,200);
  db.prepare("UPDATE users SET role='cashier' WHERE id=?").run(actor.id);
  assert.equal((await request('/stock-safety/physical-mapping',token)).status,403);
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(actor.id);

  websiteSku='CHANGED-WEBSITE-SKU';
  catalog.cache.fetchedAt='2000-01-01T00:00:00.000Z';
  const conflict=await request('/stock-safety/physical-mapping?page=2&expectedRef='+first.data.snapshotRef,token);
  assert.equal(conflict.status,409);
  assert.equal(conflict.data.code,'MAPPING_SNAPSHOT_CHANGED');
  assert.deepEqual(calls,['GET products','GET products']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n,0);
});
