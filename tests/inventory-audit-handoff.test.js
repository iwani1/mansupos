import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {
  InventoryAuditHandoff,canonicalEvidenceJSON,
} from '../server/inventory-audit-handoff.js';
import {buildInventoryVerificationReadiness} from '../server/inventory-verification-readiness.js';

const owner={id:'owner',role:'owner'};
const reviewer={id:'reviewer',role:'reviewer'};
const HASH='a'.repeat(64),REF='b'.repeat(64),EXC='c'.repeat(64),REV='d'.repeat(64);
const NOW=Date.parse('2026-11-16T11:00:00Z');
function fixture(){
  const physical={manifestHash:HASH,items:[{},{}]},website={};
  const mapRows=[
    {reportRow:1,sku:'DRESS-S',classification:'unique_published_sku',
      latestReview:{decision:'propose_option',id:8,proposedProductId:41,
        proposedVariationId:13,exactSkuMatch:true}},
    {reportRow:2,sku:'DRESS-L',classification:'held',latestReview:null},
  ];
  const countRows=[
    {reportRow:1,sku:'DRESS-S',stage:'matching_claims_unverified',
      firstClaimId:11,secondClaimId:12,triage:null},
    {reportRow:2,sku:'DRESS-L',stage:'discrepant_claims',
      firstClaimId:13,secondClaimId:14,triage:null},
  ];
  const mapping={review(_physical,_website,_options,_clock,rows){
    rows.push(...mapRows.map(x=>({...x})));
    return {evidenceVerified:true,sourceHash:HASH,identityRef:REF};
  }};
  const counts={ownerReview(_physical,_website,_options,_clock,rows){
    rows.push(...countRows.map(x=>({...x})));
    return {evidenceVerified:true,snapshotRef:REF,staleClaimEvents:0};
  }};
  const exRows=[
    {reportRow:1,sku:'DRESS-S',caseRef:'e'.repeat(64),category:'other_unverified',
      flags:['fingerprint_match_not_provenance'],countDiscrepancyOpen:false,
      reviewerAssignments:[]},
    {reportRow:2,sku:'DRESS-L',caseRef:'f'.repeat(64),category:'count_disagreement',
      flags:['staff_count_disagreement'],countDiscrepancyOpen:true,
      reviewerAssignments:[]},
  ];
  const exceptions={list(_user,_physical,_website,_options,_clock,rows){
    rows.push(...exRows.map(x=>({...x})));
    return {snapshotRef:EXC,summary:{totalCases:exRows.length}};
  }};
  let compromised=false;
  let extra=false;
  const packets={
    listOwner(user,p,w,_opts,clock,rows){
      const prepared=[];
      const report=buildInventoryVerificationReadiness(
        p,w,mapping,counts,exceptions,user,{page:1,pageSize:1},clock,prepared);
      const items=prepared.map(r=>({
        reportRow:r.reportRow,
        sku:compromised&&r.reportRow===1?'WRONG-ROW':r.sku,
        readiness:'blocked',rowEvidenceRef:r.evidenceRef,
        availableGrants:[],
        latestPacket:r.reportRow===1?{
          id:99,proposedUnits:99,
          note:'VERY_PRIVATE_OWNER_NOTE',
          intent:'prepare_provisional_count',status:'provisional_under_account_review',
          latestResponse:{finding:extra?'product_variation_uncertain':
            'requires_independent_recount',note:'PRIVATE_REVIEWER_NOTE'},
        }:null,
      }));
      if(extra&&compromised)items.push({...items[0]});
      rows.push(...items);
      return {auditOnly:true,provisionalOnly:true,
        stockImportAuthorized:false,readinessRef:report.readinessRef,
        snapshotRef:REV,summary:{historicalRows:items.length}};
    },
  };
  const svc=new InventoryAuditHandoff(mapping,counts,exceptions,packets);
  const build=(role=owner)=>svc.build(role,physical,website,NOW);
  return {build,exRows,changeFinding:()=>{extra=true;},breakIdentity:()=>{compromised=true;},
    duplicate:()=>{extra=true;compromised=true;},
    invalidate:()=>{countRows[0].sku='INCORRECT_COUNT_SKU';},
  };
}
test('5.9 deterministic minimized offline manifest excludes Owner secrets and never authorizes stock',()=>{
  const f=fixture();
  const first=f.build(),again=f.build();
  assert.equal(first.kind,'owner-inventory-audit-handoff');
  assert.equal(first.sha256,again.sha256);
  assert.match(first.sha256,/^[a-f0-9]{64}$/);
  assert.equal(first.content.items.length,2);
  assert.equal(first.content.summary.disputedRows,1);
  assert.equal(first.content.summary.acceptedRows,0);
  assert.equal(first.content.items[0].latestProvisionalPacket.id,99);
  assert.equal(first.content.items[0].latestProvisionalPacket.reviewerAccountFinding,
    'requires_independent_recount');
  assert.equal(first.content.items[1].staffCountDiscrepancyOpen,true);
  assert.equal(first.stockImportAuthorized,false);
  assert.equal(first.paymentsAuthorized,false);
  assert.equal(first.inventoryAccepted,false);
  assert.equal(first.releaseReady,false);
  assert.ok(first.content.globalRequirements.every(g=>g.verified===false));
  assert.ok(first.content.items.every(g=>g.physicalStockVerified===false&&
    g.acceptedUnits===null&&g.releaseReady===false));
  assert.equal(first.sha256,createHash('sha256')
    .update(canonicalEvidenceJSON(first.content)).digest('hex'));
  const json=JSON.stringify(first);
  for(const forbidden of ['VERY_PRIVATE_OWNER_NOTE','PRIVATE_REVIEWER_NOTE',
    'proposedUnits','temporaryPassword','token_hash','customerEmail',
    'ownerAccount','password_hash','currentPassword','originalFileBytes']){
    assert.equal(json.includes(forbidden),false,forbidden+' must not be exported');
  }
  assert.throws(()=>f.build(reviewer),e=>e.code==='AUDIT_HANDOFF_OWNER_ONLY');
  f.changeFinding();
  assert.notEqual(f.build().sha256,first.sha256,
    'Reviewer evidence changes must affect the separately saved checksum');
  f.breakIdentity();
  assert.throws(()=>f.build(),e=>e.code==='AUDIT_HANDOFF_ROW_MISMATCH');
  const invalid=fixture();invalid.invalidate();
  assert.throws(()=>invalid.build(),e=>e.code==='INVENTORY_DOSSIER_SOURCE_MISMATCH');
});
test('5.9 standalone verifier requires prior external SHA and rejects modified content',()=>{
  const f=fixture();
  const artifact=f.build();
  const dir=mkdtempSync(join(tmpdir(),'mansu-evidence-export-'));
  const filename=join(dir,'audit.json');
  const tool='scripts/verify-inventory-audit-handoff.mjs';
  try{
    writeFileSync(filename,JSON.stringify(artifact,null,2));
    const verified=spawnSync(process.execPath,[tool,filename,artifact.sha256],
      {encoding:'utf8'});
    assert.equal(verified.status,0,verified.stderr);
    assert.match(verified.stdout,/CHECKSUM MATCH/);
    assert.match(verified.stdout,/NOT A SIGNATURE/);
    const noKnownDigest=spawnSync(process.execPath,[tool,filename],
      {encoding:'utf8'});
    assert.notEqual(noKnownDigest.status,0);
    const changed=structuredClone(artifact);
    changed.content.items[0].sku='COUNTERFEIT-CHANGED';
    changed.sha256=createHash('sha256').update(
      canonicalEvidenceJSON(changed.content)).digest('hex');
    writeFileSync(filename,JSON.stringify(changed,null,2));
    const rejected=spawnSync(process.execPath,[tool,filename,artifact.sha256],
      {encoding:'utf8'});
    assert.notEqual(rejected.status,0);
    assert.match(rejected.stderr,/MISMATCH/);
    const unsafe=structuredClone(artifact);
    unsafe.content.stockImportAuthorized=true;
    unsafe.sha256=createHash('sha256').update(
      canonicalEvidenceJSON(unsafe.content)).digest('hex');
    writeFileSync(filename,JSON.stringify(unsafe,null,2));
    const blocked=spawnSync(process.execPath,[tool,filename,unsafe.sha256],
      {encoding:'utf8'});
    assert.notEqual(blocked.status,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
