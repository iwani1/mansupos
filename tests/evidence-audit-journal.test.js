import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SyntheticEvidenceAuditJournal } from '../server/evidence-audit-journal.js';

const siteId='72b1645b-bc7e-4be4-924d-3d3b9dbfbe89';
const eventHmacKey='synthetic_order_pseudonym_key_separate_123456789';
const chainHmacKey='synthetic_audit_chain_key_always_distinct_987654321';
const env={ NODE_ENV:'test', MANSU_CI_SYNTHETIC_EVIDENCE_AUDIT:'true' };
const timestamp='2026-11-15T15:00:00.000Z';
const payload=(overrides={})=>({
  orderId:89210,siteId,correlationId:randomUUID(),
  outcome:'review_started',time:timestamp,...overrides,
});
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-evidence-audit-ci-'));
  const j=new SyntheticEvidenceAuditJournal({
    env,directory:dir,eventHmacKey,chainHmacKey,
  });
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,j,file:path.join(dir,'synthetic-financial-evidence.ndjson'),
    lock:path.join(dir,'synthetic-financial-evidence.lock')};
}

test('synthetic append-only audit chains distinct order events, verifies the head, and never enables financial actions',t=>{
  const {j,file}=fixture(t);
  const a=payload();
  const first=j.append(a);
  assert.equal(first.created,true);
  assert.equal(first.sequence,1);
  assert.equal(first.head.sequence,1);
  assert.match(first.head.tag,/^[a-f0-9]{64}$/);
  assert.equal(first.checkoutAuthorized,false);
  assert.equal(first.refundExecuted,false);
  assert.equal(first.stockRestored,false);
  const second=j.append(payload({orderId:89211,outcome:'source_snapshot_incomplete'}));
  assert.equal(second.sequence,2);
  assert.notEqual(first.head.tag,second.head.tag);
  const integrity=j.verify({expectedHead:second.head});
  assert.equal(integrity.recordCount,2);
  assert.equal(integrity.localHmacChainValid,true);
  assert.equal(integrity.independentAnchorSupplied,true);
  assert.equal(integrity.independentAnchorAuthenticated,false);
  assert.equal(integrity.rollbackProtectionVerified,false);
  assert.equal(integrity.productionAuditAccepted,false);
  assert.equal(integrity.bankFundsReceivedVerified,false);
  assert.equal(integrity.merchantPaymentVerified,false);
  assert.equal(integrity.checkoutAuthorized,false);
  assert.equal(Object.isFrozen(integrity),true);
  const content=fs.readFileSync(file,'utf8');
  assert.equal(content.trim().split('\n').length,2);
  assert.equal((fs.statSync(file).mode & 0o077),0);
  for(const privateValue of [
    String(a.orderId),String(89211),siteId,eventHmacKey,chainHmacKey,
    'private@example.invalid','customer_reference_original',
  ]) {
    assert.equal(content.includes(privateValue),false,'No raw order IDs or credentials in journal');
  }
});

test('identical correlation event retries are idempotent but conflicting payload for same correlation fails closed',t=>{
  const {j,file}=fixture(t);
  const input=payload();
  const initial=j.append(input);
  const retry=j.append(input);
  assert.equal(retry.created,false);
  assert.equal(retry.sequence,initial.sequence);
  assert.equal(retry.head.tag,initial.head.tag);
  assert.equal(fs.readFileSync(file,'utf8').trim().split('\n').length,1);
  assert.throws(()=>j.append({...input,outcome:'identity_mismatch'}),/failed closed/);
  assert.equal(j.verify().recordCount,1);
});

