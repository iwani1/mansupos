import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SyntheticEvidenceAuditJournal } from '../server/evidence-audit-journal.js';
import {
  SyntheticEvidenceCheckpointWitness, latestSyntheticSignedWitnessReceipt,
} from '../server/evidence-checkpoint-witness.js';
import { SyntheticSeparatedAuditAnchorCustodian } from '../server/evidence-separated-anchor-simulator.js';

const env={
  NODE_ENV:'test',
  MANSU_CI_SYNTHETIC_EVIDENCE_AUDIT:'true',
  MANSU_CI_SYNTHETIC_EVIDENCE_WITNESS:'true',
  MANSU_CI_SYNTHETIC_EXTERNAL_ANCHOR:'true',
};
const siteId='72b1645b-bc7e-4be4-924d-3d3b9dbfbe89';
const at='2026-11-15T16:00:00.000Z';
const eventHmacKey='synthetic-event-key-private-abcdefghijklmnopqrstuvwxyz';
const chainHmacKey='synthetic-chain-key-private-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function directory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(),prefix));
}
function setup(t) {
  const auditDir=directory('mansu-evidence-audit-ci-');
  const witnessDir=directory('mansu-evidence-witness-ci-');
  t.after(()=>{
    fs.rmSync(auditDir,{recursive:true,force:true});
    fs.rmSync(witnessDir,{recursive:true,force:true});
  });
  const signer=generateKeyPairSync('ed25519');
  const anchorKeys=generateKeyPairSync('ed25519');
  const journal=new SyntheticEvidenceAuditJournal({
    env,directory:auditDir,eventHmacKey,chainHmacKey,
  });
  const witness=new SyntheticEvidenceCheckpointWitness({
    env,directory:witnessDir,privateKey:signer.privateKey,
  });
  const custodian=new SyntheticSeparatedAuditAnchorCustodian({
    env,witnessPublicKey:signer.publicKey,
    custodianPrivateKey:anchorKeys.privateKey,siteId,
  });
  function append(time=at) {
    const event=journal.append({
      orderId:480112,siteId,correlationId:randomUUID(),
      outcome:'source_snapshot_consistent_unverified',time,
    });
    witness.append(event.head,{issuedAt:time});
    const record=latestSyntheticSignedWitnessReceipt({
      env,witnessDirectory:witnessDir,publicKey:signer.publicKey,
    });
    return {event,record};
  }
  const journalFile=path.join(auditDir,'synthetic-financial-evidence.ndjson');
  const witnessFile=path.join(witnessDir,'synthetic-signed-checkpoints.ndjson');
  return {journal,witness,custodian,signer,anchorKeys,
    auditDir,witnessDir,journalFile,witnessFile,append};
}
const closed=report=>{
  for (const key of [
    'checkoutAuthorized','refundAuthorized','payoutVerified',
    'stockRestoreAuthorized','recoveryPerformed',
    'independentExternalCustodyVerified',
    'publicKeyTrustRootIndependentlyVerified',
    'productionRollbackProtectionVerified','bankSettlementVerified',
  ]) assert.equal(report[key],false,key);
};

test('synthetic witness publishes to a separately keyed in-memory high-watermark, but never claims real custody',t=>{
  const h=setup(t);
  const {record}=h.append();
  const a=h.custodian.publish({journal:h.journal,witness:record,issuedAt:at});
  assert.equal(a.created,true);
  assert.equal(a.receipt.sequence,1);
  assert.equal(a.receipt.tag,h.journal.verify().head.tag);
  const status=h.custodian.check({journal:h.journal,witness:record,
    pinnedLatestAnchor:a.receipt});
  assert.equal(status.status,'local_protocol_consistent');
  assert.equal(status.lastAnchoredSequence,1);
  assert.deepEqual(status.alertCodes,[]);
  assert.equal(status.needsOwnerSecurityReview,false);
  closed(status);
  const serialized=JSON.stringify(a)+JSON.stringify(status);
  for (const forbidden of [
    '480112',eventHmacKey,chainHmacKey,'customer@example.com','sk_live_123',
  ]) assert.equal(serialized.includes(forbidden),false);
});

