import test from 'node:test';
import assert from 'node:assert/strict';
import {readConfig} from '../server/config.js';
import {FullLaunchReadiness} from '../server/full-launch-readiness.js';

const SHA='a'.repeat(64),OTHER='b'.repeat(64);
function auditFixture(){
  return {
    kind:'owner-inventory-audit-handoff',
    auditOnly:true,releaseReady:false,
    stockImportAuthorized:false,checkoutAuthorized:false,
    sha256:SHA,
    content:{
      format:'mansupos-inventory-audit-handoff-v1',
      stockImportAuthorized:false,checkoutAuthorized:false,
      sourceHash:OTHER,
      summary:{historicalRows:4,disputedRows:2,acceptedRows:0},
      globalRequirements:[{id:'independent_witness',verified:false}],
      items:[{reportRow:1}],
    },
  };
}
const owner={id:'owner',role:'owner'};
const reqs=()=>new FullLaunchReadiness({build:()=>auditFixture()});

test('four-track Owner release report never claims external verification or trading readiness',()=>{
  const report=reqs().build(owner,{},null,Date.parse('2026-11-16T12:00:00Z'));
  assert.equal(report.kind,'owner-four-track-launch-readiness');
  assert.equal(report.auditOnly,true);
  assert.equal(report.releaseBlocked,true);
  assert.equal(report.content.stages.length,4);
  assert.equal(report.content.requirements.length,8);
  assert.ok(report.content.requirements.every(x=>
    x.verified===false&&x.acceptanceBlocked===true));
  assert.ok(report.content.stages.every(x=>
    x.externallyVerified===false&&x.productionEnabled===false));
  assert.equal(report.content.stages[1].syntheticCheck,'synthetic_pass');
  assert.equal(report.content.stages[2].syntheticCheck,'synthetic_pass');
  assert.equal(report.content.evidence.syntheticStockChecksPassed,7);
  assert.equal(report.content.evidence.syntheticPaymentChecksPassed,7);
  assert.equal(report.content.evidence.syntheticWooOrderWrites,0);
  assert.equal(report.content.evidence.syntheticGatewayCalls,0);
  for(const field of [
    'productionReady','independentPhysicalProofVerified',
    'reviewerIdentityAndIndependenceVerified','originalPhysicalCountVerified',
    'variationMappingApproved','installedWooReservationsVerified',
    'realPaystackCallbacksVerified','realRefundSettlementVerified',
    'offHostBackupRestoreVerified','disasterRecoveryDrillVerified',
    'staffTrainingSignedOff','securityReviewSignedOff','ciFinalCommitVerified',
    'authorizedLiveDeployment','stockImportAuthorized',
    'checkoutAuthorized','paymentsAuthorized',
  ]){
    assert.equal(report[field],false,field);
    assert.equal(report.content[field],false,field+' in signed report content');
  }
  assert.match(report.evidenceRef,/^[a-f0-9]{64}$/);
  assert.equal(reqs().build(owner,{},null).evidenceRef,report.evidenceRef);
  assert.throws(()=>reqs().build({role:'reviewer'},null,null),e=>
    e.code==='FULL_LAUNCH_OWNER_ONLY');
  assert.throws(()=>reqs().build({role:'manager'},null,null),e=>
    e.code==='FULL_LAUNCH_OWNER_ONLY');
});
test('four-track report fails closed on malformed or approval-looking external audit',()=>{
  for(const field of [
    'releaseReady','stockImportAuthorized','checkoutAuthorized',
  ]){
    const x=auditFixture();
    x[field]=true;
    const s=new FullLaunchReadiness({build:()=>x});
    assert.throws(()=>s.build(owner,{},{}),e=>e.code==='FULL_LAUNCH_AUDIT_INCOMPLETE');
  }
  for(const mutation of [
    x=>{x.sha256='not-hex';},
    x=>{x.content.summary.acceptedRows=1;},
    x=>{x.content.stockImportAuthorized=true;},
    x=>{x.content.items=null;},
    x=>{x.content.globalRequirements=null;},
  ]){
    const x=auditFixture();mutation(x);
    assert.throws(()=>new FullLaunchReadiness({build:()=>x}).build(owner,{},{}),
      e=>e.code==='FULL_LAUNCH_AUDIT_INCOMPLETE');
  }
});
test('production read-only pilot must reject checkout and legacy local-stock activation',()=>{
  const env={
    NODE_ENV:'production',POS_MODE:'live',POS_LIVE_READ_ONLY:'true',
    POS_ALLOW_LIVE_WRITES:'false',POS_ONLINE_BRIDGE_LIVE_ENABLED:'false',
    POS_PUBLIC_ORIGIN:'https://pos.mansutrendzgh.com',
    WOO_BASE_URL:'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY:'ck_synthetic_read_only',
    WOO_CONSUMER_SECRET:'cs_synthetic_read_only',
  };
  const safe=readConfig(env);
  assert.equal(safe.liveReadOnly,true);
  assert.equal(safe.writesEnabled,false);
  assert.equal(safe.wholesaleWritesEnabled,false);
  assert.equal(safe.onlineBridgeLiveEnabled,false);
  assert.equal(safe.inStoreCashEnabled,false);
  assert.equal(safe.desktopEnabled,false);
  assert.throws(()=>readConfig({...env,POS_ALLOW_LIVE_WRITES:'true'}),
    /read-only live pilot cannot enable/i);
  assert.throws(()=>readConfig({...env,POS_ONLINE_BRIDGE_LIVE_ENABLED:'true'}),
    /live Woo bridge requires/i);
  assert.throws(()=>readConfig({...env,POS_INSTORE_CASH_APPROVED:'true'}),
    /In-store cash requires/i);
  assert.throws(()=>readConfig({...env,POS_DESKTOP_RESERVATION_APPROVED:'true'}),
    /Offline selling requires/i);
});
