import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { OwnerMappingEvidence } from '../server/owner-mapping-evidence.js';

const date='2026-11-15T12:00:00.000Z';
const clock=Date.parse(date);
const owner={id:'owner',role:'owner'};
const manager={id:'manager',role:'manager'};
const physical=(items,extra={})=>({
  source:'in-store-physical-stock-snapshot',manifestHash:'a'.repeat(64),
  summary:{items:items.length},items,...extra,
});
const row=(sku,reportRow,status='available')=>({
  sku,reportRow,status,name:'PRIVATE STOCK',stock:200,priceCents:10000,
});
const woo=(products,extra={})=>({
  source:'woocommerce',fetchedAt:date,complete:true,isDemo:false,
  stale:false,products,...extra,
});
const p=()=>physical([
  row('MATCH',1),row('ALTERNATE',2),row('HOLD',3,'review'),
  row('PARENT',4),row('DUP',5),row('dup',6),row('',7),
]);
const w=()=>woo([
  {id:20,type:'simple',sku:'MATCH'},
  {id:21,type:'simple',sku:'DIFFERENT'},
  {id:22,type:'variable',sku:'PARENT',variations:[
    {id:220,sku:'PARENT-M'}, {id:221,sku:'PARENT-L'},
  ]},
  {id:23,type:'simple',sku:'DUP'},
]);
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,
    action TEXT NOT NULL,subject TEXT NOT NULL,created_at TEXT NOT NULL
  );CREATE TRIGGER immutable_update BEFORE UPDATE ON audit
     BEGIN SELECT RAISE(ABORT,'append-only'); END;
    CREATE TRIGGER immutable_delete BEFORE DELETE ON audit
     BEGIN SELECT RAISE(ABORT,'append-only'); END;`);
  return {db,service:new OwnerMappingEvidence(db)};
}
const proposal=(r,reportRow,productId,variationId=null,note='Check actual garment size and colour.')=>({
  reportRow,expectedRef:r.identityRef,
  expectedLatestReviewId:r.items.find(x=>x.reportRow===reportRow)?.latestReview?.id??null,
  decision:'propose_option',proposedProductId:productId,
  proposedVariationId:variationId,note,requestId:randomUUID(),
});
const follow=(r,reportRow,decision='investigate_identity')=>({
  ...proposal(r,reportRow,null,null,'Investigate the physical garment identity.'),
  decision,
});

test('owner records unapproved proposed Woo simple and variation identities, no stock amounts',()=>{
  const {db,service}=setup();
  try{
    const source=p(),website=w();
    let report=service.review(source,website,{},clock);
    assert.equal(report.evidenceVerified,true);
    assert.equal(report.counts.notReviewed,7);
    assert.equal(report.mappingApproved,false);
    assert.equal(report.stockImportAuthorized,false);
    const request=proposal(report,1,20);
    const result=service.submit(owner,source,website,request,clock);
    assert.equal(result.recorded,true);
    assert.equal(result.mappingApproved,false);
    assert.equal(result.checkoutAuthorized,false);
    const replay=service.submit(owner,source,website,request,clock);
    assert.equal(replay.replayed,true);
    assert.equal(replay.reviewId,result.reviewId);
    report=service.review(source,website,{},clock);
    assert.equal(report.counts.proposed,1);
    assert.equal(report.items[0].latestReview.proposedProductId,20);
    assert.equal(report.items[0].latestReview.exactSkuMatch,true);
    assert.equal(report.items[0].latestReview.mappingApproved,false);
    const second=service.submit(owner,source,website,proposal(report,4,22,220),clock);
    assert.equal(second.recorded,true);
    report=service.review(source,website,{},clock);
    assert.equal(report.items[3].latestReview.proposedVariationId,220);
    assert.equal(report.items[3].latestReview.exactSkuMatch,false);
    assert.equal(report.counts.proposed,2);
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE STOCK|priceCents|"stock":200/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.owner_mapping_review'").get().n,2);
    assert.throws(()=>db.prepare("DELETE FROM audit").run(),/append-only/);
  }finally{db.close();}
});

test('mapping holds, missing physical codes and duplicate physical SKUs forbid proposals',()=>{
  const {db,service}=setup();
  try{
    const source=p(),website=w(),r=service.review(source,website,{},clock);
    for(const [line,productId,variation] of [[3,20,null],[5,23,null],[6,23,null],[7,20,null]]){
      assert.throws(()=>service.submit(owner,source,website,
        proposal(r,line,productId,variation),clock),e=>e.code==='MAPPING_SOURCE_HELD');
    }
    // Investigations and holds are still permitted without an invalid link.
    assert.equal(service.submit(owner,source,website,follow(r,3,'retain_hold'),clock).recorded,true);
    assert.equal(service.review(source,website,{},clock).counts.hold,1);
  }finally{db.close();}
});

test('option must exist as unique published simple product or variation; never a parent',()=>{
  const {db,service}=setup();
  try{
    const source=p(),website=w(),r=service.review(source,website,{},clock);
    for(const [productId,variationId] of [
      [22,null],[22,999],[999,null],[20,10],[23,220],
    ])assert.throws(()=>service.submit(owner,source,website,
      proposal(r,1,productId,variationId),clock),
      e=>e.code==='MAPPING_OPTION_NOT_UNIQUE');
    const duplicateWebsite=woo([
      {id:20,type:'simple',sku:'MATCH'},
      {id:20,type:'simple',sku:'MATCH2'},
    ]);
    const dup=service.review(source,duplicateWebsite,{},clock);
    assert.throws(()=>service.submit(owner,source,duplicateWebsite,
      proposal(dup,2,20),clock),e=>e.code==='MAPPING_OPTION_NOT_UNIQUE');
    const noSku=woo([{id:20,type:'simple',sku:''}]);
    const q=service.review(source,noSku,{},clock);
    assert.throws(()=>service.submit(owner,source,noSku,
      proposal(q,1,20),clock),e=>e.code==='MAPPING_OPTION_SKU_MISSING');
  }finally{db.close();}
});

test('one current Woo option cannot be proposed for two different physical rows',()=>{
  const {db,service}=setup();
  try{
    const source=p(),website=w(),initial=service.review(source,website,{},clock);
    assert.equal(service.submit(owner,source,website,
      proposal(initial,1,20),clock).recorded,true);
    assert.throws(()=>service.submit(owner,source,website,
      proposal(initial,2,20),clock),e=>e.code==='MAPPING_OPTION_ALREADY_PROPOSED');
    const after=service.review(source,website,{},clock);
    const decision=follow(after,1,'investigate_identity');
    assert.equal(service.submit(owner,source,website,decision,clock).recorded,true);
    // A newer non-proposal releases only the owner proposal, never Woo stock.
    const next=service.review(source,website,{},clock);
    assert.equal(service.submit(owner,source,website,proposal(next,2,20),clock).recorded,true);
    assert.equal(service.review(source,website,{},clock).counts.proposed,1);
  }finally{db.close();}
});

test('owner edits are append-only with version-conflicts, strict no-approval decisions and idempotency',()=>{
  const {db,service}=setup();
  try{
    const source=p(),website=w(),report=service.review(source,website,{},clock);
    const a=follow(report,1);
    assert.throws(()=>service.submit(manager,source,website,a,clock),
      e=>e.code==='MAPPING_OWNER_REQUIRED');
    assert.throws(()=>service.submit(owner,source,website,{
      ...a,decision:'approve_inventory',
    },clock));
    assert.throws(()=>service.submit(owner,source,website,{
      ...a,stockQuantity:200,
    },clock));
    assert.throws(()=>service.submit(owner,source,website,{
      ...a,decision:'retain_hold',proposedProductId:20,
    },clock),e=>e.code==='MAPPING_UNEXPECTED_IDS');
    const first=service.submit(owner,source,website,a,clock);
    assert.equal(first.recorded,true);
    assert.throws(()=>service.submit(owner,source,website,{
      ...a,requestId:randomUUID(),
    },clock),e=>e.code==='MAPPING_REVIEW_CHANGED');
    assert.throws(()=>service.submit(owner,source,website,{
      ...a,note:'Something different',
    },clock),e=>e.code==='MAPPING_REPLAY_CONFLICT');
    assert.equal(service.submit(owner,source,website,a,clock).replayed,true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,1);
  }finally{db.close();}
});

test('catalogue/source identity changes invalidate proposals; benign refresh does not',()=>{
  const {db,service}=setup();
  try{
    const source=p(),website=w(),r=service.review(source,website,{},clock);
    service.submit(owner,source,website,proposal(r,1,20),clock);
    const fresh=woo(w().products,{fetchedAt:new Date(clock+1000).toISOString()});
    assert.equal(service.review(source,fresh,{},clock+2000).identityRef,r.identityRef);
    const changed=woo([{id:20,type:'simple',sku:'CHANGED'}]);
    const newReview=service.review(source,changed,{},clock);
    assert.notEqual(newReview.identityRef,r.identityRef);
    assert.equal(newReview.counts.notReviewed,7);
    assert.throws(()=>service.submit(owner,source,changed,
      proposal(r,1,20),clock),e=>e.code==='MAPPING_EVIDENCE_CHANGED');
    const changedSource=physical(p().items,{manifestHash:'b'.repeat(64)});
    assert.notEqual(service.review(changedSource,website,{},clock).identityRef,r.identityRef);
    assert.throws(()=>service.submit(owner,source,woo(w().products,{stale:true}),
      {...follow(r,2),requestId:randomUUID()},clock),
    e=>e.code==='MAPPING_EVIDENCE_STALE');
  }finally{db.close();}
});

test('bounded owner filters, snapshot pagination and record-source identity remain private',()=>{
  const {db,service}=setup();
  try{
    const source=p(),website=w();
    const first=service.review(source,website,{page:1,pageSize:3},clock);
    const second=service.review(source,website,{page:2,pageSize:3},clock);
    assert.equal(first.items.length,3);
    assert.equal(second.items.length,3);
    assert.equal(first.identityRef,second.identityRef);
    const last=service.review(source,website,{page:3,pageSize:3},clock);
    assert.equal(last.items.length,1);
    assert.equal(last.hasMore,false);
    assert.equal(service.review(source,website,{search:'ALTERNATE'},clock).total,1);
    assert.equal(service.review(source,website,{status:'not_reviewed'},clock).total,7);
    for(const query of [{status:'approved'},{page:0},{pageSize:51},
      {search:'x'.repeat(65)}]){
      assert.throws(()=>service.review(source,website,query,clock));
    }
  }finally{db.close();}
});
