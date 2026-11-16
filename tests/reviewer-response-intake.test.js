import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PhysicalCountClaims} from '../server/physical-count-claims.js';
import {CountSupervisionEvidence} from '../server/count-supervision-evidence.js';
import {PrivateCountFileManifests} from '../server/private-count-file-manifests.js';
import {EvidenceCustodyReview} from '../server/evidence-custody-review.js';
import {ReviewerResponseIntake} from '../server/reviewer-response-intake.js';

const clock=Date.parse('2026-11-15T12:00:00.000Z');
const owner={id:'owner',role:'owner'};
const first={id:'sales',role:'cashier'};
const second={id:'packer',role:'manager'};
const physical=()=>({
  source:'in-store-physical-stock-snapshot',manifestHash:'a'.repeat(64),
  summary:{items:3},items:[
    {reportRow:1,sku:'ITEM-A',status:'available',name:'PRIVATE FASHION',stock:400,priceCents:35000},
    {reportRow:2,sku:'ITEM-B',status:'available',name:'PRIVATE FASHION',stock:500,priceCents:25000},
    {reportRow:3,sku:'HELD',status:'review',name:'PRIVATE FASHION'},
  ],
});
const website=(more={})=>({
  source:'woocommerce',complete:true,stale:false,isDemo:false,
  fetchedAt:new Date(clock).toISOString(),
  products:[{id:11,type:'simple',sku:'ITEM-A'}],...more,
});
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,
    action TEXT NOT NULL,subject TEXT NOT NULL,created_at TEXT NOT NULL
  ); CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
  const counts=new PhysicalCountClaims(db);
  const supervision=new CountSupervisionEvidence(db,counts);
  const files=new PrivateCountFileManifests(db,supervision);
  const custody=new EvidenceCustodyReview(db,files);
  return {db,counts,files,custody,responses:new ReviewerResponseIntake(db,custody)};
}
function count(ctx,p,w,reportRow,stage,units,actor){
  const ref=ctx.counts.ownerReview(p,w,{},clock).snapshotRef;
  ctx.counts.submit(actor,p,w,{
    reportRow,stage,units,expectedRef:ref,requestId:randomUUID(),
  },clock);
}
function manifest(ctx,p,w,row=1,hash='b'.repeat(64)){
  const r=ctx.files.list(p,w,{},clock);
  const x=r.items.find(x=>x.reportRow===row);
  return ctx.files.submit(owner,p,w,{
    reportRow:row,expectedRef:r.snapshotRef,
    expectedLatestManifestId:x.latestManifest?.id??null,
    firstClaimId:x.firstClaimId,secondClaimId:x.secondClaimId,
    documentCode:'PRIVATE_DOC_001',documentType:'count_sheet',
    mime:'application/pdf',fileBytes:31,fileSha256:hash,
    requestId:randomUUID(),
  },clock);
}
function custodyEvent(ctx,p,w,row,action){
  const r=ctx.custody.list(p,w,{},clock);
  const x=r.items.find(x=>x.reportRow===row);
  return ctx.custody.submit(owner,p,w,{
    reportRow:row,expectedRef:r.snapshotRef,
    expectedLatestEventId:x.latestCustodyEvent?.id??null,
    manifestId:x.manifest.id,fileSha256:x.manifest.fileSha256,
    firstClaimId:x.firstClaimId,secondClaimId:x.secondClaimId,
    action,locationCode:'PRIVATE_BOX_01',
    reviewChannel:action==='independent_review_requested'?'in_person':'none',
    note:'Owner notes request for separate inspection of original document.',
    requestId:randomUUID(),
  },clock);
}
function ready(ctx,p,w,row=1,units=[5,5]){
  count(ctx,p,w,row,'first',units[0],first);
  count(ctx,p,w,row,'second',units[1],second);
  manifest(ctx,p,w,row);
  custodyEvent(ctx,p,w,row,'sealed_in_private_custody');
  custodyEvent(ctx,p,w,row,'independent_review_requested');
}
function claimed(view,row=1,outcome='discrepancy_reported',issueCode='signature_missing'){
  const x=view.items.find(x=>x.reportRow===row);
  return {
    reportRow:row,expectedRef:view.snapshotRef,
    expectedLatestResponseId:x.latestResponse?.id??null,
    custodyRequestId:x.custodyRequestId,manifestId:x.manifestId,
    fileSha256:x.fileSha256,
    firstClaimId:x.firstClaimId,secondClaimId:x.secondClaimId,
    reviewerCode:'EXT_REVIEWER_01',outcome,
    issueCode:outcome==='discrepancy_reported'?issueCode:null,
    note:'External response reportedly raised a document issue; verify independently.',
    requestId:randomUUID(),
  };
}