test('sequential checkpoints advance monotonically, retry is idempotent and old/forked attempts fail closed',t=>{
  const h=setup(t);
  const first=h.append();
  const initial=h.custodian.publish({journal:h.journal,witness:first.record,issuedAt:at});
  const retry=h.custodian.publish({journal:h.journal,witness:first.record,
    issuedAt:'2026-11-15T16:01:00.000Z'});
  assert.equal(retry.created,false);
  assert.deepEqual(retry.receipt,initial.receipt);
  const second=h.append('2026-11-15T16:02:00.000Z');
  const next=h.custodian.publish({journal:h.journal,witness:second.record,
    issuedAt:'2026-11-15T16:02:00.000Z'});
  assert.equal(next.created,true);
  assert.equal(next.receipt.sequence,2);
  assert.notEqual(next.receipt.previousAnchorDigest,'0'.repeat(64));
  assert.throws(()=>h.custodian.publish({
    journal:h.journal,witness:first.record,issuedAt:'2026-11-15T16:03:00.000Z',
  }),/failed closed/);
  const stale=h.custodian.check({journal:h.journal,witness:second.record,
    pinnedLatestAnchor:initial.receipt});
  assert.equal(stale.status,'blocked_manual_investigation');
  assert.deepEqual(stale.alertCodes,['AUDIT_ANCHOR_OR_JOURNAL_DIVERGENCE']);
  assert.equal(h.custodian.check({journal:h.journal,witness:second.record,
    pinnedLatestAnchor:next.receipt}).status,'local_protocol_consistent');
});

test('rolling back BOTH locally signed files is detected while the independent simulated watermark survives',t=>{
  const h=setup(t);
  const first=h.append();
  h.custodian.publish({journal:h.journal,witness:first.record,issuedAt:at});
  const oldJournal=fs.readFileSync(h.journalFile,'utf8');
  const oldWitness=fs.readFileSync(h.witnessFile,'utf8');
  const second=h.append('2026-11-15T16:01:00.000Z');
  h.custodian.publish({journal:h.journal,witness:second.record,
    issuedAt:'2026-11-15T16:01:00.000Z'});
  fs.writeFileSync(h.journalFile,oldJournal,{mode:0o600});
  fs.writeFileSync(h.witnessFile,oldWitness,{mode:0o600});
  assert.equal(h.journal.verify().recordCount,1);
  const reverted=latestSyntheticSignedWitnessReceipt({
    env,witnessDirectory:h.witnessDir,publicKey:h.signer.publicKey,
  });
  const health=h.custodian.check({journal:h.journal,witness:reverted});
  assert.equal(health.status,'blocked_manual_investigation');
  assert.equal(health.lastAnchoredSequence,2);
  assert.equal(health.severity,'critical');
  closed(health);
  assert.throws(()=>h.custodian.publish({
    journal:h.journal,witness:reverted,issuedAt:'2026-11-15T16:02:00.000Z',
  }),/failed closed/);
});

test('unanchored new journal event, signature tampering and wrong trust key fail closed',t=>{
  const h=setup(t);
  const first=h.append();
  h.custodian.publish({journal:h.journal,witness:first.record,issuedAt:at});
  const second=h.append('2026-11-15T16:02:00.000Z');
  assert.equal(h.custodian.check({
    journal:h.journal,witness:second.record,
  }).status,'blocked_manual_investigation');
  const tampered={...second.record,tag:'f'.repeat(64)};
  assert.equal(h.custodian.check({
    journal:h.journal,witness:tampered,
  }).status,'blocked_manual_investigation');
  assert.throws(()=>h.custodian.publish({
    journal:h.journal,witness:tampered,issuedAt:'2026-11-15T16:03:00.000Z',
  }),/failed closed/);
  const impostorKeys=generateKeyPairSync('ed25519');
  const fake=new SyntheticSeparatedAuditAnchorCustodian({
    env,witnessPublicKey:impostorKeys.publicKey,
    custodianPrivateKey:h.anchorKeys.privateKey,siteId,
  });
  assert.equal(fake.check({journal:h.journal,witness:second.record}).status,
    'blocked_manual_investigation');
});

test('witness unavailable gives critical alert, blocks publication and never repairs or changes financial state',t=>{
  const h=setup(t);
  const first=h.append();
  h.custodian.publish({journal:h.journal,witness:first.record,issuedAt:at});
  h.custodian.setSimulatedAvailability(false);
  const state=h.custodian.check({journal:h.journal,witness:first.record});
  assert.equal(state.status,'blocked_manual_investigation');
  assert.deepEqual(state.alertCodes,['WITNESS_UNAVAILABLE']);
  assert.equal(state.needsOwnerSecurityReview,true);
  assert.equal(state.severity,'critical');
  closed(state);
  assert.throws(()=>h.custodian.publish({
    journal:h.journal,witness:first.record,issuedAt:at,
  }),/failed closed/);
  const proposal=h.custodian.assessRecoveryCandidate({
    candidateJournal:h.journal,witness:first.record,
  });
  assert.equal(proposal.candidateMatchesLocalSimulatedAnchor,false);
  assert.equal(proposal.candidateApprovedForProductionRestore,false);
  assert.equal(proposal.recoveryPerformed,false);
  assert.equal(proposal.journalWritten,false);
  h.custodian.setSimulatedAvailability(true);
  assert.equal(h.custodian.check({journal:h.journal,witness:first.record}).status,
    'local_protocol_consistent');
});

