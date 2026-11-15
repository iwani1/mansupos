import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditCrossChannelSkus, listCrossChannelSkuFindings } from '../server/cross-channel-sku-audit.js';
import { createApp } from '../server/app.js';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';

const time='2026-11-15T12:00:00.000Z';
const physical=(items,other={})=>({
  source:'in-store-physical-stock-snapshot',
  manifestHash:'a'.repeat(64),
  summary:{items:items.length},
  items,
  ...other,
});
const woo=(products,other={})=>({
  source:'woocommerce',complete:true,stale:false,isDemo:false,
  fetchedAt:time,products,...other,
});
const product=(id,sku)=>({id,sku,type:'simple'});
const row=(sku,status='available')=>({sku,status});

test('exact SKUs produce review candidates, never shared stock approval',()=>{
  const report=auditCrossChannelSkus(
    physical([row(' A1 '),row('B2','review'),row('C3')]),
    woo([
      product(10,'a1'),
      {id:20,type:'variable',sku:'PARENT-SKU',variations:[
        {id:21,sku:'c3'},{id:22,sku:''},
      ]},
      product(30,'Z9'),
    ]),Date.parse(time));
  assert.equal(report.matchedPhysical,2);
  assert.equal(report.physical.quarantined,1);
  assert.equal(report.physical.eligible,2);
  assert.equal(report.website.missingVariationSkus,1);
  assert.equal(report.website.parentSkusWithoutOption,1);
  assert.equal(report.issueCounts.physical_quarantined,1);
  assert.equal(report.issueCounts.woo_variation_missing_sku,1);
  assert.equal(report.issueCounts.woo_parent_sku_requires_variation_mapping,1);
  assert.equal(report.issueCounts.woo_not_in_physical_snapshot,1);
  assert.equal(report.checkoutAuthorized,false);
  assert.equal(report.sharedStockVerified,false);
  assert.equal(report.auditOnly,true);
  assert.equal(report.evidenceVerified,true);
  assert.equal(report.physical.manifestSha256,'a'.repeat(64));
});

test('identical SKU across two Woo options is ambiguous and never a match',()=>{
  const report=auditCrossChannelSkus(physical([row('123')]),
    woo([product(1,'123'),{id:2,type:'variable',variations:[{id:3,sku:'123'}]}]),
    Date.parse(time));
  assert.equal(report.matchedPhysical,0);
  assert.equal(report.issueCounts.ambiguous_woo_sku,1);
  assert.equal(report.issueCounts.duplicate_woo_sku,1);
  assert.equal(report.checkoutAuthorized,false);
});

test('quarantined and duplicate physical SKUs cannot qualify as matches',()=>{
  const report=auditCrossChannelSkus(
    physical([row('X','review'),row('Y'),row('y'),row('')]),
    woo([product(1,'X'),product(2,'Y')]),Date.parse(time));
  assert.equal(report.matchedPhysical,0);
  assert.equal(report.issueCounts.physical_quarantined,1);
  assert.equal(report.issueCounts.physical_duplicate_sku,1);
  assert.equal(report.issueCounts.physical_missing_sku,1);
  assert.equal(report.issueCounts.woo_not_in_physical_snapshot,1);
});

test('stale or unverified source never passes evidence verification',()=>{
  const report=auditCrossChannelSkus(
    physical([row('X')],{manifestHash:'changed'}),
    woo([product(1,'X')],{complete:false,stale:true}),
    Date.parse(time)+150000);
  assert.equal(report.evidenceVerified,false);
  assert.equal(report.issueCounts.physical_snapshot_unverified,1);
  assert.equal(report.issueCounts.woo_snapshot_unverified,1);
  assert.equal(report.physical.manifestSha256,null);
  assert.equal(report.checkoutAuthorized,false);
  assert.equal(report.matchedPhysical,1);
});

test('owner examples stay bounded, identifiers only, and include distinct issue types',()=>{
  const rows=Array.from({length:120},(_,i)=>row('PRIVATE-'+i,'review'));
  rows.push(row('ONLY-PHYSICAL'));
  const result=auditCrossChannelSkus(
    physical(rows),
    woo([product(4,'ONLY-WOO')]),Date.parse(time));
  assert.ok(result.examples.length<=20);
  assert.ok(result.examples.some(e=>e.code==='physical_quarantined'));
  assert.ok(result.examples.some(e=>e.code==='physical_not_in_published_woo'));
  assert.ok(result.examples.some(e=>e.code==='woo_not_in_physical_snapshot'));
  assert.equal(JSON.stringify(result).includes('Customer name'),false);
});