test('owner-reported discrepancy is append-only and does not certify independent review',()=>{
  const ctx=setup();try{
    const p=physical(),w=website();
    const initial=ctx.responses.list(p,w,{},clock);
    assert.equal(initial.items[0].status,'custody_or_source_hold');
    assert.equal(initial.independentReviewConfirmed,false);
    ready(ctx,p,w,1,[5,5]);
    const report=ctx.responses.list(p,w,{},clock);
    assert.equal(report.items[0].status,'awaiting_external_response');
    assert.equal(report.items[0].mayReport,true);
    const input=claimed(report);
    const recorded=ctx.responses.submit(owner,p,w,input,clock);
    assert.equal(recorded.recorded,true);
    assert.equal(recorded.independentReviewConfirmed,false);
    assert.equal(recorded.stockImportAuthorized,false);
    assert.equal(ctx.responses.submit(owner,p,w,input,clock).replayed,true);
    const after=ctx.responses.list(p,w,{},clock);
    assert.equal(after.items[0].status,'reported_discrepancy_open');
    assert.equal(after.items[0].latestResponse.issueCode,'signature_missing');
    assert.equal(after.items[0].latestResponse.independentlyAuthenticated,false);
    assert.equal(after.stats.independentlyAuthenticatedReviewers,0);
    assert.equal(after.checkoutAuthorized,false);
    assert.equal(after.ownerApproved,false);
    assert.equal(after.independentWitnessVerified,false);
    assert.notEqual(after.snapshotRef,report.snapshotRef);
    assert.doesNotMatch(JSON.stringify(after),/"name":"PRIVATE FASHION"|priceCents|"stock":400|firstUnits|secondUnits/);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.external_reviewer_response_claim'").get().n,1);
    assert.throws(()=>ctx.db.prepare("DELETE FROM audit").run(),/immutable/);
  }finally{ctx.db.close();}
});

test('reported acknowledgement never closes a staff count discrepancy',()=>{
  const ctx=setup();try{
    const p=physical(),w=website();
    ready(ctx,p,w,2,[8,10]);
    let r=ctx.responses.list(p,w,{},clock);
    assert.equal(r.items[1].countDiscrepancyOpen,true);
    ctx.responses.submit(owner,p,w,claimed(r,2,'acknowledgement_reported'),clock);
    r=ctx.responses.list(p,w,{},clock);
    assert.equal(r.items[1].status,'acknowledgement_unverified');
    assert.equal(r.items[1].countDiscrepancyOpen,true);
    assert.equal(r.items[1].latestResponse.acknowledgedByReviewerAccount,false);
    assert.equal(r.stats.openStaffCountDiscrepancies,1);
    assert.equal(r.independentReviewConfirmed,false);
    assert.equal(r.stockImportAuthorized,false);
    ctx.responses.submit(owner,p,w,claimed(r,2,'review_unavailable'),clock);
    const next=ctx.responses.list(p,w,{},clock);
    assert.equal(next.items[1].status,'review_unavailable');
    assert.equal(next.items[1].countDiscrepancyOpen,true);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.external_reviewer_response_claim'").get().n,2);
  }finally{ctx.db.close();}
});

