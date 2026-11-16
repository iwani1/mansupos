import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { InventoryEvidenceExceptionReview } from '../server/inventory-evidence-exceptions.js';

const owner={id:'owner',role:'owner'};
const staff={id:'staff',role:'manager'};
const reviewer={id:'reviewer',role:'reviewer'};
const HASH='a'.repeat(64),REF='b'.repeat(64);
const physical={manifestHash:HASH};
const website={};
const NOW=Date.parse('2026-11-16T08:00:00Z');

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,
    action TEXT NOT NULL,subject TEXT NOT NULL,created_at TEXT NOT NULL
  ); CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
    BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
    BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
  let evidenceRef=REF,receiptStatus='fingerprint_mismatch_reported';
  const rows=[
    {reportRow:1,sku:'SKU-COUNT',mayReport:true,status:'awaiting_external_response',
      custodyRequestId:11,manifestId:21,fileSha256:'c'.repeat(64),
      firstClaimId:31,secondClaimId:32,countDiscrepancyOpen:true,
      latestResponse:null},
    {reportRow:2,sku:'SKU-REVIEW',mayReport:true,status:'reported_discrepancy_open',
      custodyRequestId:12,manifestId:22,fileSha256:'d'.repeat(64),
      firstClaimId:33,secondClaimId:34,countDiscrepancyOpen:false,
      latestResponse:{id:41,outcome:'discrepancy_reported',issueCode:'signature_missing'}},
    {reportRow:3,sku:'SKU-HOLD',mayReport:false,status:'custody_or_source_hold',
      custodyRequestId:null,manifestId:null,fileSha256:null,
      firstClaimId:null,secondClaimId:null,countDiscrepancyOpen:false,
      latestResponse:null},
    {reportRow:4,sku:'SKU-MATCH',mayReport:true,status:'awaiting_external_response',
      custodyRequestId:14,manifestId:24,fileSha256:'e'.repeat(64),
      firstClaimId:36,secondClaimId:37,countDiscrepancyOpen:false,
      latestResponse:null},
  ];
  const intake={
    list(_physical,_website,_options,_clock,collectRows){
      if(collectRows)collectRows.push(...rows.map(x=>({...x})));
      return {evidenceVerified:true,snapshotRef:evidenceRef,sourceHash:HASH};
    },
  };
  const access={
    listOwner(){
      return {
        snapshotRef:evidenceRef,stockImportAuthorized:false,checkoutAuthorized:false,
        assignments:[
          {reportRow:1,grantId:100,reviewerId:'account-1',
            status:'assigned_metadata_only',latestAcknowledgement:{
              id:400,outcome:'evidence_issue_reported',issueCode:'count_numbers_conflict',
            },handoff:{status:'account_receipt_recorded',receipt:{
              id:500,observation:receiptStatus,
              observedFileSha256:'f'.repeat(64),
            }}},
          {reportRow:2,grantId:101,reviewerId:'account-2',
            status:'assigned_metadata_only',latestAcknowledgement:null,
            handoff:{status:'awaiting_challenge',receipt:null}},
          {reportRow:4,grantId:102,reviewerId:'account-3',
            status:'assigned_metadata_only',latestAcknowledgement:{
              id:402,outcome:'review_request_seen',issueCode:null,
            },handoff:{status:'account_receipt_recorded',receipt:{
              id:501,observation:'fingerprint_match_reported',
              observedFileSha256:'e'.repeat(64),
            }}},
        ],
      };
    },
  };
  const service=new InventoryEvidenceExceptionReview(db,intake,access);
  return {db,service,rows,
    setReceiptStatus:x=>{receiptStatus=x;},
    setEvidenceRef:x=>{evidenceRef=x;},
    setReviewerMismatch:()=>{access.listOwner=()=>({
      snapshotRef:'f'.repeat(64),stockImportAuthorized:false,
      checkoutAuthorized:false,assignments:[],
    });},
  };
}
function followup(report,rowNumber=1){
  const row=report.items.find(x=>x.reportRow===rowNumber);
  assert.ok(row);
  return {
    reportRow:rowNumber,expectedRef:report.snapshotRef,
    expectedCaseRef:row.caseRef,
    expectedLatestEventId:row.latestFollowup?.id??null,
    action:'request_independent_recount',
    note:'Ask two independent staff to recount this garment and variation.',
    requestId:randomUUID(),
  };
}
test('5.6: owner queue aggregates all unresolved evidence without treating matching hashes as inventory approval',()=>{
  const f=fixture();try{
    assert.throws(()=>f.service.list(staff,physical,website),e=>e.code==='EVIDENCE_EXCEPTION_OWNER_ONLY');
    assert.throws(()=>f.service.list(reviewer,physical,website),e=>e.code==='EVIDENCE_EXCEPTION_OWNER_ONLY');
    const report=f.service.list(owner,physical,website,{},NOW);
    assert.equal(report.kind,'owner-inventory-evidence-exception-queue');
    assert.equal(report.total,4);
    assert.equal(report.summary.staffCountDisagreements,1);
    assert.equal(report.summary.approvedCases,0);
    assert.equal(report.summary.independentlyVerifiedCases,0);
    assert.equal(report.stockImportAuthorized,false);
    assert.equal(report.checkoutAuthorized,false);
    assert.equal(report.caseClosed,false);
    assert.equal(report.inventoryAccepted,false);
    assert.equal(report.items[0].category,'count_disagreement');
    assert.ok(report.items[0].flags.includes('fingerprint_mismatch_reported'));
    assert.equal(report.items[1].category,'reviewer_evidence_issue');
    assert.equal(report.items[2].category,'custody_or_source_hold');
    assert.equal(report.items[3].category,'other_unverified');
    assert.ok(report.items[3].flags.includes('fingerprint_match_not_provenance'));
    assert.equal(report.items[3].inventoryAccepted,false);
    assert.equal(report.items[0].caseKey,undefined,'Private evidence key must not leave the owner queue.');
    assert.equal(f.service.list(owner,physical,website,{
      status:'reviewer_evidence_issue',page:1,pageSize:1,
    },NOW).total,1);
    assert.equal(f.service.list(owner,physical,website,{
      page:2,pageSize:2,
    },NOW).items[0].reportRow,3);
    assert.throws(()=>f.service.list(owner,physical,website,{
      page:1,pageSize:25,approve:true,
    },NOW),e=>e.name==='ZodError');
    f.setReviewerMismatch();
    assert.throws(()=>f.service.list(owner,physical,website,{},NOW),
      e=>e.code==='EVIDENCE_EXCEPTION_REVIEWER_STALE');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit").get().n,0);
  }finally{f.db.close();}
});
test('5.6: owner follow-ups are append-only, idempotent and cannot close staff count disputes',()=>{
  const f=fixture();try{
    const initial=f.service.list(owner,physical,website,{},NOW);
    const data=followup(initial);
    assert.throws(()=>f.service.followup(staff,physical,website,data,NOW),
      e=>e.code==='EVIDENCE_EXCEPTION_OWNER_ONLY');
    assert.throws(()=>f.service.followup(owner,physical,website,{
      ...data,stockImportAuthorized:true,
    },NOW),e=>e.name==='ZodError');
    assert.throws(()=>f.service.followup(owner,physical,website,{
      ...data,expectedRef:'0'.repeat(64),
    },NOW),e=>e.code==='EVIDENCE_EXCEPTION_SNAPSHOT_CHANGED');
    assert.throws(()=>f.service.followup(owner,physical,website,{
      ...data,expectedCaseRef:'0'.repeat(64),
    },NOW),e=>e.code==='EVIDENCE_EXCEPTION_CASE_CHANGED');
    const result=f.service.followup(owner,physical,website,data,NOW);
    assert.equal(result.recorded,true);
    assert.equal(result.replayed,false);
    assert.equal(result.inventoryAccepted,false);
    assert.equal(result.caseClosed,false);
    assert.equal(result.stockImportAuthorized,false);
    assert.equal(f.service.followup(owner,physical,website,data,NOW).replayed,true);
    assert.throws(()=>f.service.followup(owner,physical,website,{
      ...data,note:'Different payload with the same immutable request UUID.',
    },NOW),e=>e.code==='EVIDENCE_EXCEPTION_REPLAY_CONFLICT');
    assert.throws(()=>f.service.followup(owner,physical,website,{
      ...data,requestId:randomUUID(),
    },NOW),e=>e.code==='EVIDENCE_EXCEPTION_SNAPSHOT_CHANGED');
    const updated=f.service.list(owner,physical,website,{},NOW);
    const row=updated.items[0];
    assert.equal(row.countDiscrepancyOpen,true);
    assert.equal(row.category,'count_disagreement');
    assert.equal(row.caseClosed,false);
    assert.equal(row.latestFollowup.action,'request_independent_recount');
    assert.equal(row.historicalFollowupCount,1);
    assert.notEqual(updated.snapshotRef,initial.snapshotRef);
    const second=f.service.followup(owner,physical,website,{
      ...followup(updated),action:'inspect_original_outside_pos',
      requestId:randomUUID(),
    },NOW);
    assert.equal(second.recorded,true);
    const newer=f.service.list(owner,physical,website,{},NOW);
    assert.equal(newer.items[0].historicalFollowupCount,2);
    assert.equal(newer.items[0].latestFollowup.action,'inspect_original_outside_pos');
    // Reviewer evidence changes: old owner notes remain in the historical
    // journal, but must not reappear as a current evidence-matched follow-up.
    f.setReceiptStatus('file_not_available');
    const changed=f.service.list(owner,physical,website,{},NOW);
    assert.equal(changed.items[0].latestFollowup,null);
    assert.equal(changed.items[0].historicalFollowupCount,2);
    assert.equal(changed.items[0].countDiscrepancyOpen,true);
    assert.throws(()=>f.service.followup(owner,physical,website,{
      ...followup(newer),requestId:randomUUID(),
    },NOW),e=>e.code==='EVIDENCE_EXCEPTION_SNAPSHOT_CHANGED');
    const audits=f.db.prepare("SELECT action FROM audit ORDER BY id").all();
    assert.equal(audits.length,2);
    assert.ok(audits.every(x=>x.action==='inventory.evidence_exception_followup'));
    assert.throws(()=>f.db.prepare('UPDATE audit SET subject=?').run('changed'),/immutable/);
    assert.throws(()=>f.db.prepare('DELETE FROM audit').run(),/immutable/);
  }finally{f.db.close();}
});