test('tampered, reordered, truncated, or partial journal rows are rejected, with no auto-repair',t=>{
  const {j,file}=fixture(t);
  j.append(payload({outcome:'review_started'}));
  const head=j.append(payload({orderId:89212,outcome:'identity_mismatch'})).head;
  const original=fs.readFileSync(file,'utf8');
  const lines=original.split('\n').filter(Boolean);

  fs.writeFileSync(file,original.replace('identity_mismatch','source_read_failed'),{mode:0o600});
  assert.throws(()=>j.verify(),/failed closed/);
  assert.throws(()=>j.append(payload()),/failed closed/);
  fs.writeFileSync(file,lines.reverse().join('\n')+'\n',{mode:0o600});
  assert.throws(()=>j.verify(),/failed closed/);
  fs.writeFileSync(file,original+'{"sequence":3',{mode:0o600});
  assert.throws(()=>j.verify(),/failed closed/);
  assert.throws(()=>j.append(payload()),/failed closed/);

  // A malicious entire-tail rollback can leave a locally valid chain.
  // Only a separately retained authenticated head can expose it.
  fs.writeFileSync(file,original.split('\n')[0]+'\n',{mode:0o600});
  assert.equal(j.verify().recordCount,1);
  assert.throws(()=>j.verify({expectedHead:head}),/failed closed/);
  fs.writeFileSync(file,original,{mode:0o600});
  assert.equal(j.verify({expectedHead:head}).recordCount,2);
});

test('exclusive lock rejects a second writer and a crashed stale lock fails closed',t=>{
  const {j,lock}=fixture(t);
  const fd=fs.openSync(lock,'wx',0o600);
  try {
    assert.throws(()=>j.append(payload()),/failed closed/);
    assert.equal(j.verify().recordCount,0);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
  assert.equal(j.append(payload()).created,true);
});

test('refuse production, untrusted directories, shared keys, invalid outcomes, and malformed identities',t=>{
  const {j,dir,file}=fixture(t);
  for(const changes of [
    {env:{ NODE_ENV:'production',MANSU_CI_SYNTHETIC_EVIDENCE_AUDIT:'true' }},
    {env:{ NODE_ENV:'test',MANSU_CI_SYNTHETIC_EVIDENCE_AUDIT:'false' }},
    {chainHmacKey:eventHmacKey},
    {directory:os.tmpdir()},
    {directory:process.cwd()},
  ]) {
    assert.throws(()=>new SyntheticEvidenceAuditJournal({
      env,directory:dir,eventHmacKey,chainHmacKey,...changes,
    }),/failed closed/);
  }
  for(const changes of [
    {outcome:'refund_approved'},{orderId:-1},{correlationId:'customer-phone'},
    {siteId:'bad-site'},{time:'2026-11-15'},
  ]) assert.throws(()=>j.append(payload(changes)));
  assert.equal(j.verify().recordCount,0);
  j.append(payload());
  fs.chmodSync(file,0o644);
  assert.throws(()=>j.verify(),/failed closed/);
  assert.throws(()=>j.append(payload()),/failed closed/);
});

test('symlinked storage, invalid external witness, and leaked customer payload never bypass strict integrity',t=>{
  const {j,dir,file}=fixture(t);
  const alternate=path.join(dir,'other-data');
  fs.writeFileSync(alternate,'private content',{mode:0o600});
  fs.symlinkSync(alternate,file);
  assert.throws(()=>j.append(payload()),/failed closed/);
  assert.throws(()=>j.verify(),/failed closed/);
  fs.unlinkSync(file);
  const row=j.append(payload({customerEmail:'never-save@example.invalid',
    paystackSecret:'sk_test_private',
    bankAccount:'000-000-000'}));
  assert.equal(row.created,true);
  const content=fs.readFileSync(file,'utf8');
  for(const secret of ['never-save@example.invalid','sk_test_private','000-000-000']) {
    assert.equal(content.includes(secret),false);
  }
  for(const bad of [
    null,{}, {sequence:row.head.sequence,tag:'bad'},
    {sequence:row.head.sequence+1,tag:row.head.tag},
    {sequence:row.head.sequence,tag:row.head.tag,customerEmail:'bad'},
  ]) assert.throws(()=>j.verify({expectedHead:bad}),/failed closed/);
  assert.equal(j.verify({expectedHead:row.head}).recordCount,1);
});
