import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PhysicalCountClaims } from '../server/physical-count-claims.js';

const clock=Date.parse('2026-11-15T12:00:00.000Z');
const staffA={id:'staff-a',role:'cashier'};
const staffB={id:'staff-b',role:'cashier'};
const manager={id:'manager',role:'manager'};
const owner={id:'owner',role:'owner'};
const physical=(status='available')=>({
  source:'in-store-physical-stock-snapshot',
  manifestHash:'a'.repeat(64),
  summary:{items:2},
  items:[
    {sku:'P1',reportRow:1,status,priceCents:5500,stock:800,name:'HIDDEN'},
    {sku:'P2',reportRow:2,status:'available',priceCents:1500,stock:500},
  ],
});
const website=(other={})=>({
  source:'woocommerce',complete:true,stale:false,isDemo:false,
  fetchedAt:new Date(clock).toISOString(),
  products:[{id:33,type:'simple',sku:'P1'}],
  ...other,
});
const context=()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL,
    action TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL
  ); CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Immutable'); END;
     CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Immutable'); END;`);
  return {db,service:new PhysicalCountClaims(db)};
};
const prepare=(p=physical(),w=website())=>{
  const {db,service}=context();
  try{return service.worklist(staffA,p,w,{},clock).snapshotRef;}
  finally{db.close();}
};
const claim=(row,stage,units,ref,requestId=randomUUID())=>({
  reportRow:row,stage,units,expectedRef:ref,requestId,
});

test('first and second count require different session actors; staff never see previous units',()=>{
  const {db,service}=context();
  try{
    const p=physical(),w=website(),ref=prepare(p,w);
    let list=service.worklist(staffA,p,w,{},clock);
    assert.equal(list.items[0].stage,'first_needed');
    assert.equal(list.items[1].stage,'first_needed');
    assert.equal(list.items[0].canSubmit,true);
    const first=service.submit(staffA,p,w,claim(1,'first',4,ref),clock);
    assert.equal(first.recorded,true);
    assert.equal(first.ownerApproved,false);
    assert.equal(first.stockImportAuthorized,false);
    list=service.worklist(staffA,p,w,{},clock);
    assert.equal(list.items[0].stage,'second_needed');
    assert.equal(list.items[0].canSubmit,false);
    assert.doesNotMatch(JSON.stringify(list),/firstUnits|secondUnits|staff-a|\\"units\\"/);
    assert.throws(()=>service.submit(staffA,p,w,claim(1,'second',4,ref),clock),
      e=>e.code==='INDEPENDENT_ACCOUNT_REQUIRED');
    const secondList=service.worklist(staffB,p,w,{},clock);
    assert.equal(secondList.items[0].canSubmit,true);
    const second=service.submit(staffB,p,w,claim(1,'second',4,ref),clock);
    assert.equal(second.recorded,true);
    assert.equal(service.worklist(staffB,p,w,{},clock).items[0].stage,'matching_claims_unverified');
    assert.equal(service.worklist(staffB,p,w,{},clock).items[0].canSubmit,false);
    const review=service.ownerReview(p,w,{},clock);
    assert.equal(review.totals.matchingUnverified,1);
    assert.equal(review.totals.firstNeeded,1);
    assert.equal(review.items[0].firstUnits,4);
    assert.equal(review.items[0].secondUnits,4);
    assert.equal(review.items[0].firstActor,'staff-a');
    assert.equal(review.items[0].secondActor,'staff-b');
    assert.equal(review.ownerApproved,false);
    assert.equal(review.independentWitnessVerified,false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.count_claim'").get().n,2);
    assert.throws(()=>db.prepare("UPDATE audit SET subject='changed'").run(),/Immutable/);
  }finally{db.close();}
});

test('discrepant counts remain open; identity holds are blocked from count entry',()=>{
  const {db,service}=context();
  try{
    const p=physical(),w=website(),ref=prepare(p,w);
    service.submit(staffA,p,w,claim(2,'first',7,ref),clock);
    service.submit(manager,p,w,claim(2,'second',8,ref),clock);
    const review=service.ownerReview(p,w,{},clock);
    assert.equal(review.items[1].stage,'discrepant_claims');
    assert.equal(review.totals.discrepancies,1);
    assert.equal(review.stockImportAuthorized,false);
    assert.equal(review.checkoutAuthorized,false);
    assert.throws(()=>service.submit(staffA,p,w,claim(2,'first',9,ref),clock),
      e=>e.code==='COUNT_STAGE_CONFLICT');
    const held=physical('review'),heldRef=prepare(held,w);
    assert.equal(service.worklist(staffA,held,w,{},clock).items[0].stage,'identity_hold');
    assert.throws(()=>service.submit(staffA,held,w,claim(1,'first',4,heldRef),clock),
      e=>e.code==='COUNT_ROW_HELD');
    const later=service.ownerReview(held,w,{},clock);
    assert.equal(later.staleClaimEvents,2);
    assert.equal(later.items[1].stage,'first_needed');
  }finally{db.close();}
});

test('same request key replays unchanged event; reuse with different data conflicts',()=>{
  const {db,service}=context();
  try{
    const p=physical(),w=website(),ref=prepare(p,w),requestId=randomUUID();
    const entry=claim(1,'first',4,ref,requestId);
    const first=service.submit(staffA,p,w,entry,clock);
    const replay=service.submit(staffA,p,w,entry,clock);
    assert.equal(replay.claimId,first.claimId);
    assert.equal(replay.replayed,true);
    assert.throws(()=>service.submit(staffA,p,w,{...entry,units:5},clock),
      e=>e.code==='COUNT_IDEMPOTENCY_CONFLICT');
    assert.throws(()=>service.submit(staffB,p,w,entry,clock),
      e=>e.code==='COUNT_IDEMPOTENCY_CONFLICT');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,1);
  }finally{db.close();}
});

