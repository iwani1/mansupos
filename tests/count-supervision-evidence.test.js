import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PhysicalCountClaims} from '../server/physical-count-claims.js';
import {CountSupervisionEvidence} from '../server/count-supervision-evidence.js';

const clock=Date.parse('2026-11-15T12:00:00.000Z');
const owner={id:'owner',role:'owner'};
const firstCounter={id:'salesrep',role:'cashier'};
const secondCounter={id:'fulfilment',role:'manager'};
const physical=(items,other={})=>({
  source:'in-store-physical-stock-snapshot',manifestHash:'a'.repeat(64),
  summary:{items:items.length},items,...other,
});
const row=(reportRow,sku,status='available')=>({
  reportRow,sku,status,name:'PRIVATE FASHION STYLE',priceCents:30000,stock:999,
});
const p=()=>physical([row(1,'DRESS-1'),row(2,'DRESS-2'),row(3,'HOLD','review')]);
const w=(extra={})=>({
  source:'woocommerce',complete:true,stale:false,isDemo:false,
  fetchedAt:new Date(clock).toISOString(),
  products:[{id:60,type:'simple',sku:'DRESS-1'}],...extra,
});
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit(
    id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,
    action TEXT NOT NULL,subject TEXT NOT NULL,created_at TEXT NOT NULL
  );CREATE TRIGGER no_edit BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT,'audit append-only');END;
    CREATE TRIGGER no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT,'audit append-only');END;`);
  const count=new PhysicalCountClaims(db);
  return {db,count,service:new CountSupervisionEvidence(db,count)};
}
const add=(count,physical,website,reportRow,actor,stage,units)=>{
  const plan=count.ownerReview(physical,website,{},clock);
  return count.submit(actor,physical,website,{
    reportRow,stage,units,expectedRef:plan.snapshotRef,requestId:randomUUID(),
  },clock);
};
const note=(view,reportRow,action='observed_count_procedure')=>{
  const selected=view.items.find(x=>x.reportRow===reportRow);
  return {
    reportRow,expectedRef:view.snapshotRef,
    firstClaimId:selected.firstClaimId,secondClaimId:selected.secondClaimId,
    expectedLatestNoteId:selected.latestNote?.id??null,
    action,documentCode:'COUNT_SESSION_001',
    note:'Owner records an observation only, without approving stock.',
    requestId:randomUUID(),
  };
};

test('owner evidence requires two distinct staff claims and never certifies witnessed stock',()=>{
  const ctx=setup();
  try{
    const source=p(),website=w();
    const initial=ctx.service.list(source,website,{},clock);
    assert.equal(initial.totals.awaitingTwoCounts,2);
    assert.equal(initial.items[2].status,'identity_hold');
    assert.equal(initial.ownerApproved,false);
    assert.equal(initial.physicallyWitnessed,false);
    assert.equal(initial.independentWitnessVerified,false);
    assert.equal(initial.stockImportAuthorized,false);
    assert.equal(initial.checkoutAuthorized,false);
    // No first or second count IDs exist, so strict request validation denies input.
    assert.throws(()=>ctx.service.submit(owner,source,website,note(initial,1),clock));
    add(ctx.count,source,website,1,firstCounter,'first',4);
    const one=ctx.service.list(source,website,{},clock);
    assert.notEqual(one.snapshotRef,initial.snapshotRef);
    assert.throws(()=>ctx.service.submit(owner,source,website,{
      ...note(one,1),secondClaimId:1,
    },clock),e=>e.code==='COUNT_SUPERVISION_CLAIMS_INVALID');
    add(ctx.count,source,website,1,secondCounter,'second',4);
    const both=ctx.service.list(source,website,{},clock);
    assert.equal(both.items[0].status,'supervision_note_needed');
    assert.notEqual(both.snapshotRef,one.snapshotRef);
    const entry=note(both,1);
    const saved=ctx.service.submit(owner,source,website,entry,clock);
    assert.equal(saved.recorded,true);
    assert.equal(saved.ownerApproved,false);
    assert.equal(saved.independentWitnessVerified,false);
    assert.equal(saved.checkoutAuthorized,false);
    const replay=ctx.service.submit(owner,source,website,entry,clock);
    assert.equal(replay.replayed,true);
    assert.equal(replay.noteId,saved.noteId);
    const updated=ctx.service.list(source,website,{},clock);
    assert.equal(updated.items[0].status,'supervision_note_unverified');
    assert.equal(updated.items[0].latestNote.documentCode,'COUNT_SESSION_001');
    assert.equal(updated.items[0].firstCounterAccountId,'salesrep');
    assert.equal(updated.items[0].secondCounterAccountId,'fulfilment');
    assert.notEqual(updated.snapshotRef,both.snapshotRef);
    assert.equal(updated.totals.unverifiedNotes,1);
    assert.equal(updated.totals.physicalWitnessesVerified,0);
    assert.equal(updated.independentWitnessVerified,false);
    assert.doesNotMatch(JSON.stringify(updated),/PRIVATE FASHION STYLE|priceCents|"stock":999|firstUnits|secondUnits/);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.count_supervision_note'").get().n,1);
    assert.throws(()=>ctx.db.prepare("DELETE FROM audit").run(),/audit append-only/);
  }finally{ctx.db.close();}
});

test('discrepant claims stay OPEN after owner flags investigation, no matching-observation bypass',()=>{
  const ctx=setup();
  try{
    const source=p(),website=w();
    add(ctx.count,source,website,2,firstCounter,'first',10);
    add(ctx.count,source,website,2,secondCounter,'second',12);
    const r=ctx.service.list(source,website,{},clock);
    assert.equal(r.items[1].status,'count_discrepancy_open');
    assert.throws(()=>ctx.service.submit(owner,source,website,note(r,2),clock),
      e=>e.code==='COUNT_SUPERVISION_DISCREPANCY_OPEN');
    const saved=ctx.service.submit(owner,source,website,
      note(r,2,'flag_discrepancy'),clock);
    assert.equal(saved.recorded,true);
    const after=ctx.service.list(source,website,{},clock);
    assert.equal(after.items[1].status,'count_discrepancy_open');
    assert.equal(after.items[1].latestNote.action,'flag_discrepancy');
    assert.equal(after.stockImportAuthorized,false);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.count_supervision_note'").get().n,1);
  }finally{ctx.db.close();}
});

test('owner-only notes reject approval fields, invalid references, stale pages and UUID conflicts',()=>{
  const ctx=setup();
  try{
    const source=p(),website=w();
    add(ctx.count,source,website,1,firstCounter,'first',5);
    add(ctx.count,source,website,1,secondCounter,'second',5);
    const r=ctx.service.list(source,website,{},clock);
    const entry=note(r,1);
    assert.throws(()=>ctx.service.submit(firstCounter,source,website,entry,clock),
      e=>e.code==='COUNT_SUPERVISION_OWNER_ONLY');
    for(const invalid of [
      {...entry,approved:true},{...entry,action:'approve_stock'},
      {...entry,documentCode:'https://public.example/a'},
      {...entry,note:'short'},
    ])assert.throws(()=>ctx.service.submit(owner,source,website,invalid,clock));
    assert.throws(()=>ctx.service.submit(owner,source,website,{
      ...entry,expectedRef:'b'.repeat(64),
    },clock),e=>e.code==='COUNT_SUPERVISION_SNAPSHOT_CHANGED');
    assert.throws(()=>ctx.service.submit(owner,source,website,{
      ...entry,firstClaimId:999,
    },clock),e=>e.code==='COUNT_SUPERVISION_CLAIMS_INVALID');
    const saved=ctx.service.submit(owner,source,website,entry,clock);
    assert.equal(saved.recorded,true);
    assert.throws(()=>ctx.service.submit(owner,source,website,{
      ...entry,requestId:randomUUID(),
    },clock),e=>e.code==='COUNT_SUPERVISION_SNAPSHOT_CHANGED');
    assert.throws(()=>ctx.service.submit(owner,source,website,{
      ...entry,note:'Different observation, same requestId',
    },clock),e=>e.code==='COUNT_SUPERVISION_REPLAY_CONFLICT');
    assert.equal(ctx.service.submit(owner,source,website,entry,clock).replayed,true);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.count_supervision_note'").get().n,1);
  }finally{ctx.db.close();}
});

test('evidence snapshots are page-bound; source identity changes quarantine older notes',()=>{
  const ctx=setup();
  try{
    const source=p(),website=w();
    add(ctx.count,source,website,1,firstCounter,'first',7);
    add(ctx.count,source,website,1,secondCounter,'second',7);
    const old=ctx.service.list(source,website,{pageSize:1},clock);
    const next=ctx.service.list(source,website,{page:2,pageSize:1},clock);
    assert.equal(old.snapshotRef,next.snapshotRef);
    assert.equal(next.items.length,1);
    ctx.service.submit(owner,source,website,
      note(ctx.service.list(source,website,{},clock),1),clock);
    const current=ctx.service.list(source,website,{},clock);
    assert.notEqual(old.snapshotRef,current.snapshotRef);
    assert.equal(ctx.service.list(source,website,{status:'supervision_note_unverified'},clock).total,1);
    assert.equal(ctx.service.list(source,website,{search:'DRESS-1'},clock).total,1);
    for(const invalid of [{status:'approved'},{page:0},{pageSize:51},{search:'x'.repeat(65)}])
      assert.throws(()=>ctx.service.list(source,website,invalid,clock));
    const refreshed=w({fetchedAt:new Date(clock+1000).toISOString()});
    assert.equal(ctx.service.list(source,refreshed,{},clock).snapshotRef,current.snapshotRef);
    const changed=w({products:[{id:60,type:'simple',sku:'CHANGED'}]});
    assert.notEqual(ctx.service.list(source,changed,{},clock).snapshotRef,current.snapshotRef);
    assert.equal(ctx.service.list(source,changed,{},clock).items[0].latestNote,null);
    assert.equal(ctx.service.list(source,changed,{},clock).independentWitnessVerified,false);
    assert.throws(()=>ctx.service.submit(owner,source,w({stale:true}),
      {...note(current,1),requestId:randomUUID()},clock),
      e=>e.code==='COUNT_SUPERVISION_SOURCE_STALE');
  }finally{ctx.db.close();}
});
