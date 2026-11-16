import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {InventoryReconciliationPackets} from '../server/inventory-reconciliation-packets.js';

const owner={id:'owner',role:'owner'};
const manager={id:'manager',role:'manager'};
const reviewerId=randomUUID();
const otherReviewerId=randomUUID();
const reviewer={id:reviewerId,role:'reviewer'};
const stranger={id:otherReviewerId,role:'reviewer'};
const sourceHash='a'.repeat(64),ref='b'.repeat(64),reviewerRef='c'.repeat(64);
const NOW=Date.parse('2026-11-16T10:00:00Z');

function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit(
    id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,
    action TEXT NOT NULL,subject TEXT NOT NULL,created_at TEXT NOT NULL
  );
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
  BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
  BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
  const physical={manifestHash:sourceHash,items:[{},{}]},website={};
  const src=[
    {reportRow:1,sku:'DRESS-M',classification:'unique_published_sku',
      latestReview:{id:9,decision:'propose_option',proposedProductId:42,
        proposedVariationId:43,exactSkuMatch:true}},
    {reportRow:2,sku:'DRESS-L',classification:'unique_published_sku',
      latestReview:null},
  ];
  const cnt=[
    {reportRow:1,sku:'DRESS-M',stage:'matching_claims_unverified',
      firstClaimId:1,secondClaimId:2,triage:null},
    {reportRow:2,sku:'DRESS-L',stage:'discrepant_claims',
      firstClaimId:3,secondClaimId:4,triage:null},
  ];
  const mapping={review(_p,_w,_options,_clock,rows){
    rows.push(...src.map(x=>({...x})));
    return {evidenceVerified:true,sourceHash,identityRef:ref};
  }};
  const counts={ownerReview(_p,_w,_options,_clock,rows){
    rows.push(...cnt.map(x=>({...x})));
    return {evidenceVerified:true,snapshotRef:ref,staleClaimEvents:0};
  }};
  let evidenceVariant='e'.repeat(64);
  const exceptionRows=[
    {reportRow:1,sku:'DRESS-M',caseRef:'d'.repeat(64),
      category:'other_unverified',countDiscrepancyOpen:false,
      flags:['fingerprint_match_not_provenance'],reviewerAssignments:[]},
    {reportRow:2,sku:'DRESS-L',caseRef:'f'.repeat(64),
      category:'count_disagreement',countDiscrepancyOpen:true,
      flags:['staff_count_disagreement'],reviewerAssignments:[]},
  ];
  const exceptions={list(_user,_physical,_website,_options,_clock,collect){
    collect.push(...exceptionRows.map(x=>({
      ...x,caseRef:x.reportRow===1?evidenceVariant:x.caseRef,
    })));
    return {snapshotRef:ref,summary:{totalCases:2}};
  }};
  let grantOneStatus='assigned_metadata_only';
  const grants=[
    {grantId:51,reportRow:1,reviewerId,status:'assigned_metadata_only',
      custodyRequestId:5,manifestId:6,fileSha256:'0'.repeat(64)},
    {grantId:52,reportRow:2,reviewerId:otherReviewerId,status:'assigned_metadata_only',
      custodyRequestId:7,manifestId:8,fileSha256:'1'.repeat(64)},
  ];
  const access={
    listOwner(){
      return {
        snapshotRef:reviewerRef,
        stockImportAuthorized:false,checkoutAuthorized:false,
        accounts:[
          {id:reviewerId,username:'review.one',active:true},
          {id:otherReviewerId,username:'review.two',active:true},
        ],
        assignments:grants.map(g=>({...g,status:g.grantId===51?grantOneStatus:g.status})),
      };
    },
    listAssigned(user){
      if(user.role!=='reviewer')throw new Error('reviewer required');
      return {
        snapshotRef:reviewerRef,stockImportAuthorized:false,checkoutAuthorized:false,
        cases:grants.filter(g=>g.reviewerId===user.id).map(g=>({
          ...g,status:g.grantId===51?grantOneStatus:g.status,
          mayAcknowledge:(g.grantId===51?grantOneStatus:g.status)==='assigned_metadata_only',
        })),
      };
    },
  };
  const service=new InventoryReconciliationPackets(db,mapping,counts,exceptions,access);
  const list=()=>service.listOwner(owner,physical,website,{},NOW);
  return {db,physical,website,service,list,
    stale:()=>{evidenceVariant='9'.repeat(64);},
    revoke:()=>{grantOneStatus='revoked';},
    changeStaffSku:()=>{cnt[0].sku='OTHER-SKU';},
  };
}
const proposal=(register,options={})=>{
  const row=register.items[0];
  return {
    reportRow:row.reportRow,grantId:51,
    expectedReadinessRef:register.readinessRef,
    expectedRowEvidenceRef:row.rowEvidenceRef,
    expectedLatestPacketId:row.latestPacket?.id??null,
    intent:'prepare_provisional_count',proposedUnits:12,
    note:'Provisional twelve garments, pending independently signed blind recount.',
    requestId:randomUUID(),...options,
  };
};
test('5.8 Owner proposals remain non-approving, private and bound to assigned case',()=>{
  const x=setup();
  try{
    const first=x.list();
    assert.equal(first.summary.approvedReconciliations,0);
    assert.equal(first.stockImportAuthorized,false);
    assert.equal(first.checkoutAuthorized,false);
    assert.equal(first.summary.historicalRows,2);
    assert.equal(first.items[0].availableGrants[0].grantId,51);
    const payload=proposal(first);
    assert.throws(()=>x.service.propose(manager,x.physical,x.website,payload,NOW),
      e=>e.code==='RECONCILIATION_OWNER_ONLY');
    assert.throws(()=>x.service.propose(reviewer,x.physical,x.website,payload,NOW),
      e=>e.code==='RECONCILIATION_OWNER_ONLY');
    assert.throws(()=>x.service.propose(owner,x.physical,x.website,{
      ...payload,approved:true,
    },NOW),e=>e.name==='ZodError');
    assert.throws(()=>x.service.propose(owner,x.physical,x.website,{
      ...payload,intent:'request_blind_recount',
    },NOW),e=>e.name==='ZodError');
    assert.throws(()=>x.service.propose(owner,x.physical,x.website,{
      ...payload,grantId:52,
    },NOW),e=>e.code==='RECONCILIATION_GRANT_REQUIRED');
    assert.throws(()=>x.service.propose(owner,x.physical,x.website,{
      ...payload,expectedReadinessRef:'2'.repeat(64),
    },NOW),e=>e.code==='RECONCILIATION_READINESS_CHANGED');
    const recorded=x.service.propose(owner,x.physical,x.website,payload,NOW);
    assert.equal(recorded.kind,'owner-unverified-reconciliation-proposal');
    assert.equal(recorded.reconciliationApproved,false);
    assert.equal(recorded.discrepancyClosed,false);
    assert.equal(recorded.inventoryAccepted,false);
    assert.equal(recorded.stockImportAuthorized,false);
    assert.equal(x.service.propose(owner,x.physical,x.website,payload,NOW).replayed,true);
    assert.throws(()=>x.service.propose(owner,x.physical,x.website,{
      ...payload,proposedUnits:100,
    },NOW),e=>e.code==='RECONCILIATION_PROPOSAL_REPLAY_CONFLICT');
    const listed=x.list();
    assert.equal(listed.items[0].latestPacket.proposedUnits,12);
    assert.equal(listed.items[0].latestPacket.status,'provisional_under_account_review');
    assert.equal(listed.items[0].countDiscrepancyOpen,false);
    const visible=x.service.listReviewer(reviewer,x.physical,x.website,NOW);
    assert.equal(visible.kind,'reviewer-provisional-reconciliation-metadata');
    assert.equal(visible.items.length,1);
    assert.equal(visible.items[0].reportRow,1);
    assert.equal(visible.items[0].packetId,recorded.packetId);
    assert.equal(visible.items[0].reconciliationApproved,false);
    assert.doesNotMatch(JSON.stringify(visible),/proposedUnits|twelve garments|42|43|ownerNote|priceCents|customerEmail/);
    assert.equal(x.service.listReviewer(stranger,x.physical,x.website,NOW).items.length,0);
    assert.equal(x.db.prepare("SELECT COUNT(*) n FROM audit").get().n,1);
    assert.throws(()=>x.db.prepare('UPDATE audit SET subject=?').run('hacked'),/immutable/);
  }finally{x.db.close();}
});
test('5.8 reviewer objections are one-time account claims, not certified witness evidence',()=>{
  const x=setup();
  try{
    const packet=x.service.propose(owner,x.physical,x.website,proposal(x.list()),NOW);
    const reply={
      packetId:packet.packetId,expectedReviewerRef:reviewerRef,
      finding:'requires_independent_recount',
      note:'An independent witness must verify the original physical units.',
      requestId:randomUUID(),
    };
    assert.throws(()=>x.service.respond(owner,x.physical,x.website,reply,NOW),
      e=>e.code==='RECONCILIATION_REVIEWER_ONLY');
    assert.throws(()=>x.service.respond(manager,x.physical,x.website,reply,NOW),
      e=>e.code==='RECONCILIATION_REVIEWER_ONLY');
    assert.throws(()=>x.service.respond(stranger,x.physical,x.website,reply,NOW),
      e=>e.code==='RECONCILIATION_PACKET_NOT_ASSIGNED');
    assert.throws(()=>x.service.respond(reviewer,x.physical,x.website,{
      ...reply,approved:true,
    },NOW),e=>e.name==='ZodError');
    assert.throws(()=>x.service.respond(reviewer,x.physical,x.website,{
      ...reply,expectedReviewerRef:'3'.repeat(64),
    },NOW),e=>e.code==='RECONCILIATION_REVIEWER_SNAPSHOT_STALE');
    const recorded=x.service.respond(reviewer,x.physical,x.website,reply,NOW);
    assert.equal(recorded.kind,'reviewer-provisional-reconciliation-objection');
    assert.equal(recorded.reconciliationApproved,false);
    assert.equal(recorded.physicalCountVerified,false);
    assert.equal(recorded.checkoutAuthorized,false);
    assert.equal(x.service.respond(reviewer,x.physical,x.website,reply,NOW).replayed,true);
    assert.throws(()=>x.service.respond(reviewer,x.physical,x.website,{
      ...reply,note:'Different text under the same response UUID identifier.',
    },NOW),e=>e.code==='RECONCILIATION_REVIEW_REPLAY_CONFLICT');
    assert.throws(()=>x.service.respond(reviewer,x.physical,x.website,{
      ...reply,requestId:randomUUID(),
    },NOW),e=>e.code==='RECONCILIATION_REVIEW_ALREADY_RECORDED');
    assert.equal(x.list().items[0].latestPacket.latestResponse.finding,'requires_independent_recount');
    assert.equal(x.list().summary.approvedReconciliations,0);
    assert.equal(x.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='inventory.reconciliation_packet_reviewed'").get().n,1);
    const after=x.list();
    const second=x.service.propose(owner,x.physical,x.website,proposal(after,{
      intent:'request_blind_recount',proposedUnits:null,requestId:randomUUID(),
    }),NOW);
    assert.ok(second.packetId>packet.packetId);
    assert.throws(()=>x.service.respond(reviewer,x.physical,x.website,{
      ...reply,requestId:randomUUID(),
    },NOW),e=>e.code==='RECONCILIATION_PACKET_NOT_ASSIGNED');
    assert.equal(x.service.listReviewer(reviewer,x.physical,x.website,NOW).items[0].packetId,second.packetId);
    assert.equal(x.list().items[0].latestPacket.proposedUnits,null);
    assert.equal(x.list().checkoutAuthorized,false);
  }finally{x.db.close();}
});
test('5.8 stale independent evidence, revoked grants and unrelated role access fail closed',()=>{
  const x=setup();
  try{
    const packet=x.service.propose(owner,x.physical,x.website,proposal(x.list()),NOW);
    x.stale();
    assert.equal(x.list().items[0].latestPacket.status,'stale_evidence');
    assert.equal(x.service.listReviewer(reviewer,x.physical,x.website,NOW).items.length,0);
    assert.throws(()=>x.service.respond(reviewer,x.physical,x.website,{
      packetId:packet.packetId,expectedReviewerRef:reviewerRef,
      finding:'original_document_unavailable',
      note:'The original signed count document is not presently available.',
      requestId:randomUUID(),
    },NOW),e=>e.code==='RECONCILIATION_PACKET_NOT_ASSIGNED');
    x.revoke();
    assert.equal(x.list().items[0].availableGrants.length,0);
    assert.throws(()=>x.service.propose(owner,x.physical,x.website,proposal(x.list(),{
      requestId:randomUUID(),expectedLatestPacketId:packet.packetId,
    }),NOW),e=>e.code==='RECONCILIATION_GRANT_REQUIRED');
    const y=setup();
    try{
      y.changeStaffSku();
      assert.throws(()=>y.list(),e=>e.code==='INVENTORY_DOSSIER_SOURCE_MISMATCH');
    }finally{y.db.close();}
  }finally{x.db.close();}
});
