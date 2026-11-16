import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PhysicalCountClaims} from '../server/physical-count-claims.js';
import {CountSupervisionEvidence} from '../server/count-supervision-evidence.js';
import {PrivateCountFileManifests} from '../server/private-count-file-manifests.js';
import {EvidenceCustodyReview} from '../server/evidence-custody-review.js';

const clock=Date.parse('2026-11-15T12:00:00.000Z');
const owner={id:'owner',role:'owner'},first={id:'sales',role:'cashier'},second={id:'packer',role:'manager'};
const physical=()=>({
  source:'in-store-physical-stock-snapshot',manifestHash:'a'.repeat(64),
  summary:{items:3},items:[
    {reportRow:1,sku:'DRESS1',status:'available',name:'PRIVATE STYLE',stock:900,priceCents:25000},
    {reportRow:2,sku:'DRESS2',status:'available',name:'PRIVATE STYLE',stock:800,priceCents:28000},
    {reportRow:3,sku:'HOLD',status:'review',name:'PRIVATE STYLE'},
  ],
});
const woo=(extra={})=>({
  source:'woocommerce',complete:true,isDemo:false,stale:false,
  fetchedAt:new Date(clock).toISOString(),
  products:[{id:55,type:'simple',sku:'DRESS1'}],...extra,
});
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit(
    id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,
    action TEXT NOT NULL,subject TEXT NOT NULL,created_at TEXT NOT NULL
  );CREATE TRIGGER no_edit BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT,'immutable');END;
    CREATE TRIGGER no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT,'immutable');END;`);
  const counts=new PhysicalCountClaims(db);
  const supervision=new CountSupervisionEvidence(db,counts);
  const files=new PrivateCountFileManifests(db,supervision);
  return {db,counts,files,custody:new EvidenceCustodyReview(db,files)};
}
function count(ctx,p,w,reportRow,stage,units,actor){
  const ref=ctx.counts.ownerReview(p,w,{},clock).snapshotRef;
  return ctx.counts.submit(actor,p,w,{
    reportRow,stage,units,expectedRef:ref,requestId:randomUUID(),
  },clock);
}
function registerFile(ctx,p,w,reportRow=1,hash='b'.repeat(64)){
  const report=ctx.files.list(p,w,{},clock);
  const item=report.items.find(x=>x.reportRow===reportRow);
  return ctx.files.submit(owner,p,w,{
    reportRow,expectedRef:report.snapshotRef,
    expectedLatestManifestId:item.latestManifest?.id??null,
    firstClaimId:item.firstClaimId,secondClaimId:item.secondClaimId,
    documentCode:'ORIGINAL_0001',documentType:'count_sheet',
    mime:'application/pdf',fileBytes:31,fileSha256:hash,
    requestId:randomUUID(),
  },clock);
}
function request(report,row=1,action='sealed_in_private_custody'){
  const data=report.items.find(x=>x.reportRow===row);
  return {
    reportRow:row,expectedRef:report.snapshotRef,
    expectedLatestEventId:data.latestCustodyEvent?.id??null,
    manifestId:data.manifest?.id, fileSha256:data.manifest?.fileSha256,
    firstClaimId:data.firstClaimId,secondClaimId:data.secondClaimId,
    action,locationCode:'SEALED_BOX_01',
    reviewChannel:action==='independent_review_requested'?'in_person':'none',
    note:'Original retained in private custody for review, not approved.',
    requestId:randomUUID(),
  };
}
test('custody requires file manifest and original sealed declaration before review handoff request',()=>{
  const ctx=setup();try{
    const p=physical(),w=woo();
    const zero=ctx.custody.list(p,w,{},clock);
    assert.equal(zero.items[0].status,'waiting_for_counts');
    assert.equal(zero.tally.independentlyVerifiedOriginals,0);
    assert.equal(zero.checkoutAuthorized,false);
    count(ctx,p,w,1,'first',5,first);
    count(ctx,p,w,1,'second',5,second);
    let review=ctx.custody.list(p,w,{},clock);
    assert.equal(review.items[0].status,'file_manifest_missing');
    assert.equal(review.items[0].mayRecord,false);
    registerFile(ctx,p,w);
    review=ctx.custody.list(p,w,{},clock);
    assert.equal(review.items[0].status,'custody_entry_needed');
    assert.equal(review.items[0].mayRecord,true);
    assert.throws(()=>ctx.custody.submit(owner,p,w,request(review,1,'independent_review_requested'),clock),
      e=>e.code==='EVIDENCE_CUSTODY_SEAL_REQUIRED');
    const firstEntry=request(review);
    const saved=ctx.custody.submit(owner,p,w,firstEntry,clock);
    assert.equal(saved.recorded,true);
    assert.equal(saved.ownerApproved,false);
    assert.equal(saved.independentReviewConfirmed,false);
    assert.equal(ctx.custody.submit(owner,p,w,firstEntry,clock).replayed,true);
    review=ctx.custody.list(p,w,{},clock);
    assert.equal(review.items[0].status,'custody_declared_unverified');
    assert.equal(review.tally.custodyNotesCurrent,1);
    const handoff=ctx.custody.submit(owner,p,w,
      request(review,1,'independent_review_requested'),clock);
    assert.equal(handoff.recorded,true);
    const after=ctx.custody.list(p,w,{},clock);
    assert.equal(after.items[0].status,'review_requested_unconfirmed');
    assert.equal(after.tally.reviewsRequestedUnconfirmed,1);
    assert.equal(after.independentReviewConfirmed,false);
    assert.equal(after.independentWitnessVerified,false);
    assert.equal(after.stockImportAuthorized,false);
    assert.doesNotMatch(JSON.stringify(after),/"name":"PRIVATE STYLE"|priceCents|"stock":900|firstUnits|secondUnits/);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.private_evidence_custody'").get().n,2);
    assert.throws(()=>ctx.db.prepare("UPDATE audit SET action='x'").run(),/immutable/);
  }finally{ctx.db.close();}
});
test('discrepant count cannot be cleared by custody notes or review request',()=>{
  const ctx=setup();try{
    const p=physical(),w=woo();
    count(ctx,p,w,2,'first',6,first);
    count(ctx,p,w,2,'second',9,second);
    registerFile(ctx,p,w,2);
    let r=ctx.custody.list(p,w,{},clock);
    assert.equal(r.items[1].status,'count_discrepancy_open');
    ctx.custody.submit(owner,p,w,request(r,2),clock);
    r=ctx.custody.list(p,w,{},clock);
    ctx.custody.submit(owner,p,w,request(r,2,'independent_review_requested'),clock);
    const after=ctx.custody.list(p,w,{},clock);
    assert.equal(after.items[1].status,'count_discrepancy_open');
    assert.equal(after.items[1].countDiscrepancyOpen,true);
    assert.equal(after.items[1].latestCustodyEvent.action,'independent_review_requested');
    assert.equal(after.items[1].independentReviewConfirmed,false);
    assert.equal(after.ownerApproved,false);
  }finally{ctx.db.close();}
});
test('owner only, strict choices, revision conflicts and replay disputes are fail-closed',()=>{
  const ctx=setup();try{
    const p=physical(),w=woo();
    count(ctx,p,w,1,'first',5,first);
    count(ctx,p,w,1,'second',5,second);
    registerFile(ctx,p,w);
    const r=ctx.custody.list(p,w,{},clock);
    const input=request(r);
    assert.throws(()=>ctx.custody.submit(first,p,w,input,clock),
      e=>e.code==='EVIDENCE_CUSTODY_OWNER_ONLY');
    for(const bad of [
      {...input,approved:true},
      {...input,action:'accept_stock'},
      {...input,locationCode:'actual/path/or/name'},
      {...input,reviewChannel:'in_person'},
      {...input,manifestId:999},
      {...input,fileSha256:'z'.repeat(64)},
    ])assert.throws(()=>ctx.custody.submit(owner,p,w,bad,clock));
    const result=ctx.custody.submit(owner,p,w,input,clock);
    assert.equal(result.recorded,true);
    assert.equal(ctx.custody.submit(owner,p,w,input,clock).replayed,true);
    assert.throws(()=>ctx.custody.submit(owner,p,w,{
      ...input,note:'New note with same request identifier',
    },clock),e=>e.code==='EVIDENCE_CUSTODY_REPLAY_CONFLICT');
    assert.throws(()=>ctx.custody.submit(owner,p,w,{
      ...input,requestId:randomUUID(),
    },clock),e=>e.code==='EVIDENCE_CUSTODY_SNAPSHOT_CHANGED');
    const after=ctx.custody.list(p,w,{},clock);
    assert.throws(()=>ctx.custody.submit(owner,p,w,{
      ...request(after,1,'independent_review_requested'),reviewChannel:'none',
    },clock));
    assert.throws(()=>ctx.custody.submit(owner,p,woo({stale:true}),
      request(after),clock),e=>e.code==='EVIDENCE_CUSTODY_SOURCE_STALE');
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.private_evidence_custody'").get().n,1);
  }finally{ctx.db.close();}
});
test('replaced file manifest and source identity revisions quarantine previous current custody',()=>{
  const ctx=setup();try{
    const p=physical(),w=woo();
    count(ctx,p,w,1,'first',5,first);
    count(ctx,p,w,1,'second',5,second);
    registerFile(ctx,p,w);
    let r=ctx.custody.list(p,w,{},clock);
    ctx.custody.submit(owner,p,w,request(r),clock);
    r=ctx.custody.list(p,w,{},clock);
    const page1=ctx.custody.list(p,w,{page:1,pageSize:1},clock);
    const page2=ctx.custody.list(p,w,{page:2,pageSize:1},clock);
    assert.equal(page1.snapshotRef,page2.snapshotRef);
    assert.equal(ctx.custody.list(p,w,{search:'DRESS1'},clock).total,1);
    assert.equal(ctx.custody.list(p,w,{status:'custody_declared_unverified'},clock).total,1);
    const refresh=woo({fetchedAt:new Date(clock+1000).toISOString()});
    assert.equal(ctx.custody.list(p,refresh,{},clock).snapshotRef,r.snapshotRef);
    registerFile(ctx,p,w,1,'c'.repeat(64));
    const replaced=ctx.custody.list(p,w,{},clock);
    assert.notEqual(replaced.snapshotRef,r.snapshotRef);
    assert.equal(replaced.items[0].latestCustodyEvent,null);
    assert.equal(replaced.items[0].status,'custody_entry_needed');
    assert.throws(()=>ctx.custody.submit(owner,p,w,{
      ...request(r),requestId:randomUUID(),
    },clock),e=>e.code==='EVIDENCE_CUSTODY_SNAPSHOT_CHANGED');
    const changed=woo({products:[{id:55,type:'simple',sku:'CHANGED'}]});
    assert.equal(ctx.custody.list(p,changed,{},clock).items[0].latestCustodyEvent,null);
    assert.equal(ctx.custody.list(p,changed,{},clock).independentReviewConfirmed,false);
    for(const invalid of [{page:0},{pageSize:51},{status:'accepted'},{search:'a'.repeat(65)}])
      assert.throws(()=>ctx.custody.list(p,w,invalid,clock));
  }finally{ctx.db.close();}
});