test('source matching endpoint requires owner/manager, never uses Woo writes',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-sku-audit-'));
  const first=loadInStoreSnapshot().items.find(item=>item.status==='available'&&item.sku);
  assert.ok(first,'Signed source should contain usable physical SKU.');
  const calls=[];
  const api={
    async products(){calls.push('GET products');return {data:[{
      id:600001,name:'Synthetic',type:'simple',sku:first.sku,
      status:'publish',price:'100.00',manage_stock:true,
      stock_quantity:1,stock_status:'instock',backorders:'no',
      purchasable:true,images:[],categories:[],
    }],pages:1,total:1};},
    async variations(){throw Error('Unexpected variation query');},
    async order(){throw Error('Woo orders forbidden');},
    async createOrder(){throw Error('Woo writes forbidden');},
  };
  const env={
    NODE_ENV:'test',POS_MODE:'live',POS_LIVE_READ_ONLY:'true',
    POS_ALLOW_LIVE_WRITES:'false',WOO_BASE_URL:'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY:'ck_fake',WOO_CONSUMER_SECRET:'cs_fake',
    POS_PUBLIC_ORIGIN:'https://pos.mansutrendzgh.com',
    POS_DATA_DIR:dir,POS_OWNER_USERNAME:'owner',
    POS_OWNER_PASSWORD:'synthetic-pilot-password-123',
  };
  const {app,db}=createApp({env,api,logger:{
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
    return {status:response.status,data:await response.json()};
  };
  assert.equal((await request('/stock-safety/source-match')).status,401);
  const login=await request('/auth/login',null,'POST',
    {username:'owner',password:'synthetic-pilot-password-123'});
  assert.equal(login.status,200);
  const token=login.data.token;
  assert.equal((await request('/auth/password',token,'POST',{
    currentPassword:'synthetic-pilot-password-123',
    newPassword:'synthetic-rotated-password-123',
  })).status,200);
  const owner=await request('/stock-safety/source-match',token);
  assert.equal(owner.status,200);
  assert.equal(owner.data.kind,'read-only-cross-channel-sku-audit');
  assert.equal(owner.data.matchedPhysical,1);
  assert.equal(owner.data.physical.total,loadInStoreSnapshot().items.length);
  assert.equal(owner.data.evidenceVerified,true);
  assert.equal(owner.data.checkoutAuthorized,false);
  assert.equal(owner.data.sharedStockVerified,false);
  const ownerRow=db.prepare("SELECT id FROM users WHERE username='owner'").get();
  db.prepare('UPDATE users SET role=? WHERE id=?').run('manager',ownerRow.id);
  assert.equal((await request('/stock-safety/source-match',token)).status,200);
  db.prepare('UPDATE users SET role=? WHERE id=?').run('cashier',ownerRow.id);
  assert.equal((await request('/stock-safety/source-match',token)).status,403);
  assert.deepEqual(calls,['GET products','GET products']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n,0);
});

test('full review queue includes all issues, bounds pages and search, never inventory actions',()=>{
  const rows=Array.from({length:117},(_,index)=>({
    ...row('UNMATCHED-'+String(index).padStart(3,'0')),
    reportRow:index+1,
  }));
  rows.push({...row('DUP'),reportRow:118},{...row('dup'),reportRow:119});
  const old=physical(rows);
  const website=woo([product(900,'ONLY-WOO')]);
  const report=auditCrossChannelSkus(old,website,Date.parse(time));
  const all=listCrossChannelSkuFindings(old,website,{page:1,pageSize:25},Date.parse(time));
  assert.equal(all.kind,'read-only-cross-channel-sku-review');
  assert.equal(all.checkoutAuthorized,false);
  assert.equal(all.sharedStockVerified,false);
  assert.equal(all.auditOnly,true);
  assert.equal(all.total,Object.values(report.issueCounts).reduce((a,b)=>a+b,0));
  assert.equal(all.total,119);
  assert.equal(all.pages,5);
  assert.equal(all.findings.length,25);
  assert.equal(all.hasMore,true);
  assert.equal(all.findings[0].reportRow,1);
  const last=listCrossChannelSkuFindings(old,website,{page:5,pageSize:25},Date.parse(time));
  assert.equal(last.findings.length,19);
  assert.equal(last.hasMore,false);
  assert.equal(last.snapshotRef,all.snapshotRef);
  const search=listCrossChannelSkuFindings(old,website,{
    page:1,pageSize:25,search:'unmatched-013',
  },Date.parse(time));
  assert.equal(search.total,1);
  assert.equal(search.findings[0].reportRow,14);
  const filtered=listCrossChannelSkuFindings(old,website,{
    code:'physical_not_in_published_woo',page:2,pageSize:50,
  },Date.parse(time));
  assert.equal(filtered.total,117);
  assert.equal(filtered.findings.length,50);
  assert.equal(filtered.findings[0].sku,'UNMATCHED-050');
  assert.equal(JSON.stringify(filtered).includes('cashierName'),false);
});

test('review queue filtering distinguishes variation, parent, and ambiguous SKUs',()=>{
  const old=physical([{...row('M'),reportRow:9}]);
  const website=woo([
    {id:300,type:'variable',sku:'PARENT',variations:[
      {id:301,sku:'M'},{id:302,sku:'M'},{id:303,sku:''},
    ]},
  ]);
  const dup=listCrossChannelSkuFindings(old,website,{
    code:'duplicate_woo_sku',
  },Date.parse(time));
  assert.equal(dup.total,1);
  assert.equal(dup.findings[0].variationId,301);
  const ambiguous=listCrossChannelSkuFindings(old,website,{
    code:'ambiguous_woo_sku',
  },Date.parse(time));
  assert.equal(ambiguous.total,1);
  assert.equal(ambiguous.findings[0].reportRow,9);
  const missing=listCrossChannelSkuFindings(old,website,{
    code:'woo_variation_missing_sku',
  },Date.parse(time));
  assert.equal(missing.total,1);
  assert.equal(missing.findings[0].variationId,303);
  const parent=listCrossChannelSkuFindings(old,website,{
    code:'woo_parent_sku_requires_variation_mapping',
  },Date.parse(time));
  assert.equal(parent.total,1);
  assert.equal(parent.findings[0].sku,'PARENT');
  assert.equal(parent.checkoutAuthorized,false);
});

test('review pagination rejects unknown filters and oversized requests',()=>{
  const old=physical([]);
  const website=woo([]);
  for(const options of [
    {code:'secret_status'},
    {page:0},{page:-3},{page:10001},
    {pageSize:0},{pageSize:51},{search:'x'.repeat(65)},
  ]){
    assert.throws(()=>listCrossChannelSkuFindings(old,website,options,Date.parse(time)),RangeError);
  }
  const a=listCrossChannelSkuFindings(old,website,{},Date.parse(time));
  const b=listCrossChannelSkuFindings(old,woo([product(3,'NEW')]),{},Date.parse(time));
  assert.notEqual(a.snapshotRef,b.snapshotRef);
});

test('full SKU review route enforces owner/manager access and changed-snapshot conflict',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-sku-queue-'));
  const sourceRow=loadInStoreSnapshot().items.find(item=>item.sku && item.status==='available');
  let sku=sourceRow.sku;
  const calls=[];
  const api={
    async products(){
      calls.push('GET products');
      return {data:[{
        id:771,name:'Synthetic',type:'simple',sku,
        price:'42.00',manage_stock:true,stock_quantity:1,
        stock_status:'instock',backorders:'no',purchasable:true,
        images:[],categories:[],
      }],pages:1,total:1};
    },
    async variations(){throw Error('No variations expected');},
    async order(){throw Error('Woo order read is prohibited');},
    async createOrder(){throw Error('Woo order writes are prohibited');},
  };
  const env={
    NODE_ENV:'test',POS_MODE:'live',POS_LIVE_READ_ONLY:'true',
    POS_ALLOW_LIVE_WRITES:'false',WOO_BASE_URL:'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY:'ck_fake',WOO_CONSUMER_SECRET:'cs_fake',
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
    return {status:response.status,data:await response.json()};
  };
  assert.equal((await request('/stock-safety/source-review?page=1')).status,401);
  const login=await request('/auth/login',null,'POST',
    {username:'owner',password:'synthetic-pilot-password-123'});
  assert.equal(login.status,200);
  const token=login.data.token;
  assert.equal((await request('/auth/password',token,'POST',{
    currentPassword:'synthetic-pilot-password-123',
    newPassword:'synthetic-rotated-password-123',
  })).status,200);
  const first=await request('/stock-safety/source-review?page=1&pageSize=25',token);
  assert.equal(first.status,200);
  assert.equal(first.data.kind,'read-only-cross-channel-sku-review');
  assert.equal(first.data.checkoutAuthorized,false);
  assert.equal(first.data.sharedStockVerified,false);
  assert.equal(first.data.findings.length,25);
  assert.equal(first.data.websiteFetchedAt!=null,true);
  assert.equal(first.data.evidenceVerified,true);
  assert.equal(first.data.snapshotRef.length,64);
  const second=await request('/stock-safety/source-review?page=2&pageSize=25&expectedRef='+first.data.snapshotRef,token);
  assert.equal(second.status,200);
  assert.equal(second.data.page,2);
  assert.equal(second.data.snapshotRef,first.data.snapshotRef);
  assert.equal((await request('/stock-safety/source-review?code=unrecognized',token)).status,400);
  assert.equal((await request('/stock-safety/source-review?pageSize=5000',token)).status,400);
  assert.equal((await request('/stock-safety/source-review?extra=ignored',token)).status,400);
  const ownerRow=db.prepare("SELECT id FROM users WHERE username='owner'").get();
  db.prepare("UPDATE users SET role='manager' WHERE id=?").run(ownerRow.id);
  assert.equal((await request('/stock-safety/source-review',token)).status,200);
  db.prepare("UPDATE users SET role='cashier' WHERE id=?").run(ownerRow.id);
  assert.equal((await request('/stock-safety/source-review',token)).status,403);
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(ownerRow.id);
  sku='UPDATED-NEW-SKU';
  catalog.cache.fetchedAt='2000-01-01T00:00:00.000Z';
  const conflict=await request('/stock-safety/source-review?page=2&expectedRef='+first.data.snapshotRef,token);
  assert.equal(conflict.status,409);
  assert.equal(conflict.data.code,'SKU_REVIEW_SNAPSHOT_CHANGED');
  assert.deepEqual(calls,['GET products','GET products']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n,0);
});
