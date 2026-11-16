import test from 'node:test';
import assert from 'node:assert/strict';
import {buildInventoryVerificationReadiness} from '../server/inventory-verification-readiness.js';

const HASH='a'.repeat(64),DOS='b'.repeat(64),EXC='c'.repeat(64);
const owner={id:'owner',role:'owner'};
const staff={id:'manager',role:'manager'};
const reviewer={id:'reviewer',role:'reviewer'};
const clock=Date.parse('2026-11-16T09:00:00Z');

function fixture(){
  const src=[
    {reportRow:1,sku:'DRESS-RED-M',classification:'unique_published_sku',
      latestReview:{id:101,decision:'propose_option',proposedProductId:42,
        proposedVariationId:3,exactSkuMatch:true}},
    {reportRow:2,sku:'DRESS-BLACK-L',classification:'held',
      latestReview:null},
    {reportRow:3,sku:'DRESS-BLUE-XL',classification:'unique_published_sku',
      latestReview:{id:103,decision:'propose_option',proposedProductId:43,
        proposedVariationId:4,exactSkuMatch:true}},
    {reportRow:4,sku:'DRESS-GOLD-S',classification:'unique_published_sku',
      latestReview:null},
  ];
  const cnt=[
    {reportRow:1,sku:'DRESS-RED-M',stage:'discrepant_claims',
      firstClaimId:11,secondClaimId:12,triage:null},
    {reportRow:2,sku:'DRESS-BLACK-L',stage:'identity_hold',
      firstClaimId:null,secondClaimId:null,triage:null},
    {reportRow:3,sku:'DRESS-BLUE-XL',stage:'matching_claims_unverified',
      firstClaimId:13,secondClaimId:14,triage:null},
    {reportRow:4,sku:'DRESS-GOLD-S',stage:'first_needed',
      firstClaimId:null,secondClaimId:null,triage:null},
  ];
  const physical={manifestHash:HASH,items:[{},{},{},{}]};
  const website={};
  let exceptionRevision=EXC,sourceValid=true;
  let missingRow=false,identityConflict=false;
  const mapping={
    review(_p,_w,_opts,_clock,collect){
      collect.push(...src.map(x=>({...x})));
      return {evidenceVerified:sourceValid,sourceHash:HASH,identityRef:DOS};
    },
  };
  const counts={
    ownerReview(_p,_w,_opts,_clock,collect){
      collect.push(...cnt.map(x=>({...x})));
      return {evidenceVerified:true,snapshotRef:DOS,staleClaimEvents:0};
    },
  };
  const ex=[
    {reportRow:1,sku:src[0].sku,caseRef:'f'.repeat(64),
      category:'count_disagreement',flags:[
        'staff_count_disagreement','fingerprint_mismatch_reported',
      ],countDiscrepancyOpen:true,
      reviewerAssignments:[{status:'assigned_metadata_only',
        handoffStatus:'account_receipt_recorded',
        receiptObservation:'fingerprint_mismatch_reported'}]},
    {reportRow:2,sku:src[1].sku,caseRef:'e'.repeat(64),
      category:'custody_or_source_hold',flags:[
        'custody_or_source_not_ready','authenticated_reviewer_missing',
      ],countDiscrepancyOpen:false,reviewerAssignments:[]},
    {reportRow:3,sku:src[2].sku,caseRef:'d'.repeat(64),
      category:'other_unverified',flags:['fingerprint_match_not_provenance'],
      countDiscrepancyOpen:false,reviewerAssignments:[{
        status:'assigned_metadata_only',handoffStatus:'account_receipt_recorded',
        receiptObservation:'fingerprint_match_reported'}]},
    {reportRow:4,sku:src[3].sku,caseRef:'a'.repeat(64),
      category:'handoff_action_needed',flags:['handoff_not_confirmed'],
      countDiscrepancyOpen:false,reviewerAssignments:[]},
  ];
  const exceptions={
    list(_owner,_physical,_website,_options,_clock,collect){
      const values=missingRow?ex.slice(0,-1):ex;
      collect.push(...values.map(x=>({
        ...x,sku:identityConflict&&x.reportRow===1?'WRONG-SKU':x.sku,
      })));
      return {
        snapshotRef:exceptionRevision,
        summary:{totalCases:missingRow?ex.length-1:ex.length},
      };
    },
  };
  const build=(options={},user=owner)=>buildInventoryVerificationReadiness(
    physical,website,mapping,counts,exceptions,user,options,clock);
  return {build,physical,src,cnt,ex,
    invalidate:()=>{sourceValid=false;},
    changeRevision:()=>{exceptionRevision='9'.repeat(64);ex[2].caseRef='8'.repeat(64);},
    removeRow:()=>{missingRow=true;},
    conflict:()=>{identityConflict=true;},
    duplicate:()=>{ex[1].reportRow=1;},
  };
}

