import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  AUDIT_PROVIDER_CONTROLS, AUDIT_PROVIDER_DRILLS,
  signSyntheticAuditProviderReview,evaluateSyntheticAuditProviderReadiness,
} from '../server/audit-provider-acceptance.js';

const env={ NODE_ENV:'test',MANSU_CI_SYNTHETIC_AUDIT_PROVIDER_ACCEPTANCE:'true' };
const siteId='72b1645b-bc7e-4be4-924d-3d3b9dbfbe89';
const issuedAt='2026-11-15T15:30:00.000Z';
const now='2026-11-15T15:31:00.000Z';
const auditOwner=generateKeyPairSync('ed25519');
const independentSecurity=generateKeyPairSync('ed25519');
const proofRow=code=>({code,status:'passed_in_fixture',evidenceId:randomUUID()});
function fixture() {
  const manifest={
    kind:'synthetic-audit-provider-acceptance-matrix',
    version:1,environment:'synthetic_fixture',
    siteId,reviewId:randomUUID(),reviewedAt:issuedAt,
    controls:AUDIT_PROVIDER_CONTROLS.map(proofRow),
    drills:AUDIT_PROVIDER_DRILLS.map(proofRow),
  };
  const ownerEndorsement=signSyntheticAuditProviderReview({
    env,manifest,role:'owner',privateKey:auditOwner.privateKey,
  });
  const securityEndorsement=signSyntheticAuditProviderReview({
    env,manifest,role:'independent_security',
    privateKey:independentSecurity.privateKey,
  });
  const args={env,manifest,ownerEndorsement,securityEndorsement,
    pinnedOwnerPublicKey:auditOwner.publicKey,
    pinnedSecurityPublicKey:independentSecurity.publicKey,
    expectedSiteId:siteId,now};
  return args;
}
const assess=args=>evaluateSyntheticAuditProviderReadiness(args);
function closed(result) {
  for (const key of [
    'ownerIdentityIndependentlyVerified','securityReviewerIndependentlyVerified',
    'immutableRemoteCustodyVerified','externalHighWatermarkDurabilityVerified',
    'authenticatedIncidentDeliveryVerified','liveRestoreDrillVerified',
    'realProviderConnected','productionAuditReady',
    'liveMerchantCredentialsApproved','paymentSettlementVerified',
    'refundAuthorized','stockAdjustmentAuthorized','checkoutAuthorized',
    'deploymentAuthorized','mutationsAllowed',
  ]) assert.equal(result[key],false,key+' must remain false');
}

test('two distinct synthetic Ed25519 reviewers can sign a complete matrix, but live use remains prohibited',()=>{
  const x=fixture();
  const result=assess(x);
  assert.equal(result.kind,'synthetic-audit-provider-acceptance-assessment');
  assert.equal(result.fixtureEndorsementsCryptographicallyValid,true);
  assert.equal(result.syntheticMatrixComplete,true);
  assert.equal(result.reviewStatus,'synthetic_requirements_satisfied_only');
  assert.equal(result.reviewWithinSyntheticWindow,true);
  assert.equal(result.controlsInspected,AUDIT_PROVIDER_CONTROLS.length);
  assert.equal(result.drillsInspected,AUDIT_PROVIDER_DRILLS.length);
  assert.deepEqual(result.unpassedControls,[]);
  assert.deepEqual(result.unpassedDrills,[]);
  assert.match(result.reviewDigest,/^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(result),true);
  closed(result);
  const printed=JSON.stringify(result);
  assert.equal(printed.includes(siteId),false);
  for(const id of x.manifest.controls.map(row=>row.evidenceId)) {
    assert.equal(printed.includes(id),false,'No internal proof identifiers in report');
  }
});

test('missing custody, alert delivery, and restore drills produce explicit blocked controls',()=>{
  const x=fixture();
  const manifest=structuredClone(x.manifest);
  manifest.controls.find(r=>r.code==='immutable_retention_and_legal_hold').status='not_tested';
  manifest.controls.find(r=>r.code==='immutable_retention_and_legal_hold').evidenceId=null;
  manifest.controls.find(r=>r.code==='independently_confirmed_owner_alert').status='failed';
  manifest.drills.find(r=>r.code==='disaster_restore_owner_plus_security').status='not_tested';
  manifest.drills.find(r=>r.code==='disaster_restore_owner_plus_security').evidenceId=null;
  x.manifest=manifest;
  x.ownerEndorsement=signSyntheticAuditProviderReview({
    env,manifest,role:'owner',privateKey:auditOwner.privateKey,
  });
  x.securityEndorsement=signSyntheticAuditProviderReview({
    env,manifest,role:'independent_security',
    privateKey:independentSecurity.privateKey,
  });
  const report=assess(x);
  assert.equal(report.syntheticMatrixComplete,false);
  assert.deepEqual(report.unpassedControls,[
    'immutable_retention_and_legal_hold','independently_confirmed_owner_alert',
  ]);
  assert.deepEqual(report.unpassedDrills,['disaster_restore_owner_plus_security']);
  assert.equal(report.reviewStatus,'blocked_missing_or_stale_fixture_evidence');
  closed(report);
});

