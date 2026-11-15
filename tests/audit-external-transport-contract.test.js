import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SyntheticEvidenceAuditJournal } from '../server/evidence-audit-journal.js';
import { SyntheticEvidenceCheckpointWitness } from '../server/evidence-checkpoint-witness.js';
import { SyntheticSeparatedAuditAnchorCustodian } from '../server/evidence-separated-anchor-simulator.js';
import {
  SyntheticAuditTransportFixture,SyntheticAuditExternalProtocol,
} from '../server/audit-external-transport-contract.js';

const env={
  NODE_ENV:'test',
  MANSU_CI_SYNTHETIC_EVIDENCE_AUDIT:'true',
  MANSU_CI_SYNTHETIC_EVIDENCE_WITNESS:'true',
  MANSU_CI_SYNTHETIC_EXTERNAL_ANCHOR:'true',
  MANSU_CI_SYNTHETIC_EXTERNAL_AUDIT_TRANSPORT:'true',
};
const siteId='72b1645b-bc7e-4be4-924d-3d3b9dbfbe89';
const baseTime='2026-11-15T16:30:00.000Z';
const temp=p=>fs.mkdtempSync(path.join(os.tmpdir(),p));
function setup(t) {
  const journalDir=temp('mansu-evidence-audit-ci-');
  const witnessDir=temp('mansu-evidence-witness-ci-');
  t.after(()=>{
    fs.rmSync(journalDir,{recursive:true,force:true});
    fs.rmSync(witnessDir,{recursive:true,force:true});
  });
  const witnessKeys=generateKeyPairSync('ed25519');
  const custodianKeys=generateKeyPairSync('ed25519');
  const journal=new SyntheticEvidenceAuditJournal({
    env,directory:journalDir,
    eventHmacKey:'synthetic-event-hmac-secret-abcdefghijklmnopqrstuvwxyz',
    chainHmacKey:'synthetic-chain-hmac-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  });
  const witness=new SyntheticEvidenceCheckpointWitness({
    env,directory:witnessDir,privateKey:witnessKeys.privateKey,
  });
  const custodian=new SyntheticSeparatedAuditAnchorCustodian({
    env,witnessPublicKey:witnessKeys.publicKey,
    custodianPrivateKey:custodianKeys.privateKey,siteId,
  });
  const transport=new SyntheticAuditTransportFixture({
    env,custodian,siteId,
  });
  const client=new SyntheticAuditExternalProtocol({
    env,transport,siteId,
    witnessPublicKey:witnessKeys.publicKey,
    custodianPublicKey:custodianKeys.publicKey,
    witnessDirectory:witnessDir,
  });
  const append=(time=baseTime)=>{
    const event=journal.append({
      orderId:540008,siteId,correlationId:randomUUID(),
      outcome:'review_started',time,
    });
    witness.append(event.head,{issuedAt:time});
    return event;
  };
  return {journal,witness,transport,client,append,siteId,
    custodian,witnessKeys,custodianKeys,journalDir,witnessDir,
    journalFile:path.join(journalDir,'synthetic-financial-evidence.ndjson'),
  };
}
function closed(report) {
  for (const key of [
    'independentExternalCustodyVerified','durableOffHostRetentionVerified',
    'independentAlertDeliveryVerified','merchantBankSettlementVerified',
    'customerRefundExecuted','refundAuthorized','payoutVerified',
    'stockRestored','checkoutAuthorized','recoveryPerformed','financialWritesEnabled',
  ]) assert.equal(report[key],false,key);
}
test('provider-neutral synthetic checkpoint submission validates signing, local journal and remote acknowledgement',async t=>{
  const h=setup(t);
  h.append();
  const operationId=randomUUID();
  const result=await h.client.submit({
    operationId,journal:h.journal,issuedAt:baseTime,
  });
  assert.equal(result.kind,'synthetic-external-audit-protocol');
  assert.equal(result.status,'fixture_receipt_consistent');
  assert.equal(result.syntheticReceiptAcknowledged,true);
  assert.equal(result.anchoredSequence,1);
  assert.equal(result.needsOwnerSecurityReview,false);
  closed(result);
  assert.deepEqual(h.transport.fixtureCounts(),{checkpoints:1,incidents:0});
  const status=await h.client.inspect({operationId,journal:h.journal});
  assert.equal(status.kind,'synthetic-external-audit-health');
  assert.equal(status.status,'fixture_receipt_consistent');
  closed(status);
  const raw=JSON.stringify(result)+JSON.stringify(status);
  for (const forbidden of [
    '540008',siteId,'synthetic-event-hmac-secret','synthetic-chain-hmac-secret',
    'customer@email.example','sk_live_abcdef',
  ]) assert.equal(raw.includes(forbidden),false,'No private payment/customer data in response');
});
test('lost acknowledgement after successful remote mock commit is resolved by original operation lookup, never duplicated',async t=>{
  const h=setup(t);
  h.append();
  const operationId=randomUUID();
  h.transport.failNext('after_publish');
  const first=await h.client.submit({operationId,journal:h.journal,issuedAt:baseTime});
  assert.equal(first.status,'fixture_receipt_consistent');
  assert.equal(h.transport.fixtureCounts().checkpoints,1);
  assert.equal(h.transport.fixtureCounts().incidents,0);
  const retry=await h.client.submit({operationId,journal:h.journal,issuedAt:baseTime});
  assert.equal(retry.status,'fixture_receipt_consistent');
  assert.equal(retry.anchoredSequence,1);
  assert.equal(h.transport.fixtureCounts().checkpoints,1);
  closed(retry);
});
test('lost response before commit has an UNKNOWN outcome, no automatic retry and critical incident record',async t=>{
  const h=setup(t);
  h.append();
  const operationId=randomUUID();
  h.transport.failNext('before_publish');
  const pending=await h.client.submit({operationId,journal:h.journal,issuedAt:baseTime});
  assert.equal(pending.status,'blocked_manual_investigation');
  assert.equal(pending.issueCode,'ACKNOWLEDGEMENT_UNKNOWN');
  assert.equal(pending.severity,'critical');
  assert.equal(pending.needsOwnerSecurityReview,true);
  assert.equal(pending.incidentRecording,'synthetic_fixture_recorded');
  assert.deepEqual(h.transport.fixtureCounts(),{checkpoints:0,incidents:1});
  closed(pending);
  // A second explicit, reviewed request can reuse its ID; the implementation
  // itself NEVER auto-retries an uncertain financial audit submission.
});
test('unavailable external fixture fails closed and alert delivery remains unconfirmed',async t=>{
  const h=setup(t);
  h.append();
  const operationId=randomUUID();
  h.transport.setAvailable(false);
  const blocked=await h.client.submit({operationId,journal:h.journal,issuedAt:baseTime});
  assert.equal(blocked.issueCode,'EXTERNAL_WITNESS_UNAVAILABLE');
  assert.equal(blocked.status,'blocked_manual_investigation');
  assert.equal(blocked.incidentRecording,'unconfirmed');
  assert.equal(blocked.needsOwnerSecurityReview,true);
  closed(blocked);
  const status=await h.client.inspect({operationId,journal:h.journal});
  assert.equal(status.issueCode,'EXTERNAL_WITNESS_UNAVAILABLE');
  closed(status);
  assert.deepEqual(h.transport.fixtureCounts(),{checkpoints:0,incidents:0});
});
test('lost incident acknowledgement is investigated by same incident ID without duplicating its mock record',async t=>{
  const h=setup(t);
  h.append();
  const operationId=randomUUID();
  h.transport.failNext('after_incident');
  // No remote anchor has been submitted, so the read-only health inquiry
  // must produce an integrity incident.
  const problem=await h.client.inspect({operationId,journal:h.journal});
  assert.equal(problem.status,'blocked_manual_investigation');
  assert.equal(problem.issueCode,'EXTERNAL_ANCHOR_MISMATCH');
  assert.equal(problem.incidentRecording,'synthetic_fixture_recorded');
  assert.deepEqual(h.transport.fixtureCounts(),{checkpoints:0,incidents:1});
  const repeated=await h.client.inspect({operationId,journal:h.journal});
  assert.equal(repeated.incidentId,problem.incidentId);
  assert.equal(h.transport.fixtureCounts().incidents,1);
  closed(repeated);
});
test('same operation ID cannot be re-bound to a different signed journal head',async t=>{
  const h=setup(t);
  h.append();
  const operationId=randomUUID();
  const first=await h.client.submit({operationId,journal:h.journal,issuedAt:baseTime});
  assert.equal(first.status,'fixture_receipt_consistent');
  h.append('2026-11-15T16:31:00.000Z');
  const conflicting=await h.client.submit({operationId,journal:h.journal,
    issuedAt:'2026-11-15T16:31:00.000Z'});
  assert.equal(conflicting.issueCode,'EXTERNAL_ANCHOR_MISMATCH');
  assert.equal(conflicting.status,'blocked_manual_investigation');
  assert.equal(h.transport.fixtureCounts().checkpoints,1);
  assert.equal(h.transport.fixtureCounts().incidents,1);
  closed(conflicting);
});
test('new checkpoint is not healthy until signed and published; read-only inspection detects rollback',async t=>{
  const h=setup(t);
  const first=h.append();
  const original=fs.readFileSync(h.journalFile,'utf8');
  const a=await h.client.submit({operationId:randomUUID(),journal:h.journal,issuedAt:baseTime});
  assert.equal(a.status,'fixture_receipt_consistent');
  // New unanchored journal receipt must not pass the old external head.
  h.append('2026-11-15T16:31:00.000Z');
  const operationId=randomUUID();
  const stale=await h.client.inspect({operationId,journal:h.journal});
  assert.equal(stale.status,'blocked_manual_investigation');
  assert.equal(stale.issueCode,'EXTERNAL_ANCHOR_MISMATCH');
  const second=await h.client.submit({
    operationId:randomUUID(),journal:h.journal,
    issuedAt:'2026-11-15T16:31:00.000Z',
  });
  assert.equal(second.status,'fixture_receipt_consistent');
  assert.equal(second.anchoredSequence,2);
  // Rollback after the external high watermark was advanced is refused.
  fs.writeFileSync(h.journalFile,original,{mode:0o600});
  const rolled=await h.client.inspect({operationId:randomUUID(),journal:h.journal});
  assert.equal(rolled.status,'blocked_manual_investigation');
  assert.equal(rolled.issueCode,'LOCAL_EVIDENCE_INVALID');
  assert.equal(h.transport.fixtureCounts().checkpoints,2);
  assert.equal(first.head.sequence,1);
});
test('recovery candidate is assessed without restoring, paying, refunding, or restocking',async t=>{
  const h=setup(t);
  h.append();
  const original=fs.readFileSync(h.journalFile,'utf8');
  const accepted=await h.client.submit({
    operationId:randomUUID(),journal:h.journal,issuedAt:baseTime,
  });
  assert.equal(accepted.status,'fixture_receipt_consistent');
  const check=await h.client.assessRecovery({
    operationId:randomUUID(),candidateJournal:h.journal,
  });
  assert.equal(check.kind,'synthetic-external-audit-recovery');
  assert.equal(check.candidateMatchesSyntheticAnchor,true);
  assert.equal(check.ownerAndIndependentReviewerApprovalRequired,true);
  assert.equal(check.productionRestoreApproved,false);
  assert.equal(check.recoveryPerformed,false);
  assert.equal(check.journalWritten,false);
  assert.equal(fs.readFileSync(h.journalFile,'utf8'),original);
  closed(check);
  const other=h.append('2026-11-15T16:33:00.000Z');
  const rejected=await h.client.assessRecovery({
    operationId:randomUUID(),candidateJournal:h.journal,
  });
  assert.equal(other.head.sequence,2);
  assert.equal(rejected.candidateMatchesSyntheticAnchor,false);
  assert.equal(rejected.productionRestoreApproved,false);
  closed(rejected);
});
test('strict synthetic gate, fake-only transport, trust keys and operation IDs deny real integration',async t=>{
  const h=setup(t);
  const opts={
    env,transport:h.transport,siteId,witnessPublicKey:h.witnessKeys.publicKey,
    custodianPublicKey:h.custodianKeys.publicKey,witnessDirectory:h.witnessDir,
  };
  for (const change of [
    {env:{NODE_ENV:'production',MANSU_CI_SYNTHETIC_EXTERNAL_AUDIT_TRANSPORT:'true'}},
    {transport:{publishCheckpoint:async()=>({})}},
    {witnessPublicKey:h.custodianKeys.privateKey},
    {custodianPublicKey:h.custodianKeys.privateKey},
    {siteId:'https://attacker.example'},
  ]) assert.throws(()=>new SyntheticAuditExternalProtocol({...opts,...change}),/refused/);
  h.append();
  await assert.rejects(h.client.submit({operationId:'raw-payment-ref',
    journal:h.journal,issuedAt:baseTime}),/refused/);
  assert.equal(h.transport.fixtureCounts().checkpoints,0);
  assert.throws(()=>h.transport.failNext('arbitrary_write'),/refused/);
});
test('replacing same-host memory custodian/fixture loses its watermark; independent durable custody remains NOT verified',async t=>{
  const h=setup(t);
  h.append();
  const id=randomUUID();
  assert.equal((await h.client.submit({
    operationId:id,journal:h.journal,issuedAt:baseTime,
  })).status,'fixture_receipt_consistent');
  const replacement=new SyntheticAuditTransportFixture({
    env,custodian:new SyntheticSeparatedAuditAnchorCustodian({
      env,witnessPublicKey:h.witnessKeys.publicKey,
      custodianPrivateKey:h.custodianKeys.privateKey,siteId,
    }),siteId,
  });
  const restarted=new SyntheticAuditExternalProtocol({
    env,transport:replacement,siteId,
    witnessPublicKey:h.witnessKeys.publicKey,
    custodianPublicKey:h.custodianKeys.publicKey,
    witnessDirectory:h.witnessDir,
  });
  const absence=await restarted.inspect({operationId:randomUUID(),journal:h.journal});
  assert.equal(absence.status,'blocked_manual_investigation');
  assert.equal(absence.issueCode,'EXTERNAL_ANCHOR_MISMATCH');
  assert.equal(absence.independentExternalCustodyVerified,false);
  closed(absence);
});