test('5.7: missing, contradictory and matching-unverified evidence all remain BLOCKED',()=>{
  const f=fixture();
  const report=f.build();
  assert.equal(report.kind,'owner-inventory-verification-readiness');
  assert.equal(report.summary.totalHistoricalRows,4);
  assert.equal(report.summary.countDisputes,1);
  assert.equal(report.summary.matchingStaffClaimsUnverified,1);
  assert.equal(report.summary.ownerProposalsRecorded,2);
  assert.equal(report.summary.reportedHashMatchesUnverified,1);
  assert.equal(report.summary.independentlyVerifiedRows,0);
  assert.equal(report.summary.readyForStockImport,0);
  assert.equal(report.summary.acceptedRows,0);
  assert.equal(report.stockImportAuthorized,false);
  assert.equal(report.checkoutAuthorized,false);
  assert.equal(report.paymentsAuthorized,false);
  assert.equal(report.releaseReady,false);
  assert.equal(report.acceptanceCertificateIssued,false);
  assert.ok(report.globalRequirements.length>=6);
  assert.ok(report.globalRequirements.every(x=>x.verified===false));
  assert.equal(report.items[0].priority,'count_disputes');
  assert.equal(report.items[0].staffCountDiscrepancyOpen,true);
  assert.equal(report.items[0].criteria.find(x=>x.id==='reported_file_fingerprint').state,'conflicting');
  assert.equal(report.items[1].priority,'identity_holds');
  assert.equal(report.items[1].criteria.find(x=>x.id==='source_sku_identity').state,'held');
  assert.equal(report.items[2].priority,'other_missing');
  assert.equal(report.items[2].reportedFileFingerprintMatch,true);
  assert.equal(report.items[2].staffCountsMatchingUnverified,true);
  assert.equal(report.items[2].criteria.find(x=>x.id==='two_staff_declarations').state,'observed_unverified');
  assert.equal(report.items[2].criteria.find(x=>x.id==='reported_file_fingerprint').state,'observed_unverified');
  assert.equal(report.items[2].approved,false);
  for(const r of report.items){
    assert.equal(r.readiness,'blocked');
    assert.equal(r.stockImportAuthorized,false);
    assert.equal(r.checkoutAuthorized,false);
    assert.equal(r.independentlyVerified,false);
    assert.equal(r.criteria.length,9);
    assert.ok(r.criteria.every(x=>x.independentlyVerified===false));
    assert.ok(r.criteria.every(x=>!['verified','passed','approved','ready'].includes(x.state)));
  }
  assert.equal(f.build({focus:'count_disputes'}).total,1);
  assert.equal(f.build({focus:'identity_holds'}).items[0].reportRow,2);
  assert.equal(f.build({focus:'reviewer_handoff'}).items[0].reportRow,4);
  assert.equal(f.build({page:2,pageSize:2}).items[0].reportRow,3);
  assert.equal(f.build({search:'BLUE'}).items[0].reportRow,3);
  assert.equal(f.build({search:'4'}).total,1);
  assert.throws(()=>f.build({focus:'approved'}),e=>e.code==='INVENTORY_READINESS_INVALID_FILTER');
  assert.throws(()=>f.build({},staff),e=>e.code==='INVENTORY_READINESS_OWNER_ONLY');
  assert.throws(()=>f.build({},reviewer),e=>e.code==='INVENTORY_READINESS_OWNER_ONLY');
});
test('5.7: missing, duplicated, mismatched and stale sources fail closed',()=>{
  const f=fixture();
  const original=f.build().readinessRef;
  f.changeRevision();
  assert.notEqual(f.build().readinessRef,original);
  f.removeRow();
  assert.throws(()=>f.build(),e=>e.code==='INVENTORY_READINESS_EVIDENCE_MISMATCH');
  const g=fixture();g.conflict();
  assert.throws(()=>g.build(),e=>e.code==='INVENTORY_READINESS_ROW_MISMATCH');
  const h=fixture();h.duplicate();
  assert.throws(()=>h.build(),e=>e.code==='INVENTORY_READINESS_DUPLICATE_ROW');
  const i=fixture();i.invalidate();
  assert.throws(()=>i.build(),e=>e.code==='INVENTORY_READINESS_EVIDENCE_MISMATCH');
});