test('expired or future-dated CI proof cannot pass and cannot grant merchant authorization',()=>{
  for(const epoch of ['2026-11-30T15:31:00.000Z','2026-11-14T15:31:00.000Z']) {
    const x=fixture();
    x.now=epoch;
    const status=assess(x);
    assert.equal(status.reviewWithinSyntheticWindow,false);
    assert.equal(status.syntheticMatrixComplete,false);
    closed(status);
  }
});

test('changed control after signature, forged owner signature, and missing second reviewer fail closed',()=>{
  const x=fixture();
  const tampered=structuredClone(x.manifest);
  tampered.controls[0].evidenceId=randomUUID();
  assert.throws(()=>assess({...x,manifest:tampered}),/rejected/);
  const forged={...x.ownerEndorsement,signature:x.securityEndorsement.signature};
  assert.throws(()=>assess({...x,ownerEndorsement:forged}),/rejected/);
  assert.throws(()=>assess({...x,securityEndorsement:undefined}),/rejected/);
  assert.throws(()=>assess({...x,ownerEndorsement:x.securityEndorsement}),/rejected/);
  assert.throws(()=>assess({...x,pinnedSecurityPublicKey:auditOwner.publicKey}),/rejected/);
  const wrong=generateKeyPairSync('ed25519');
  assert.throws(()=>assess({...x,pinnedOwnerPublicKey:wrong.publicKey}),/rejected/);
  assert.throws(()=>assess({...x,pinnedSecurityPublicKey:wrong.publicKey}),/rejected/);
});

test('cross-site and cross-review endorsement replay cannot authenticate a different assessment',()=>{
  const x=fixture();
  assert.throws(()=>assess({...x,expectedSiteId:randomUUID()}),/rejected/);
  const different=structuredClone(x.manifest);
  different.reviewId=randomUUID();
  assert.throws(()=>assess({...x,manifest:different}),/rejected/);
  const other=fixture();
  assert.throws(()=>assess({...x,ownerEndorsement:other.ownerEndorsement}),/rejected/);
});

test('strict schema rejects missing, duplicate, injected and fake-live evidence',()=>{
  const changes=[
    m=>m.controls.pop(),
    m=>m.drills.push({...m.drills[0]}),
    m=>{m.controls[0].code='arbitrary_finance_release';},
    m=>{m.controls[0].evidenceId='private-payment-reference';},
    m=>{m.controls[0].status='passed_live';},
    m=>{m.controls[0].note='customer@example.invalid';},
    m=>{m.drills[0].evidenceId=null;},
    m=>{m.environment='production';},
    m=>{m.customerName='private';},
    m=>{m.reviewedAt='tomorrow';},
  ];
  for(const change of changes) {
    const x=fixture();
    const m=structuredClone(x.manifest);
    change(m);
    assert.throws(()=>signSyntheticAuditProviderReview({
      env,manifest:m,role:'owner',privateKey:auditOwner.privateKey,
    }),/rejected/);
  }
  assert.throws(()=>assess({...fixture(),now:'2026-11-15T15:31:00Z'}),/rejected/);
});

test('signer and evaluator reject production runtimes, roles, private-key misuse and unsigned reports',()=>{
  const x=fixture();
  const prod={NODE_ENV:'production',MANSU_CI_SYNTHETIC_AUDIT_PROVIDER_ACCEPTANCE:'true'};
  assert.throws(()=>assess({...x,env:prod}),/rejected/);
  assert.throws(()=>assess({...x,env:{NODE_ENV:'test'}}),/rejected/);
  assert.throws(()=>signSyntheticAuditProviderReview({
    env:prod,manifest:x.manifest,role:'owner',privateKey:auditOwner.privateKey,
  }),/rejected/);
  assert.throws(()=>signSyntheticAuditProviderReview({
    env,manifest:x.manifest,role:'manager',privateKey:auditOwner.privateKey,
  }),/rejected/);
  assert.throws(()=>signSyntheticAuditProviderReview({
    env,manifest:x.manifest,role:'owner',privateKey:auditOwner.publicKey,
  }),/rejected/);
  assert.throws(()=>assess({...x,pinnedOwnerPublicKey:auditOwner.privateKey}),/rejected/);
});

test('pure readiness code never contacts the website or imports cashier POS or payment adapter',()=>{
  const source=fs.readFileSync(fileURLToPath(new URL('../server/audit-provider-acceptance.js',import.meta.url)),'utf8');
  for(const unsafe of ['fetch(', 'http.request(', 'https.request(', 'createApp(', 'paystackSecret', 'wooConsumerKey', 'process.env', 'writeFileSync(', 'app.post(']) {
    assert.equal(source.includes(unsafe),false,'Unexpected networking, credentials or POS integration: '+unsafe);
  }
  const r=assess(fixture());
  assert.equal(r.realProviderConnected,false);
  closed(r);
});