test('invalid units, stale source, incorrect snapshot and owner recording fail closed',()=>{
  const {db,service}=context();
  try{
    const p=physical(),w=website(),ref=prepare(p,w);
    assert.throws(()=>service.submit(owner,p,w,claim(1,'first',2,ref),clock),
      e=>e.code==='COUNT_ROLE_DENIED');
    for(const units of [-1,1.5,1000001,'3',null]){
      assert.throws(()=>service.submit(staffA,p,w,claim(1,'first',units,ref),clock));
    }
    assert.throws(()=>service.submit(staffA,p,w,claim(1,'first',5,'b'.repeat(64)),clock),
      e=>e.code==='COUNT_SNAPSHOT_CHANGED');
    assert.throws(()=>service.submit(staffA,p,website({stale:true}),claim(1,'first',5,ref),clock),
      e=>e.code==='COUNT_EVIDENCE_STALE');
    assert.throws(()=>service.submit(staffA,p,w,claim(1,'second',5,ref),clock),
      e=>e.code==='COUNT_STAGE_CONFLICT');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,0);
  }finally{db.close();}
});

test('worklist and owner review pagination/filter remain snapshot bound and incomplete',()=>{
  const {db,service}=context();
  try{
    const p=physical(),w=website();
    const a=service.ownerReview(p,w,{page:1,pageSize:1},clock);
    const b=service.ownerReview(p,w,{page:2,pageSize:1},clock);
    assert.equal(a.items.length,1);
    assert.equal(b.items.length,1);
    assert.equal(a.snapshotRef,b.snapshotRef);
    assert.equal(b.hasMore,false);
    assert.equal(service.worklist(staffB,p,w,{search:'P2'},clock).total,1);
    assert.equal(service.worklist(staffB,p,w,{search:'2'},clock).total,1);
    assert.equal(a.evidenceVerified,true);
    assert.equal(a.ownerApproved,false);
    assert.equal(a.staleClaimEvents,0);
    for(const invalid of [{page:0},{pageSize:51},{search:'x'.repeat(65)}]){
      assert.throws(()=>service.worklist(staffA,p,w,invalid,clock));
    }
  }finally{db.close();}
});

test('unchanged Woo identity across refreshed catalogue timestamps keeps count claims bound',()=>{
  const {db,service}=context();
  try{
    const p=physical(),w=website();
    const ref=prepare(p,w);
    service.submit(staffA,p,w,claim(1,'first',4,ref),clock);
    const refreshed=website({fetchedAt:new Date(clock+1000).toISOString()});
    assert.equal(prepare(p,refreshed),ref);
    const second=service.submit(staffB,p,refreshed,claim(1,'second',4,ref),clock+2000);
    assert.equal(second.recorded,true);
    assert.equal(service.ownerReview(p,refreshed,{},clock+2000).staleClaimEvents,0);
    assert.notEqual(prepare(p,website({products:[{id:33,type:'simple',sku:'CHANGED'}]})),ref);
  }finally{db.close();}
});
