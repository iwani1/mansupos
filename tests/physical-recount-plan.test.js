import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planPhysicalRecounts } from '../server/physical-recount-plan.js';
import { blankPhysicalRecountCsv } from '../src/blank-recount-csv.js';
import { createApp } from '../server/app.js';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';

const clock=Date.parse('2026-11-15T12:00:00.000Z');
const physical=(items,other={})=>({
  source:'in-store-physical-stock-snapshot',
  manifestHash:'a'.repeat(64),summary:{items:items.length},items,...other,
});
const woo=(products,other={})=>({
  source:'woocommerce',fetchedAt:new Date(clock).toISOString(),
  complete:true,stale:false,isDemo:false,products,...other,
});
const item=(sku,reportRow,status='available')=>({
  sku,reportRow,status,name:'SENSITIVE PRIVATE PRODUCT',
  stock:900,priceCents:40000,reportedQuantity:900,
});

test('count planner includes every historical row, with P0-P2 priorities but zero count approvals',()=>{
  const items=[
    item('AB',1),item('HOLD',2,'review'),item('DUP',3),
    item('dup',4),item('',5),item('PARENT',6),
    item('MISSING',7),item('AMB',8),item('SIZE-M',9),
  ];
  const products=[
    {type:'simple',id:12,sku:'ab'},
    {type:'simple',id:13,sku:'AMB'},
    {type:'simple',id:14,sku:'AMB'},
    {type:'variable',id:16,sku:'PARENT',variations:[
      {id:17,sku:'SIZE-M'},
    ]},
  ];
  const result=planPhysicalRecounts(physical(items),woo(products),{},clock);
  assert.equal(result.kind,'read-only-physical-recount-plan');
  assert.equal(result.totalPhysical,9);
  assert.equal(result.total,9);
  assert.deepEqual(result.priorityCounts,{P0:5,P1:2,P2:2});
  assert.equal(result.tasks[0].priority,'P2');
  assert.equal(result.tasks[1].priority,'P0');
  assert.equal(result.tasks[2].nextAction,'resolve_duplicate_physical_skus');
  assert.equal(result.tasks[5].nextAction,'verify_exact_size_colour_variation');
  assert.equal(result.tasks[7].nextAction,'resolve_ambiguous_woo_identity');
  assert.equal(result.tasks[8].candidateWooVariationId,17);
  assert.equal(result.evidenceVerified,true);
  assert.equal(result.checkoutAuthorized,false);
  assert.equal(result.sharedStockVerified,false);
  assert.equal(result.mappingApproved,false);
  assert.equal(result.stockImportAuthorized,false);
  assert.equal(result.freshPhysicalCountVerified,false);
  assert.equal(result.independentWitnessVerified,false);
  for(const task of result.tasks){
    assert.equal(task.physicalCountEvidenceRecorded,false);
    assert.equal(task.independentRecountEvidenceRecorded,false);
    assert.equal(task.ownerVerificationRecorded,false);
    assert.equal(task.stockImportAuthorized,false);
  }
  const data=JSON.stringify(result);
  assert.doesNotMatch(data,/SENSITIVE PRIVATE PRODUCT|priceCents|reportedQuantity|stock":900/);
});

test('stock-count review supports paging, fixed counts, filtering and stable snapshot tokens',()=>{
  const rows=Array.from({length:78},(_,i)=>item('SKU-'+String(i).padStart(3,'0'),i+1));
  const p=physical(rows);
  const w=woo([{type:'simple',id:110,sku:'SKU-006'}]);
  const first=planPhysicalRecounts(p,w,{},clock);
  assert.equal(first.page,1);
  assert.equal(first.pages,4);
  assert.equal(first.total,78);
  assert.equal(first.tasks.length,25);
  assert.equal(first.hasMore,true);
  const last=planPhysicalRecounts(p,w,{page:4,pageSize:25},clock);
  assert.equal(last.tasks.length,3);
  assert.equal(last.hasMore,false);
  assert.equal(last.snapshotRef,first.snapshotRef);
  assert.deepEqual(first.priorityCounts,{P0:0,P1:77,P2:1});
  const low=planPhysicalRecounts(p,w,{priority:'P2'},clock);
  assert.equal(low.total,1);
  assert.equal(low.tasks[0].reportRow,7);
  const byRow=planPhysicalRecounts(p,w,{search:'77'},clock);
  assert.equal(byRow.total,2);
  assert.equal(byRow.tasks[0].reportRow,77);
  const byAction=planPhysicalRecounts(p,w,{
    action:'review_missing_website_product',page:2,pageSize:50,
  },clock);
  assert.equal(byAction.total,77);
  assert.equal(byAction.tasks.length,27);
  assert.notEqual(first.snapshotRef,planPhysicalRecounts(p,
    woo([{type:'simple',id:110,sku:'SKU-007'}]),{},clock).snapshotRef);
  assert.notEqual(first.snapshotRef,planPhysicalRecounts(physical(rows,{
    manifestHash:'b'.repeat(64),
  }),w,{},clock).snapshotRef);
});

test('invalid count filters cannot bypass bounds or request a completed status',()=>{
  const p=physical([item('S1',1)]);
  const w=woo([]);
  for(const options of [
    {priority:'approved'},{priority:'P3'},{action:'stock_import'},
    {action:'recount_completed'},{page:0},{page:-1},
    {page:10001},{pageSize:0},{pageSize:51},
    {search:'x'.repeat(65)},{page:'2'},
  ]){
    assert.throws(()=>planPhysicalRecounts(p,w,options,clock),RangeError);
  }
});

test('blank worksheet includes only page source identities and EMPTY count fields; protects formula cells',()=>{
  const p=physical([item('=1+1',1),item('NORMAL',2)]);
  const report=planPhysicalRecounts(p,woo([]),{},clock);
  const csv=blankPhysicalRecountCsv(report);
  const lines=csv.trim().split('\r\n');
  assert.equal(lines.length,3);
  assert.match(lines[0],/Count 1 \(blank\)/);
  assert.match(lines[0],/Independent count 2 \(blank\)/);
  assert.ok(lines[1].includes(`"'=1+1"`),'CSV formula must be neutralized');
  assert.ok(lines[2].includes('"NORMAL"'));
  assert.doesNotMatch(csv,/SENSITIVE PRIVATE PRODUCT|"40000"|"900"|priceCents|reportedQuantity/);
  assert.equal((lines[1].match(/,/g)||[]).length,13);
  assert.throws(()=>blankPhysicalRecountCsv({...report,checkoutAuthorized:true}),Error);
  assert.throws(()=>blankPhysicalRecountCsv({...report,physicalManifestSha256:null}),Error);
  assert.throws(()=>blankPhysicalRecountCsv({...report,tasks:[{
    ...report.tasks[0],physicalCountEvidenceRecorded:true,
  }]}),Error);
});

test('recount plan marks source freshness as incomplete without manufacturing verified counts',()=>{
  const p=physical([item('S1',1)],{manifestHash:'unverified'});
  const w=woo([{type:'simple',id:20,sku:'S1'}],{stale:true,complete:false});
  const report=planPhysicalRecounts(p,w,{},clock+150000);
  assert.equal(report.evidenceVerified,false);
  assert.equal(report.priorityCounts.P2,1);
  assert.equal(report.freshPhysicalCountVerified,false);
  assert.equal(report.stockImportAuthorized,false);
  assert.throws(()=>blankPhysicalRecountCsv(report),Error);
});

test('recount planning endpoint is owner/manager-only and GET-only without stock or sales writes',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-recount-plan-'));
  const source=loadInStoreSnapshot();
  const sku=source.items.find(it=>it.sku&&it.status==='available')?.sku;
  assert.ok(sku,'The historical fixture must contain an eligible item');
  let websiteSku=sku;
  const calls=[];
  const api={
    async products(){
      calls.push('GET products');
      return {data:[{
        id:901,name:'Synthetic',sku:websiteSku,type:'simple',
        status:'publish',price:'100.00',purchasable:true,
        manage_stock:true,stock_quantity:3,stock_status:'instock',
        backorders:'no',images:[],categories:[],
      }],pages:1,total:1};
    },
    async variations(){throw Error('Unexpected variation GET');},
    async order(){throw Error('Woo order reads forbidden');},
    async createOrder(){throw Error('Woo order writes forbidden');},
    async updateOrder(){throw Error('Woo stock/order writes forbidden');},
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
    return {status:response.status,data:await response.json(),
      cache:response.headers.get('cache-control')};
  };
  assert.equal((await request('/stock-safety/recount-plan')).status,401);
  const login=await request('/auth/login',null,'POST',
    {username:'owner',password:'synthetic-pilot-password-123'});
  assert.equal(login.status,200);
  const token=login.data.token;
  assert.equal((await request('/auth/password',token,'POST',{
    currentPassword:'synthetic-pilot-password-123',
    newPassword:'synthetic-rotated-password-123',
  })).status,200);
  const first=await request('/stock-safety/recount-plan?page=1',token);
  assert.equal(first.status,200);
  assert.equal(first.data.kind,'read-only-physical-recount-plan');
  assert.equal(first.data.totalPhysical,source.items.length);
  assert.equal(first.data.tasks.length,25);
  assert.equal(first.data.freshPhysicalCountVerified,false);
  assert.equal(first.data.stockImportAuthorized,false);
  assert.equal(first.cache,'no-store');
  const second=await request('/stock-safety/recount-plan?page=2&expectedRef='+first.data.snapshotRef,token);
  assert.equal(second.status,200);
  assert.equal(second.data.snapshotRef,first.data.snapshotRef);
  assert.equal((await request('/stock-safety/recount-plan?priority=READY',token)).status,400);
  assert.equal((await request('/stock-safety/recount-plan?action=approved',token)).status,400);
  assert.equal((await request('/stock-safety/recount-plan?pageSize=1000',token)).status,400);
  assert.equal((await request('/stock-safety/recount-plan?extra=1',token)).status,400);
  const actor=db.prepare("SELECT id FROM users WHERE username='owner'").get();
  db.prepare("UPDATE users SET role='manager' WHERE id=?").run(actor.id);
  assert.equal((await request('/stock-safety/recount-plan',token)).status,200);
  db.prepare("UPDATE users SET role='cashier' WHERE id=?").run(actor.id);
  assert.equal((await request('/stock-safety/recount-plan',token)).status,403);
  db.prepare("UPDATE users SET role='owner' WHERE id=?").run(actor.id);
  websiteSku='NEW-WEBSITE-SKU';
  catalog.cache.fetchedAt='2000-01-01T00:00:00.000Z';
  const conflict=await request('/stock-safety/recount-plan?page=2&expectedRef='+first.data.snapshotRef,token);
  assert.equal(conflict.status,409);
  assert.equal(conflict.data.code,'RECOUNT_PLAN_CHANGED');
  assert.deepEqual(calls,['GET products','GET products']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n,0);
});