test('recovery candidate assessment is read-only and only matches full signed high-watermark',t=>{
  const h=setup(t);
  const first=h.append();
  h.custodian.publish({journal:h.journal,witness:first.record,issuedAt:at});
  const original=fs.readFileSync(h.journalFile,'utf8');
  const size=fs.statSync(h.journalFile).size;
  const candidate=h.custodian.assessRecoveryCandidate({
    candidateJournal:h.journal,witness:first.record,
  });
  assert.equal(candidate.kind,'synthetic-audit-recovery-candidate-assessment');
  assert.equal(candidate.candidateMatchesLocalSimulatedAnchor,true);
  assert.equal(candidate.candidateApprovedForProductionRestore,false);
  assert.equal(candidate.manualOwnerSecuritySignoffRequired,true);
  assert.equal(candidate.journalWritten,false);
  assert.equal(candidate.recoveryPerformed,false);
  assert.equal(fs.readFileSync(h.journalFile,'utf8'),original);
  assert.equal(fs.statSync(h.journalFile).size,size);
  const second=h.append('2026-11-15T16:02:00.000Z');
  const stale=h.custodian.assessRecoveryCandidate({
    candidateJournal:h.journal,witness:second.record,
  });
  assert.equal(stale.candidateMatchesLocalSimulatedAnchor,false);
  closed(stale);
});

test('strict CI gate and signer separation; no same-key custodian or production service',t=>{
  const h=setup(t);
  for(const changes of [
    {env:{NODE_ENV:'production',MANSU_CI_SYNTHETIC_EXTERNAL_ANCHOR:'true'}},
    {env:{NODE_ENV:'test',MANSU_CI_SYNTHETIC_EXTERNAL_ANCHOR:'false'}},
    {witnessPublicKey:h.signer.privateKey},
    {custodianPrivateKey:h.anchorKeys.publicKey},
    {custodianPrivateKey:h.signer.privateKey},
    {siteId:'not-an-uuid'},
  ]) assert.throws(()=>new SyntheticSeparatedAuditAnchorCustodian({
    env,witnessPublicKey:h.signer.publicKey,
    custodianPrivateKey:h.anchorKeys.privateKey,siteId,...changes,
  }),/failed closed/);
  assert.throws(()=>h.custodian.setSimulatedAvailability('yes'),/failed closed/);
  assert.throws(()=>h.custodian.publish({
    journal:h.journal,witness:{kind:'customer',reference:'PRIVATE'},
    issuedAt:at,
  }),/failed closed/);
});

test('same-host authority reset can re-anchor a rolled-back prefix: never claim durable independent custody',t=>{
  const h=setup(t);
  const first=h.append();
  h.custodian.publish({journal:h.journal,witness:first.record,issuedAt:at});
  const oldJournal=fs.readFileSync(h.journalFile,'utf8');
  const oldWitness=fs.readFileSync(h.witnessFile,'utf8');
  const second=h.append('2026-11-15T16:01:00.000Z');
  h.custodian.publish({journal:h.journal,witness:second.record,
    issuedAt:'2026-11-15T16:01:00.000Z'});
  fs.writeFileSync(h.journalFile,oldJournal,{mode:0o600});
  fs.writeFileSync(h.witnessFile,oldWitness,{mode:0o600});
  // A completely replaced in-memory authority has LOST its watermark:
  // the old prefix can be re-anchored. This is why durable external storage,
  // independently pinned trust roots and owner-approved recovery are mandatory.
  const reset=new SyntheticSeparatedAuditAnchorCustodian({
    env,witnessPublicKey:h.signer.publicKey,
    custodianPrivateKey:h.anchorKeys.privateKey,siteId,
  });
  const replay=reset.publish({
    journal:h.journal,witness:first.record,issuedAt:at,
  });
  assert.equal(replay.created,true);
  assert.equal(reset.check({journal:h.journal,witness:first.record}).status,
    'local_protocol_consistent');
  assert.equal(reset.check({journal:h.journal,witness:first.record})
    .independentExternalCustodyVerified,false);
});
