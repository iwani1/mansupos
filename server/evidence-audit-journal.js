/**
 * Phase 3.2 — SYNTHETIC, OFFLINE, fail-closed financial evidence audit journal.
 *
 * NOT an independently attested production ledger or a bank settlement record.
 * Never imported by POS app.js, no API, scheduler, network, merchant credentials,
 * checkout, refund, payout or stock write. Restricted to a private CI temp dir.
 *
 * A local HMAC chain detects modified/reordered rows when the HMAC key is
 * uncompromised. Detecting whole-file deletion/rollback requires an independently
 * retained trusted head supplied to verify(); an attacker controlling the
 * host and key can rewrite this ledger. There is deliberately NO repair path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { constants, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { buildMerchantEvidenceAuditEvent } from './merchant-evidence-boundary.js';

const F = fs.constants;
const GENESIS = '0'.repeat(64);
const MAX_BYTES = 1024 * 1024; // bounded synthetic fixture, never silently truncate
const MAX_RECORDS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const EVENT_KEYS = [
  'kind','eventVersion','correlationId','originalOrderToken','outcome',
  'occurredAt','source','readOnly','bankFundsVerified','merchantIdentityVerified',
  'payoutConfirmed','refundAuthorized','checkoutAuthorized','financialWriteAuthorized',
];
const ROW_KEYS = ['sequence','previousTag','event','tag'];
const OUTCOMES = new Set([
  'review_started','source_configuration_blocked','identity_mismatch',
  'source_snapshot_incomplete','source_snapshot_consistent_unverified','source_read_failed',
]);
function refused() {
  return new Error('Synthetic evidence audit journal failed closed; manual integrity review required.');
}
function keysMatch(object, keys) {
  return object && !Array.isArray(object) && typeof object === 'object' &&
    Object.keys(object).length === keys.length &&
    keys.every(key => Object.hasOwn(object, key));
}
function safeEvent(event) {
  if (!keysMatch(event,EVENT_KEYS) ||
      event.kind !== 'merchant-evidence-access-audit' ||
      event.eventVersion !== 1 || !UUID.test(event.correlationId) ||
      !HEX.test(event.originalOrderToken) ||
      !OUTCOMES.has(event.outcome) ||
      typeof event.occurredAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.occurredAt) ||
      !Number.isFinite(Date.parse(event.occurredAt)) ||
      event.source !== 'dedicated-financial-reader' ||
      event.readOnly !== true ||
      [
        'bankFundsVerified','merchantIdentityVerified','payoutConfirmed',
        'refundAuthorized','checkoutAuthorized','financialWriteAuthorized',
      ].some(key => event[key] !== false)) throw refused();
  // Copy only exact approved fields in one canonical order.
  return Object.fromEntries(EVENT_KEYS.map(key => [key,event[key]]));
}
function secureHash(secret) {
  return createHash('sha256').update(secret,'utf8').digest();
}
function hmac(key, object) {
  return createHmac('sha256',key).update(JSON.stringify(object),'utf8').digest('hex');
}
function equalHex(first,second) {
  return typeof first === 'string' && typeof second === 'string' &&
    HEX.test(first) && HEX.test(second) &&
    timingSafeEqual(Buffer.from(first,'hex'),Buffer.from(second,'hex'));
}
function expectHead(input) {
  if (!input || !keysMatch(input,['sequence','tag']) ||
      !Number.isSafeInteger(input.sequence) || input.sequence < 0 ||
      !HEX.test(input.tag)) throw refused();
  return input;
}
function checkFile(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES) throw refused();
}
function withinPrivateCI(dir) {
  if (typeof dir !== 'string') throw refused();
  let real;
  try { real = fs.realpathSync(dir); } catch { throw refused(); }
  const temp = fs.realpathSync(os.tmpdir());
  const stat = fs.statSync(real);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
      path.resolve(dir) !== real || path.dirname(real) !== temp ||
      !path.basename(real).startsWith('mansu-evidence-audit-ci-')) throw refused();
  return real;
}
function completeRows(journalPath,chainKey) {
  let fd;
  try {
    fd = fs.openSync(journalPath,F.O_RDONLY | (F.O_NOFOLLOW || 0));
  } catch(error) {
    if (error.code === 'ENOENT') return [];
    throw refused();
  }
  let data;
  try {
    checkFile(fd);
    data=fs.readFileSync(fd,{encoding:'utf8'});
  } catch { throw refused(); } finally { fs.closeSync(fd); }
  if (!data) return [];
  if (!data.endsWith('\n') || Buffer.byteLength(data,'utf8') > MAX_BYTES) throw refused();
  const lines=data.slice(0,-1).split('\n');
  if (lines.length > MAX_RECORDS || lines.some(line => !line || line.length>8192)) throw refused();
  let previous=GENESIS;
  const correlations=new Set();
  const rows=[];
  for (let i=0;i<lines.length;i++) {
    let parsed;
    try { parsed=JSON.parse(lines[i]); } catch { throw refused(); }
    if (!keysMatch(parsed,ROW_KEYS) ||
        !Number.isSafeInteger(parsed.sequence) || parsed.sequence!==i+1 ||
        !equalHex(parsed.previousTag,previous) ||
        !HEX.test(parsed.tag)) throw refused();
    const canonical=safeEvent(parsed.event);
    const expected=hmac(chainKey,{sequence:parsed.sequence,previousTag:previous,event:canonical});
    if (!equalHex(parsed.tag,expected) ||
        correlations.has(canonical.correlationId)) throw refused();
    correlations.add(canonical.correlationId);
    rows.push({sequence:parsed.sequence,previousTag:previous,event:canonical,tag:parsed.tag});
    previous=parsed.tag;
  }
  return rows;
}

export class SyntheticEvidenceAuditJournal {
  constructor({env,directory,eventHmacKey,chainHmacKey}={}) {
    if (env?.NODE_ENV!=='test' ||
        env?.MANSU_CI_SYNTHETIC_EVIDENCE_AUDIT!=='true' ||
        typeof eventHmacKey!=='string' || typeof chainHmacKey!=='string' ||
        Buffer.byteLength(eventHmacKey)<32 || Buffer.byteLength(chainHmacKey)<32 ||
        timingSafeEqual(secureHash(eventHmacKey),secureHash(chainHmacKey))) {
      throw refused();
    }
    this.directory=withinPrivateCI(directory);
    this.journalPath=path.join(this.directory,'synthetic-financial-evidence.ndjson');
    this.lockPath=path.join(this.directory,'synthetic-financial-evidence.lock');
    this.eventHmacKey=eventHmacKey;
    this.chainHmacKey=chainHmacKey;
  }
  verify({expectedHead}={}) {
    const records=completeRows(this.journalPath,this.chainHmacKey);
    const last=records.at(-1);
    const head=Object.freeze({sequence:records.length,tag:last?.tag || GENESIS});
    const independentAnchorSupplied=expectedHead!==undefined;
    if (independentAnchorSupplied) {
      const required=expectHead(expectedHead);
      if (required.sequence!==head.sequence || !equalHex(required.tag,head.tag)) throw refused();
    }
    return Object.freeze({
      kind:'synthetic-financial-evidence-audit-verification',
      recordCount:records.length,head,
      localHmacChainValid:true,
      independentAnchorSupplied,
      independentAnchorAuthenticated:false, // caller ownership is not established
      rollbackProtectionVerified:false,
      productionAuditAccepted:false,
      merchantPaymentVerified:false,
      bankFundsReceivedVerified:false,
      refundExecuted:false,
      stockRestored:false,
      checkoutAuthorized:false,
      notices:'A valid local HMAC chain is not proof of trusted host custody or bank settlement. Retain and authenticate the head independently to detect a file rollback.',
    });
  }
  append({orderId,siteId,correlationId,outcome,time}={}) {
    // CI only. A cross-process O_EXCL lock fails closed if another appender
    // is active or a crashed process left stale state. No force-unlock API.
    let lockFd;
    try {
      lockFd=fs.openSync(this.lockPath,
        F.O_CREAT | F.O_EXCL | F.O_WRONLY | (F.O_NOFOLLOW || 0),0o600);
    } catch { throw refused(); }
    try {
      const event=safeEvent(buildMerchantEvidenceAuditEvent({
        auditHmacKey:this.eventHmacKey,orderId,siteId,correlationId,outcome,time,
      }));
      const rows=completeRows(this.journalPath,this.chainHmacKey);
      const existing=rows.find(row => row.event.correlationId===event.correlationId);
      const head=rows.at(-1)?.tag || GENESIS;
      if (existing) {
        if (JSON.stringify(existing.event)!==JSON.stringify(event)) throw refused();
        return Object.freeze({
          kind:'synthetic-financial-evidence-audit-append',
          created:false,sequence:existing.sequence,
          head:Object.freeze({sequence:rows.length,tag:head}),
          checkoutAuthorized:false,refundExecuted:false,stockRestored:false,
        });
      }
      if (rows.length>=MAX_RECORDS) throw refused();
      const record={
        sequence:rows.length+1,previousTag:head,event,
      };
      const complete={...record,tag:hmac(this.chainHmacKey,record)};
      const line=JSON.stringify(complete)+'\n';
      const existingBytes=rows.length>0?
        fs.statSync(this.journalPath).size:0;
      if (existingBytes+Buffer.byteLength(line,'utf8')>MAX_BYTES) throw refused();
      let fd;
      try {
        fd=fs.openSync(this.journalPath,
          F.O_APPEND | F.O_WRONLY | F.O_CREAT | (F.O_NOFOLLOW || 0),0o600);
        checkFile(fd);
        const written=fs.writeSync(fd,line,null,'utf8');
        if (written!==Buffer.byteLength(line,'utf8')) throw refused();
        fs.fsyncSync(fd);
      } finally { if (fd!==undefined) fs.closeSync(fd); }
      return Object.freeze({
        kind:'synthetic-financial-evidence-audit-append',
        created:true,sequence:complete.sequence,
        head:Object.freeze({sequence:complete.sequence,tag:complete.tag}),
        checkoutAuthorized:false,refundExecuted:false,stockRestored:false,
      });
    } finally {
      fs.closeSync(lockFd);
      fs.unlinkSync(this.lockPath);
    }
  }
}

// Deliberately no module initialization, production env reader, POS import,
// HTTP endpoint, external credential, remote logging or live filesystem path.
