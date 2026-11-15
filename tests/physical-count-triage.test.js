import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PhysicalCountClaims } from '../server/physical-count-claims.js';

const clock=Date.parse('2026-11-15T12:00:00.000Z');
const owner={id:'owner1',role:'owner'};
const staffA={id:'cashier1',role:'cashier'};
const staffB={id:'cashier2',role:'manager'};
const physical=(state='available')=>({
  source:'in-store-physical-stock-snapshot',manifestHash:'a'.repeat(64),
  summary:{items:2},
  items:[
    {reportRow:1,sku:'DRESS-1',status:state,name:'PRIVATE',stock:700},
    {reportRow:2,sku:'DRESS-2',status:'available',name:'PRIVATE2',stock:900},
  ],
});
const woo=(extra={})=>({
  source:'woocommerce',complete:true,stale:false,isDemo:false,
  fetchedAt:new Date(clock).toISOString(),
  products:[{type:'simple',id:123,sku:'DRESS-1'}],...extra,
});
const open=()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL,
    action TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL
  );CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT,'append only');END;
    CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT,'append only');END;`);
  return {db,service:new PhysicalCountClaims(db)};
};
const ctx=(service,p=physical(),w=woo())=>service.ownerReview(p,w,{},clock);
const entry=(row,stage,units,ref)=>({
  reportRow:row,stage,units,expectedRef:ref,requestId:randomUUID(),
});
const followup=(reportRow,record,decision='request_recount',note='Please perform a supervised recount.')=>({
  reportRow,
  expectedRef:record.snapshotRef,
  expectedFirstClaimId:record.items.find(x=>x.reportRow===reportRow)?.firstClaimId??null,
  expectedSecondClaimId:record.items.find(x=>x.reportRow===reportRow)?.secondClaimId??null,
  expectedLatestTriageId:record.items.find(x=>x.reportRow===reportRow)?.triage?.id??null,
  decision,note,requestId:randomUUID(),
});

test('owner writes immutable local follow-up, never approval or stock change',()=>{
  const {db,service}=open();
  try{
    const p=physical(),w=woo(),ref=ctx(service,p,w).snapshotRef;
    service.submit(staffA,p,w,entry(1,'first',7,ref),clock);
    service.submit(staffB,p,w,entry(1,'second',8,ref),clock);
    const initial=ctx(service,p,w);
    const req=followup(1,initial);
    const saved=service.recordOwnerTriage(owner,p,w,req,clock);
    assert.equal(saved.recorded,true);
    assert.equal(saved.replayed,false);
    assert.equal(saved.ownerApproved,false);
    assert.equal(saved.stockImportAuthorized,false);
    assert.equal(saved.checkoutAuthorized,false);
    const again=service.recordOwnerTriage(owner,p,w,req,clock);
    assert.equal(again.triageId,saved.triageId);
    assert.equal(again.replayed,true);
    const review=ctx(service,p,w);
    assert.equal(review.items[0].stage,'discrepant_claims');
    assert.equal(review.items[0].triage.decision,'request_recount');
    assert.equal(review.items[0].triage.note,req.note);
    assert.equal(review.items[0].triage.needsRecheck,false);
    assert.equal(review.items[0].triage.recordedBy,'owner1');
    assert.equal(review.items[0].ownerApproved,false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.count_owner_triage'").get().n,1);
    assert.throws(()=>db.prepare("DELETE FROM audit WHERE action='inventory.count_owner_triage'").run(),/append only/);
  }finally{db.close();}
});

test('new count after an owner note forces recheck, with older note retained in history',()=>{
  const {db,service}=open();
  try{
    const p=physical(),w=woo(),initial=ctx(service,p,w);
    service.submit(staffA,p,w,entry(1,'first',3,initial.snapshotRef),clock);
    const firstView=ctx(service,p,w);
    const note=service.recordOwnerTriage(owner,p,w,followup(1,firstView,
      'collect_witness_evidence','Ask supervisor to observe the second count.'),clock);
    service.submit(staffB,p,w,entry(1,'second',3,firstView.snapshotRef),clock);
    const review=ctx(service,p,w);
    assert.equal(review.items[0].stage,'matching_claims_unverified');
    assert.equal(review.items[0].triage.needsRecheck,true);
    assert.equal(review.items[0].triage.id,note.triageId);
    assert.throws(()=>service.recordOwnerTriage(owner,p,w,followup(1,firstView),clock),
      e=>e.code==='COUNT_TRIAGE_CLAIMS_CHANGED');
    const latest=service.recordOwnerTriage(owner,p,w,followup(1,review,
      'collect_witness_evidence','Count claims match; collect signed witnessing evidence.'),clock);
    assert.ok(latest.triageId>note.triageId);
    assert.equal(ctx(service,p,w).items[0].triage.needsRecheck,false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.count_owner_triage'").get().n,2);
    assert.equal(ctx(service,p,w).ownerApproved,false);
  }finally{db.close();}
});

test('duplicate note request conflicts, stale owner form conflicts, and roles are enforced',()=>{
  const {db,service}=open();
  try{
    const p=physical(),w=woo(),review=ctx(service,p,w);
    const request=followup(2,review,'investigate_product_identity','Investigate SKU in store.');
    assert.throws(()=>service.recordOwnerTriage(staffA,p,w,request,clock),
      e=>e.code==='COUNT_TRIAGE_OWNER_ONLY');
    assert.throws(()=>service.recordOwnerTriage(owner,p,w,{
      ...request,decision:'stock_approved',
    },clock));
    assert.throws(()=>service.recordOwnerTriage(owner,p,w,{
      ...request,units:1000,
    },clock));
    const first=service.recordOwnerTriage(owner,p,w,request,clock);
    assert.equal(first.recorded,true);
    assert.throws(()=>service.recordOwnerTriage(owner,p,w,{...request,note:'Changed',requestId:request.requestId},clock),
      e=>e.code==='COUNT_TRIAGE_IDEMPOTENCY_CONFLICT');
    assert.throws(()=>service.recordOwnerTriage(owner,p,w,followup(2,review),clock),
      e=>e.code==='COUNT_TRIAGE_NOTE_CHANGED');
    assert.throws(()=>service.recordOwnerTriage(owner,p,w,{...request,requestId:randomUUID(),expectedRef:'b'.repeat(64)},clock),
      e=>e.code==='COUNT_TRIAGE_SNAPSHOT_CHANGED');
    assert.throws(()=>service.recordOwnerTriage(owner,p,w,{...request,requestId:randomUUID(),reportRow:9999},clock),
      e=>e.code==='COUNT_TRIAGE_ROW_MISSING');
    assert.throws(()=>service.recordOwnerTriage(owner,p,woo({stale:true}),{
      ...request,requestId:randomUUID(),
    },clock),e=>e.code==='COUNT_TRIAGE_SOURCE_STALE');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.count_owner_triage'").get().n,1);
  }finally{db.close();}
});

test('physical/Woo identity changes quarantine older owner follow-ups',()=>{
  const {db,service}=open();
  try{
    const p=physical(),w=woo(),view=ctx(service,p,w);
    service.recordOwnerTriage(owner,p,w,followup(1,view),clock);
    const changed=woo({products:[{type:'simple',id:456,sku:'DRESS-1'}]});
    const different=ctx(service,p,changed);
    assert.notEqual(different.snapshotRef,view.snapshotRef);
    assert.equal(different.items[0].triage,null);
    assert.equal(different.ownerApproved,false);
    const newView=ctx(service,p,woo({fetchedAt:new Date(clock+1000).toISOString()}));
    assert.equal(newView.snapshotRef,view.snapshotRef);
    assert.ok(newView.items[0].triage);
  }finally{db.close();}
});
