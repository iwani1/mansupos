import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PhysicalCountClaims} from '../server/physical-count-claims.js';
import {CountSupervisionEvidence} from '../server/count-supervision-evidence.js';
import {PrivateCountFileManifests} from '../server/private-count-file-manifests.js';
import {fingerprintPrivateCountFile,comparePrivateCountFile} from '../src/private-count-file-fingerprint.js';

const clock=Date.parse('2026-11-15T12:00:00.000Z');
const owner={id:'owner',role:'owner'},rep={id:'rep',role:'cashier'},packer={id:'packer',role:'manager'};
const physical=()=>({
  source:'in-store-physical-stock-snapshot',manifestHash:'a'.repeat(64),
  summary:{items:3},items:[
    {reportRow:1,sku:'DRESS-1',status:'available',name:'PRIVATE',stock:900,priceCents:25000},
    {reportRow:2,sku:'DRESS-2',status:'available',name:'PRIVATE',stock:800,priceCents:28000},
    {reportRow:3,sku:'HOLD',status:'review',name:'PRIVATE'},
  ],
});
const woo=(extra={})=>({
  source:'woocommerce',complete:true,stale:false,isDemo:false,
  fetchedAt:new Date(clock).toISOString(),
  products:[{id:55,type:'simple',sku:'DRESS-1'}],...extra,
});
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,action TEXT NOT NULL,subject TEXT NOT NULL,
    created_at TEXT NOT NULL);
    CREATE TRIGGER no_update BEFORE UPDATE ON audit
      BEGIN SELECT RAISE(ABORT,'immutable');END;
    CREATE TRIGGER no_delete BEFORE DELETE ON audit
      BEGIN SELECT RAISE(ABORT,'immutable');END;`);
  const counts=new PhysicalCountClaims(db);
  const supervision=new CountSupervisionEvidence(db,counts);
  return {db,counts,supervision,files:new PrivateCountFileManifests(db,supervision)};
}
function count(ctx,p,w,row,stage,units,actor){
  const ref=ctx.counts.ownerReview(p,w,{},clock).snapshotRef;
  return ctx.counts.submit(actor,p,w,{
    reportRow:row,stage,units,expectedRef:ref,requestId:randomUUID(),
  },clock);
}
function draft(view,row=1){
  const found=view.items.find(x=>x.reportRow===row);
  return {
    reportRow:row,expectedRef:view.snapshotRef,
    expectedLatestManifestId:found.latestManifest?.id??null,
    firstClaimId:found.firstClaimId,secondClaimId:found.secondClaimId,
    documentCode:'COUNT_NOV_PRIVATE_001',documentType:'count_sheet',
    mime:'application/pdf',fileBytes:31,fileSha256:'b'.repeat(64),
    requestId:randomUUID(),
  };
}
test('private count fingerprint is computed in browser helper and compares bytes only',async()=>{
  const bytes=new TextEncoder().encode('%PDF-1.4\nPrivate count notes 2026');
  const file=new Blob([bytes],{type:'application/pdf'});
  const actual=await fingerprintPrivateCountFile(file);
  assert.equal(actual.fileSha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(actual.fileBytes,bytes.length);
  assert.equal(actual.mime,'application/pdf');
  assert.equal(comparePrivateCountFile(actual,{...actual}),'bytes_match');
  assert.equal(comparePrivateCountFile(actual,{...actual,fileSha256:'0'.repeat(64)}),'bytes_differ');
  await assert.rejects(fingerprintPrivateCountFile(new Blob(['not pdf content'],{
    type:'application/pdf',
  })),/header/);
  await assert.rejects(fingerprintPrivateCountFile(new Blob([bytes],{
    type:'text/plain',
  })),/PDF, PNG or JPEG/);
  await assert.rejects(fingerprintPrivateCountFile(new Blob(['small'],{
    type:'application/pdf',
  })),/PDF, PNG or JPEG/);
  const png=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0]);
  assert.equal((await fingerprintPrivateCountFile(new Blob([png],{
    type:'image/png',
  }))).fileBytes,11);
});
test('two claims required; owner can record checksum only, with immutable append-only history',()=>{
  const ctx=setup();try{
    const p=physical(),w=woo();
    assert.equal(ctx.files.list(p,w,{},clock).items[0].status,'waiting_for_counts');
    count(ctx,p,w,1,'first',5,rep);
    const first=ctx.files.list(p,w,{},clock);
    assert.throws(()=>ctx.files.submit(owner,p,w,{...draft(first),
      secondClaimId:99},clock),e=>e.code==='COUNT_DOCUMENT_CLAIMS_INVALID');
    count(ctx,p,w,1,'second',5,packer);
    const before=ctx.files.list(p,w,{},clock);
    assert.equal(before.items[0].status,'missing_manifest');
    const data=draft(before);
    const created=ctx.files.submit(owner,p,w,data,clock);
    assert.equal(created.recorded,true);
    assert.equal(created.documentContentUploaded,false);
    assert.equal(created.independentWitnessVerified,false);
    assert.equal(created.stockImportAuthorized,false);
    assert.equal(ctx.files.submit(owner,p,w,data,clock).replayed,true);
    const after=ctx.files.list(p,w,{},clock);
    assert.equal(after.items[0].status,'manifest_unverified');
    assert.equal(after.items[0].latestManifest.fileSha256,data.fileSha256);
    assert.equal(after.items[0].latestManifest.documentCode,data.documentCode);
    assert.equal(after.items[0].latestManifest.documentContentUploaded,false);
    assert.equal(after.items[0].latestManifest.signatureVerified,false);
    assert.equal(after.totalRecordedUnverified,1);
    assert.notEqual(after.snapshotRef,before.snapshotRef);
    assert.doesNotMatch(JSON.stringify(after),/"name":"PRIVATE"|priceCents|"stock":900|firstUnits|secondUnits/);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.private_count_file_manifest'").get().n,1);
    assert.throws(()=>ctx.db.prepare("UPDATE audit SET action='x'").run(),/immutable/);
  }finally{ctx.db.close();}
});
test('discrepant counts remain open after fingerprint; no approval or independent verification',()=>{
  const ctx=setup();try{
    const p=physical(),w=woo();
    count(ctx,p,w,2,'first',5,rep);
    count(ctx,p,w,2,'second',8,packer);
    const first=ctx.files.list(p,w,{},clock);
    assert.equal(first.items[1].status,'count_discrepancy_open');
    const saved=ctx.files.submit(owner,p,w,draft(first,2),clock);
    assert.equal(saved.ownerApproved,false);
    const after=ctx.files.list(p,w,{},clock);
    assert.equal(after.items[1].status,'count_discrepancy_open');
    assert.ok(after.items[1].latestManifest);
    assert.equal(after.independentWitnessVerified,false);
    assert.equal(after.checkoutAuthorized,false);
  }finally{ctx.db.close();}
});
test('stale/unauthorized submissions, idempotency conflicts, bad hashes and file limits fail closed',()=>{
  const ctx=setup();try{
    const p=physical(),w=woo();
    count(ctx,p,w,1,'first',5,rep);
    count(ctx,p,w,1,'second',5,packer);
    const report=ctx.files.list(p,w,{},clock);
    const input=draft(report);
    assert.throws(()=>ctx.files.submit(rep,p,w,input,clock),e=>e.code==='COUNT_DOCUMENT_OWNER_ONLY');
    assert.throws(()=>ctx.files.submit(owner,p,w,{...input,approved:true},clock));
    assert.throws(()=>ctx.files.submit(owner,p,w,{...input,fileSha256:'z'.repeat(64)},clock));
    assert.throws(()=>ctx.files.submit(owner,p,w,{...input,fileBytes:20*1024*1024},clock));
    assert.throws(()=>ctx.files.submit(owner,p,w,{...input,mime:'text/html'},clock));
    assert.throws(()=>ctx.files.submit(owner,p,w,{...input,documentCode:'Mary Doe'},clock));
    assert.throws(()=>ctx.files.submit(owner,p,w,{...input,firstClaimId:999},clock),
      e=>e.code==='COUNT_DOCUMENT_CLAIMS_INVALID');
    assert.throws(()=>ctx.files.submit(owner,p,w,{...input,expectedRef:'0'.repeat(64)},clock),
      e=>e.code==='COUNT_DOCUMENT_SNAPSHOT_CHANGED');
    assert.throws(()=>ctx.files.submit(owner,p,woo({stale:true}),input,clock),
      e=>e.code==='COUNT_DOCUMENT_EVIDENCE_STALE');
    const saved=ctx.files.submit(owner,p,w,input,clock);
    assert.equal(saved.recorded,true);
    assert.throws(()=>ctx.files.submit(owner,p,w,{...input,fileBytes:32},clock),
      e=>e.code==='COUNT_DOCUMENT_REPLAY_CONFLICT');
    assert.throws(()=>ctx.files.submit(owner,p,w,{...input,requestId:randomUUID()},clock),
      e=>e.code==='COUNT_DOCUMENT_SNAPSHOT_CHANGED');
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='inventory.private_count_file_manifest'").get().n,1);
  }finally{ctx.db.close();}
});
test('source/identity snapshots and shared fingerprint flag are review-only',()=>{
  const ctx=setup();try{
    const p=physical(),w=woo();
    count(ctx,p,w,1,'first',2,rep);
    count(ctx,p,w,1,'second',2,packer);
    count(ctx,p,w,2,'first',8,rep);
    count(ctx,p,w,2,'second',8,packer);
    let report=ctx.files.list(p,w,{},clock);
    ctx.files.submit(owner,p,w,draft(report,1),clock);
    report=ctx.files.list(p,w,{},clock);
    ctx.files.submit(owner,p,w,draft(report,2),clock);
    report=ctx.files.list(p,w,{},clock);
    assert.equal(report.items[0].latestManifest.sameBytesReferencedElsewhere,true);
    assert.equal(report.items[1].latestManifest.sameBytesReferencedElsewhere,true);
    const page1=ctx.files.list(p,w,{page:1,pageSize:1},clock);
    const page2=ctx.files.list(p,w,{page:2,pageSize:1},clock);
    assert.equal(page1.snapshotRef,page2.snapshotRef);
    assert.equal(ctx.files.list(p,w,{search:'DRESS-2'},clock).total,1);
    assert.equal(ctx.files.list(p,w,{status:'manifest_unverified'},clock).total,2);
    for(const q of [{page:0},{pageSize:51},{status:'approved'},{search:'x'.repeat(65)}])
      assert.throws(()=>ctx.files.list(p,w,q,clock));
    const refresh=woo({fetchedAt:new Date(clock+2000).toISOString()});
    assert.equal(ctx.files.list(p,refresh,{},clock).snapshotRef,report.snapshotRef);
    const changed=woo({products:[{id:55,type:'simple',sku:'DIFFERENT'}]});
    assert.notEqual(ctx.files.list(p,changed,{},clock).snapshotRef,report.snapshotRef);
    assert.equal(ctx.files.list(p,changed,{},clock).items[0].latestManifest,null);
  }finally{ctx.db.close();}
});