test('separate reviewer reference collision checks, owner role and strict outcomes fail closed',()=>{
  const ctx=setup();try{
    const p=physical(),w=website();
    ready(ctx,p,w);
    const r=ctx.responses.list(p,w,{},clock),data=claimed(r);
    assert.throws(()=>ctx.responses.submit(first,p,w,data,clock),
      e=>e.code==='REVIEWER_INTAKE_OWNER_ONLY');
    for(const reviewerCode of ['owner','sales','packer']){
      assert.throws(()=>ctx.responses.submit(owner,p,w,{
        ...data,reviewerCode,
      },clock),e=>e.code==='REVIEWER_INTAKE_REFERENCE_NOT_DISTINCT');
    }
    for(const bad of [
      {...data,approved:true},
      {...data,outcome:'reviewer_verified'},
      {...data,issueCode:null},
      {...data,outcome:'acknowledgement_reported',issueCode:'signature_missing'},
      {...data,reviewerCode:'John Smith'},
      {...data,note:'too short'},
      {...data,fileSha256:'z'.repeat(64)},
    ])assert.throws(()=>ctx.responses.submit(owner,p,w,bad,clock));
    assert.throws(()=>ctx.responses.submit(owner,p,w,{
      ...data,custodyRequestId:999,
    },clock),e=>e.code==='REVIEWER_INTAKE_REQUEST_CHANGED');
    assert.throws(()=>ctx.responses.submit(owner,p,w,{
      ...data,expectedRef:'0'.repeat(64),
    },clock),e=>e.code==='REVIEWER_INTAKE_SNAPSHOT_CHANGED');
    assert.throws(()=>ctx.responses.submit(owner,p,website({stale:true}),data,clock),
      e=>e.code==='REVIEWER_INTAKE_EVIDENCE_STALE');
    const saved=ctx.responses.submit(owner,p,w,data,clock);
    assert.equal(saved.recorded,true);
    assert.throws(()=>ctx.responses.submit(owner,p,w,{
      ...data,note:'A changed note using the identical request identifier.',
    },clock),e=>e.code==='REVIEWER_INTAKE_REPLAY_CONFLICT');
    assert.throws(()=>ctx.responses.submit(owner,p,w,{
      ...data,requestId:randomUUID(),
    },clock),e=>e.code==='REVIEWER_INTAKE_SNAPSHOT_CHANGED');
  }finally{ctx.db.close();}
});

test('replacing custody or source changes current response while preserving historic audit',()=>{
  const ctx=setup();try{
    const p=physical(),w=website();
    ready(ctx,p,w);
    const before=ctx.responses.list(p,w,{page:1,pageSize:1},clock);
    assert.equal(before.snapshotRef,
      ctx.responses.list(p,w,{page:2,pageSize:1},clock).snapshotRef);
    ctx.responses.submit(owner,p,w,claimed(ctx.responses.list(p,w,{},clock)),clock);
    const after=ctx.responses.list(p,w,{},clock);
    assert.equal(ctx.responses.list(p,w,{search:'ITEM-A'},clock).total,1);
    assert.equal(ctx.responses.list(p,w,{status:'reported_discrepancy_open'},clock).total,1);
    assert.equal(ctx.responses.list(p,website({
      fetchedAt:new Date(clock+1000).toISOString(),
    }),{},clock).snapshotRef,after.snapshotRef);
    for(const bad of [{page:0},{pageSize:51},{status:'approved'},{search:'a'.repeat(65)}])
      assert.throws(()=>ctx.responses.list(p,w,bad,clock));
    manifest(ctx,p,w,1,'c'.repeat(64));
    const newSource=ctx.responses.list(p,w,{},clock);
    assert.notEqual(newSource.snapshotRef,after.snapshotRef);
    assert.equal(newSource.items[0].latestResponse,null);
    assert.equal(newSource.independentReviewConfirmed,false);
    assert.throws(()=>ctx.responses.submit(owner,p,w,{
      ...claimed(after),requestId:randomUUID(),
    },clock),e=>e.code==='REVIEWER_INTAKE_SNAPSHOT_CHANGED');
    const changed=website({products:[{id:11,type:'simple',sku:'CHANGED'}]});
    assert.notEqual(ctx.responses.list(p,changed,{},clock).snapshotRef,
      ctx.responses.list(p,w,{},clock).snapshotRef);
    assert.equal(ctx.responses.list(p,changed,{},clock).independentReviewConfirmed,false);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.external_reviewer_response_claim'").get().n,1);
  }finally{ctx.db.close();}
});
