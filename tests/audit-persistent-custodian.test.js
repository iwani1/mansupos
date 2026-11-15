import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID,generateKeyPairSync } from 'node:crypto';
import { SyntheticEvidenceAuditJournal } from '../server/evidence-audit-journal.js';
import { SyntheticEvidenceCheckpointWitness,latestSyntheticSignedWitnessReceipt } from '../server/evidence-checkpoint-witness.js';
import { SyntheticPersistentAuditCustodian } from '../server/audit-persistent-custodian.js';

const env={
  NODE_ENV:'test',MANSU_CI_SYNTHETIC_EVIDENCE_AUDIT:'true',
  MANSU_CI_SYNTHETIC_EVIDENCE_WITNESS:'true',
  MANSU_CI_SYNTHETIC_PERSISTENT_CUSTODY:'true',
};
const SITE='72b1645b-bc7e-4be4-924d-3d3b9dbfbe89';
const WHEN='2026-11-15T16:55:00.000Z';
function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-evidence-audit-ci-'));
  const wdir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-evidence-witness-ci-'));
  const cdir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-persistent-custody-ci-'));
  t.after(()=>{
    for(const d of [root,wdir,cdir])fs.rmSync(d,{recursive:true,force:true});
  });
  const signer=generateKeyPairSync('ed25519');
  const custodianSigner=generateKeyPairSync('ed25519');
  const journal=new SyntheticEvidenceAuditJournal({
    env,directory:root,
    eventHmacKey:'ci-original-evidence-private-hmac-key-123456789',
    chainHmacKey:'ci-original-audit-chain-private-key-987654321',
  });
  const witness=new SyntheticEvidenceCheckpointWitness({
    env,directory:wdir,privateKey:signer.privateKey,
  });
  const config={env,directory:cdir,siteId:SITE,
    witnessPublicKey:signer.publicKey,
    custodianPrivateKey:custodianSigner.privateKey};
  const provider=new SyntheticPersistentAuditCustodian(config);
  const journalFile=path.join(root,'synthetic-financial-evidence.ndjson');
  const custodyFile=path.join(cdir,'synthetic-persistent-anchors.ndjson');
  function append(eventTime=WHEN){
    const entry=journal.append({siteId:SITE,orderId:92495,
      outcome:'review_started',correlationId:randomUUID(),time:eventTime});
    witness.append(entry.head,{issuedAt:eventTime});
    const signed=latestSyntheticSignedWitnessReceipt({
      env,witnessDirectory:wdir,publicKey:signer.publicKey,
    });
    return {entry,signed};
  }
  return {journal,witness,provider,config,signer,custodianSigner,
    cdir,root,wdir,journalFile,custodyFile,append};
}
function neverFinance(result){
  for(const k of ['independentRemoteCustodyVerified',
    'immutableProviderRetentionVerified','ownerNotificationDelivered',
    'bankSettlementVerified','checkoutAuthorized','refundAuthorized',
    'payoutExecuted','stockRestored','automatedRecoveryAllowed']) {
    assert.equal(result[k],false,k);
  }
}
test('restart-safe signed custody journal retains original head and UUID idempotency without remote claims',t=>{
  const h=setup(t);
  const item=h.append();
  const operationId=randomUUID();
  const first=h.provider.append({operationId,witness:item.signed,journal:h.journal,issuedAt:WHEN});
  assert.equal(first.created,true);
  assert.equal(first.receipt.sequence,1);
  neverFinance(first);
  const restarted=new SyntheticPersistentAuditCustodian(h.config);
  const found=restarted.find(operationId);
  assert.deepEqual(found,first.receipt);
  assert.deepEqual(restarted.latest(),first.receipt);
  const replay=restarted.append({operationId,witness:item.signed,
    journal:h.journal,issuedAt:'2026-11-15T17:01:00.000Z'});
  assert.equal(replay.created,false);
  assert.deepEqual(replay.receipt,first.receipt);
  assert.equal(restarted.records().length,1);
  const status=restarted.inspect({journal:h.journal,witness:item.signed,
    pinnedLatestReceipt:first.receipt});
  assert.equal(status.status,'synthetic_local_records_consistent');
  assert.equal(status.observedSequence,1);
  assert.equal(status.externalHighWatermarkAuthenticated,false);
  neverFinance(status);
  const raw=fs.readFileSync(h.custodyFile,'utf8');
  assert.equal((fs.statSync(h.custodyFile).mode&0o077),0);
  for(const secret of ['92495','ci-original-evidence-private',
    'ci-original-audit-chain-private','sk_live','customer@example.invalid']) {
    assert.equal(raw.includes(secret),false);
  }
});
test('new high-watermark survives simulated process restart and rejects old original order',t=>{
  const h=setup(t);
  const first=h.append();
  const previous=h.provider.append({operationId:randomUUID(),witness:first.signed,
    journal:h.journal,issuedAt:WHEN});
  const next=h.append('2026-11-15T17:01:00.000Z');
  const current=h.provider.append({operationId:randomUUID(),witness:next.signed,
    journal:h.journal,issuedAt:'2026-11-15T17:01:00.000Z'});
  assert.equal(current.receipt.sequence,2);
  assert.notEqual(current.receipt.previousAnchorDigest,'0'.repeat(64));
  const restarted=new SyntheticPersistentAuditCustodian(h.config);
  assert.equal(restarted.latest().sequence,2);
  assert.equal(restarted.inspect({journal:h.journal,witness:next.signed,
    pinnedLatestReceipt:current.receipt}).status,'synthetic_local_records_consistent');
  assert.throws(()=>restarted.append({
    operationId:randomUUID(),witness:first.signed,journal:h.journal,
    issuedAt:'2026-11-15T17:02:00.000Z',
  }));
  assert.equal(previous.receipt.sequence,1);
});
test('lost acknowledgement AFTER commit is resolved via original operation ID, with one persisted row',t=>{
  const h=setup(t);
  const {signed}=h.append();
  const operationId=randomUUID();
  // The caller loses the return value after a confirmed durable local fsync.
  h.provider.append({operationId,witness:signed,journal:h.journal,issuedAt:WHEN});
  const restarted=new SyntheticPersistentAuditCustodian(h.config);
  const found=restarted.find(operationId);
  assert.equal(found.operationId,operationId);
  const retry=restarted.append({operationId,witness:signed,journal:h.journal,issuedAt:WHEN});
  assert.equal(retry.created,false);
  assert.equal(restarted.records().length,1);
});
test('reused operation ID for different signed journal head and old watermark fail closed',t=>{
  const h=setup(t);
  const a=h.append();
  const operationId=randomUUID();
  h.provider.append({operationId,witness:a.signed,journal:h.journal,issuedAt:WHEN});
  const b=h.append('2026-11-15T17:05:00.000Z');
  assert.throws(()=>h.provider.append({operationId,witness:b.signed,journal:h.journal,
    issuedAt:'2026-11-15T17:05:00.000Z'}));
  assert.equal(h.provider.records().length,1);
  const inspection=h.provider.inspect({journal:h.journal,witness:b.signed});
  assert.equal(inspection.status,'blocked_manual_investigation');
  neverFinance(inspection);
  const accepted=h.provider.append({operationId:randomUUID(),witness:b.signed,
    journal:h.journal,issuedAt:'2026-11-15T17:05:00.000Z'});
  assert.equal(accepted.receipt.sequence,2);
});
test('modified, out-of-order and incomplete ledger rows block lookup, append, and recovery without auto-repair',t=>{
  const h=setup(t);
  const a=h.append();
  const op=randomUUID();
  const one=h.provider.append({operationId:op,witness:a.signed,journal:h.journal,issuedAt:WHEN});
  const b=h.append('2026-11-15T17:05:00.000Z');
  h.provider.append({operationId:randomUUID(),witness:b.signed,
    journal:h.journal,issuedAt:'2026-11-15T17:05:00.000Z'});
  const original=fs.readFileSync(h.custodyFile,'utf8');
  for(const damaged of [
    original.replace(one.receipt.tag,'f'.repeat(64)),
    original.trimEnd(),
    original.trimEnd().split('\n').reverse().join('\n')+'\n',
  ]) {
    fs.writeFileSync(h.custodyFile,damaged,{mode:0o600});
    assert.throws(()=>h.provider.latest());
    assert.throws(()=>h.provider.find(op));
    assert.throws(()=>h.provider.append({operationId:randomUUID(),witness:b.signed,
      journal:h.journal,issuedAt:'2026-11-15T17:06:00.000Z'}));
    assert.equal(h.provider.assessRecovery({candidateJournal:h.journal,witness:b.signed})
      .recoveryPerformed,false);
  }
  fs.writeFileSync(h.custodyFile,original,{mode:0o600});
  assert.equal(h.provider.records().length,2);
});
test('valid-prefix rollback needs a separately pinned off-host receipt; local chain alone is insufficient',t=>{
  const h=setup(t);
  const first=h.append();
  const old=h.provider.append({operationId:randomUUID(),witness:first.signed,
    journal:h.journal,issuedAt:WHEN});
  const prefix=fs.readFileSync(h.custodyFile,'utf8');
  const second=h.append('2026-11-15T17:05:00.000Z');
  const latest=h.provider.append({operationId:randomUUID(),witness:second.signed,
    journal:h.journal,issuedAt:'2026-11-15T17:05:00.000Z'});
  fs.writeFileSync(h.custodyFile,prefix,{mode:0o600});
  assert.equal(h.provider.latest().sequence,1);
  const blocked=h.provider.inspect({journal:h.journal,witness:second.signed,
    pinnedLatestReceipt:latest.receipt});
  assert.equal(blocked.status,'blocked_manual_investigation');
  neverFinance(blocked);
  fs.writeFileSync(h.custodyFile,fs.readFileSync(h.custodyFile,'utf8'),{mode:0o600});
  // This local-only store cannot authenticate or preserve that external pin.
  assert.equal(h.provider.inspect({journal:h.journal,witness:first.signed,
    pinnedLatestReceipt:old.receipt}).status,'blocked_manual_investigation');
});
test('stale append lock, symlink, unsafe file permissions and bad signing key fail closed',t=>{
  const h=setup(t);
  const {signed}=h.append();
  const lock=path.join(h.cdir,'synthetic-persistent-anchors.lock');
  fs.writeFileSync(lock,'stale',{mode:0o600});
  assert.throws(()=>h.provider.append({operationId:randomUUID(),
    witness:signed,journal:h.journal,issuedAt:WHEN}));
  fs.unlinkSync(lock);
  h.provider.append({operationId:randomUUID(),witness:signed,
    journal:h.journal,issuedAt:WHEN});
  fs.chmodSync(h.custodyFile,0o644);
  assert.throws(()=>h.provider.latest());
  fs.chmodSync(h.custodyFile,0o600);
  const raw=fs.readFileSync(h.custodyFile,'utf8');
  const target=path.join(h.cdir,'target');
  fs.writeFileSync(target,raw,{mode:0o600});
  fs.unlinkSync(h.custodyFile);
  fs.symlinkSync(target,h.custodyFile);
  assert.throws(()=>h.provider.latest());
  assert.throws(()=>h.provider.append({operationId:randomUUID(),
    witness:signed,journal:h.journal,issuedAt:WHEN}));
  const wrong=generateKeyPairSync('ed25519');
  assert.throws(()=>new SyntheticPersistentAuditCustodian({
    ...h.config,witnessPublicKey:h.custodianSigner.publicKey,
    custodianPrivateKey:h.custodianSigner.privateKey,
  }));
  assert.equal(wrong.publicKey.asymmetricKeyType,'ed25519');
});
test('production mode, arbitrary path, same signer, unverified witness and invalid UUID cannot activate writes',t=>{
  const h=setup(t);
  const {signed}=h.append();
  for(const change of [
    {env:{NODE_ENV:'production',MANSU_CI_SYNTHETIC_PERSISTENT_CUSTODY:'true'}},
    {env:{NODE_ENV:'test'}},
    {directory:h.root},{directory:os.tmpdir()},
    {custodianPrivateKey:h.signer.privateKey},
    {custodianPrivateKey:h.custodianSigner.publicKey},
  ]) assert.throws(()=>new SyntheticPersistentAuditCustodian({...h.config,...change}));
  assert.throws(()=>h.provider.append({operationId:'raw-gateway-reference',
    witness:signed,journal:h.journal,issuedAt:WHEN}));
  assert.throws(()=>h.provider.append({operationId:randomUUID(),
    witness:{...signed,tag:'e'.repeat(64)},
    journal:h.journal,issuedAt:WHEN}));
  assert.equal(h.provider.records().length,0);
});
test('read-only recovery candidate never rewrites journal, authenticates external custody, or restores stock',t=>{
  const h=setup(t);
  const first=h.append();
  const applied=h.provider.append({operationId:randomUUID(),witness:first.signed,
    journal:h.journal,issuedAt:WHEN});
  const before=fs.readFileSync(h.journalFile,'utf8');
  const ok=h.provider.assessRecovery({candidateJournal:h.journal,witness:first.signed,
    pinnedLatestReceipt:applied.receipt});
  assert.equal(ok.candidateMatchesLocalRecords,true);
  assert.equal(ok.productionRestoreApproved,false);
  assert.equal(ok.recoveryPerformed,false);
  assert.equal(ok.journalWritten,false);
  neverFinance(ok);
  assert.equal(fs.readFileSync(h.journalFile,'utf8'),before);
  const second=h.append('2026-11-15T17:05:00.000Z');
  assert.equal(h.provider.assessRecovery({candidateJournal:h.journal,witness:second.signed})
    .candidateMatchesLocalRecords,false);
});
