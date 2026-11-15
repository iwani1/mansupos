import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SyntheticEvidenceAuditJournal } from '../server/evidence-audit-journal.js';
import { SyntheticEvidenceCheckpointWitness,
  verifySyntheticWitnessAgainstJournal } from '../server/evidence-checkpoint-witness.js';

const env={NODE_ENV:'test',MANSU_CI_SYNTHETIC_EVIDENCE_AUDIT:'true',
  MANSU_CI_SYNTHETIC_EVIDENCE_WITNESS:'true'};
const siteId='72b1645b-bc7e-4be4-924d-3d3b9dbfbe89';
const time='2026-11-15T15:45:00.000Z';
function temp(prefix) {return fs.mkdtempSync(path.join(os.tmpdir(),prefix));}
function fixture(t) {
  const journalDir=temp('mansu-evidence-audit-ci-');
  const witnessDir=temp('mansu-evidence-witness-ci-');
  t.after(()=>{
    fs.rmSync(journalDir,{recursive:true,force:true});
    fs.rmSync(witnessDir,{recursive:true,force:true});
  });
  const keys=generateKeyPairSync('ed25519');
  const journal=new SyntheticEvidenceAuditJournal({
    env,directory:journalDir,
    eventHmacKey:'synthetic-order-hmac-private-abcdefghijklmnopqrstuvwxyz',
    chainHmacKey:'synthetic-ledger-hmac-private-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  });
  const witness=new SyntheticEvidenceCheckpointWitness({
    env,directory:witnessDir,privateKey:keys.privateKey,
  });
  const checkpointFile=path.join(witnessDir,'synthetic-signed-checkpoints.ndjson');
  const journalFile=path.join(journalDir,'synthetic-financial-evidence.ndjson');
  const payload=()=>({orderId:40102,siteId,correlationId:randomUUID(),
    time,outcome:'review_started'});
  const inspect=(overrides={})=>verifySyntheticWitnessAgainstJournal({
    env,witnessDirectory:witnessDir,publicKey:keys.publicKey,journal,...overrides,
  });
  return {journal,witness,journalDir,witnessDir,checkpointFile,journalFile,
    keys,payload,inspect};
}

test('distinct synthetic audit/witness directories: valid Ed25519 signature and exact journal head',t=>{
  const f=fixture(t);
  const a=f.journal.append(f.payload());
  const signed=f.witness.append(a.head,{issuedAt:time});
  assert.equal(signed.created,true);
  assert.equal(signed.receipt.sequence,1);
  assert.equal(signed.receipt.tag,a.head.tag);
  assert.equal(signed.receipt.externalCustodyVerified,false);
  assert.equal(signed.receipt.bankSettlementVerified,false);
  const b=f.journal.append(f.payload());
  const second=f.witness.append(b.head,{issuedAt:'2026-11-15T15:46:00.000Z'});
  assert.equal(second.created,true);
  assert.notEqual(second.receipt.signature,signed.receipt.signature);
  const result=f.inspect();
  assert.equal(result.signedHeadMatchesJournal,true);
  assert.equal(result.witnessSignatureChainValid,true);
  assert.equal(result.signedCheckpointCount,2);
  assert.equal(result.journalRecordCount,2);
  for(const key of ['publicKeyIndependentProvenanceVerified',
    'remoteWitnessCustodyVerified','rollbackProtectionProductionVerified',
    'bankFundsVerified','refundAuthorized','stockRestored','checkoutAuthorized']) {
    assert.equal(result[key],false,key);
  }
  const raw=fs.readFileSync(f.checkpointFile,'utf8');
  for(const secret of ['40102',siteId,'synthetic-order-hmac-private',
    'synthetic-ledger-hmac-private','customer@example.invalid']) {
    assert.equal(raw.includes(secret),false,'Do not record IDs or sensitive data');
  }
  assert.equal((fs.statSync(f.checkpointFile).mode&0o077),0);
});

test('checkpoint retry is idempotent; same sequence fork and older head fail closed',t=>{
  const f=fixture(t);
  const first=f.journal.append(f.payload());
  const a=f.witness.append(first.head,{issuedAt:time});
  const retry=f.witness.append(first.head,{issuedAt:time});
  assert.equal(retry.created,false);
  assert.equal(retry.receipt.signature,a.receipt.signature);
  assert.equal(fs.readFileSync(f.checkpointFile,'utf8').trim().split('\n').length,1);
  assert.throws(()=>f.witness.append({sequence:1,tag:'1'.repeat(64)},
    {issuedAt:time}),/failed closed/);
  const second=f.journal.append(f.payload());
  f.witness.append(second.head,{issuedAt:time});
  assert.throws(()=>f.witness.append(first.head,{issuedAt:time}),/failed closed/);
  assert.equal(f.inspect().signedCheckpointCount,2);
});

test('signatures and full journal comparisons detect tampered witness rows and wrong key',t=>{
  const f=fixture(t);
  const first=f.journal.append(f.payload());
  f.witness.append(first.head,{issuedAt:time});
  const body=fs.readFileSync(f.checkpointFile,'utf8');
  fs.writeFileSync(f.checkpointFile,body.replace(first.head.tag,'f'.repeat(64)),{mode:0o600});
  assert.throws(()=>f.inspect(),/failed closed/);
  fs.writeFileSync(f.checkpointFile,body,{mode:0o600});
  const another=generateKeyPairSync('ed25519');
  assert.throws(()=>f.inspect({publicKey:another.publicKey}),/failed closed/);
  assert.equal(f.inspect().signedHeadMatchesJournal,true);
  const lines=body.trim().split('\n').map(JSON.parse);
  lines[0].signature='A'.repeat(86);
  fs.writeFileSync(f.checkpointFile,JSON.stringify(lines[0])+'\n',{mode:0o600});
  assert.throws(()=>f.inspect(),/failed closed/);
});

test('journal deletion, valid-prefix rollback and unanchored append fail closed',t=>{
  const f=fixture(t);
  f.journal.append(f.payload());
  const firstContent=fs.readFileSync(f.journalFile,'utf8');
  const second=f.journal.append(f.payload());
  f.witness.append(second.head,{issuedAt:time});
  fs.writeFileSync(f.journalFile,firstContent,{mode:0o600});
  assert.equal(f.journal.verify().recordCount,1,
    'A local HMAC check alone cannot prove the tail was preserved');
  assert.throws(()=>f.inspect(),/failed closed/);
  fs.unlinkSync(f.journalFile);
  assert.throws(()=>f.inspect(),/failed closed/);
  fs.writeFileSync(f.journalFile,firstContent,{mode:0o600});
  const third=f.journal.append(f.payload());
  // Here the journal holds two records but the signed witness still points to
  // an unrelated head; matching sequence without matching HMAC must be denied.
  assert.equal(third.head.sequence,2);
  assert.throws(()=>f.inspect(),/failed closed/);
});

test('journal ahead of signed witness is not fully anchored until another checkpoint',t=>{
  const f=fixture(t);
  const first=f.journal.append(f.payload());
  f.witness.append(first.head,{issuedAt:time});
  f.journal.append(f.payload());
  assert.throws(()=>f.inspect(),/failed closed/);
  const current=f.journal.verify();
  f.witness.append(current.head,{issuedAt:'2026-11-15T15:46:00.000Z'});
  assert.equal(f.inspect().journalRecordCount,2);
});

test('strict synthetic-only execution and private directories, no production key export or online API',t=>{
  const f=fixture(t);
  const opts={env,directory:f.witnessDir,privateKey:f.keys.privateKey};
  for (const changes of [
    {env:{NODE_ENV:'production',MANSU_CI_SYNTHETIC_EVIDENCE_WITNESS:'true'}},
    {env:{NODE_ENV:'test',MANSU_CI_SYNTHETIC_EVIDENCE_WITNESS:'false'}},
    {directory:f.journalDir},{directory:os.tmpdir()},
    {privateKey:f.keys.publicKey},{privateKey:'not-a-key'},
  ]) assert.throws(()=>new SyntheticEvidenceCheckpointWitness({...opts,...changes}),/failed closed/);
  assert.throws(()=>f.witness.append({sequence:0,tag:'0'.repeat(64)},{issuedAt:time}),/failed closed/);
  assert.throws(()=>f.witness.append({sequence:1,tag:'1'.repeat(64)},{issuedAt:'today'}),/failed closed/);
  assert.throws(()=>f.inspect({witnessDirectory:f.journalDir}),/failed closed/);
  assert.throws(()=>f.inspect({publicKey:f.keys.privateKey}),/failed closed/);
});

test('stale lock, unsafe modes, symlink and truncated checkpoint stream fail closed',t=>{
  const f=fixture(t);
  const locked=path.join(f.witnessDir,'synthetic-signed-checkpoints.lock');
  fs.writeFileSync(locked,'stale',{mode:0o600});
  const head=f.journal.append(f.payload()).head;
  assert.throws(()=>f.witness.append(head,{issuedAt:time}),/failed closed/);
  fs.unlinkSync(locked);
  f.witness.append(head,{issuedAt:time});
  const body=fs.readFileSync(f.checkpointFile,'utf8');
  fs.writeFileSync(f.checkpointFile,body.slice(0,-2),{mode:0o600});
  assert.throws(()=>f.inspect(),/failed closed/);
  fs.writeFileSync(f.checkpointFile,body,{mode:0o600});
  fs.chmodSync(f.checkpointFile,0o644);
  assert.throws(()=>f.inspect(),/failed closed/);
  fs.chmodSync(f.checkpointFile,0o600);
  fs.unlinkSync(f.checkpointFile);
  const target=path.join(f.witnessDir,'target');
  fs.writeFileSync(target,body,{mode:0o600});
  fs.symlinkSync(target,f.checkpointFile);
  assert.throws(()=>f.inspect(),/failed closed/);
  assert.throws(()=>f.witness.append(head,{issuedAt:time}),/failed closed/);
});

test('removing BOTH valid local files can evade this same-host simulator: do not claim independent external custody',t=>{
  const f=fixture(t);
  const a=f.journal.append(f.payload());
  f.witness.append(a.head,{issuedAt:time});
  const journalPrefix=fs.readFileSync(f.journalFile,'utf8');
  const witnessPrefix=fs.readFileSync(f.checkpointFile,'utf8');
  f.journal.append(f.payload());
  f.witness.append(f.journal.verify().head,{issuedAt:time});
  fs.writeFileSync(f.journalFile,journalPrefix,{mode:0o600});
  fs.writeFileSync(f.checkpointFile,witnessPrefix,{mode:0o600});
  const outcome=f.inspect();
  assert.equal(outcome.signedHeadMatchesJournal,true);
  assert.equal(outcome.remoteWitnessCustodyVerified,false);
  assert.equal(outcome.rollbackProtectionProductionVerified,false);
});
