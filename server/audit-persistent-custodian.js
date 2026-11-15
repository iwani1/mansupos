/**
 * Phase 3.7 — restart-safe, FILE-BACKED synthetic audit custodian.
 *
 * This simulates persistence across a process restart. Storage remains local
 * to a private CI temp directory, NOT an independent off-host/WORM provider.
 * No app import, network, live service, Paystack, bank, refund or stock access.
 * Never interpret matching signatures as permission to unlock checkout.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX=/^[0-9a-f]{64}$/;
const B64=/^[A-Za-z0-9_-]{86}$/;
const DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const WITNESS=['kind','version','sequence','tag','previousReceiptHash','issuedAt','signature'];
const ROW=['kind','version','siteId','operationId','sequence','tag','witnessDigest','previousAnchorDigest','issuedAt','signature'];
const GENESIS='0'.repeat(64);
const LIMIT=1024*1024;
const MAX_ROWS=1000;
const FLAGS={
  independentRemoteCustodyVerified:false,
  immutableProviderRetentionVerified:false,
  ownerNotificationDelivered:false,
  bankSettlementVerified:false,
  checkoutAuthorized:false,refundAuthorized:false,
  payoutExecuted:false,stockRestored:false,automatedRecoveryAllowed:false,
};
function denied(){return new Error('Synthetic persistent custodian refused unsafe evidence; manual review required.');}
function exact(o,keys){return !!o && typeof o==='object' && !Array.isArray(o) &&
  Object.keys(o).length===keys.length && keys.every(k=>Object.hasOwn(o,k));}
function hash(s){return createHash('sha256').update(s,'utf8').digest('hex');}
function time(s){return typeof s==='string' && DATE.test(s) && Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString()===s;}
function pub(k){return k?.type==='public' && k.asymmetricKeyType==='ed25519';}
function priv(k){return k?.type==='private' && k.asymmetricKeyType==='ed25519';}
function signature(s){return typeof s==='string' && B64.test(s) &&
  Buffer.from(s,'base64url').length===64;}
function canonical(o,keys){return Object.fromEntries(keys.map(k=>[k,o[k]]));}
function checkWitness(w,key) {
  if (!exact(w,WITNESS) || w.kind!=='mansu-synthetic-evidence-checkpoint' ||
      w.version!==1 || !Number.isSafeInteger(w.sequence) || w.sequence<1 ||
      !HEX.test(w.tag) || !HEX.test(w.previousReceiptHash) || !time(w.issuedAt) ||
      !signature(w.signature)) throw denied();
  const fields=canonical(w,WITNESS.slice(0,-1));
  if (!verify(null,Buffer.from('mansupos-financial-evidence-checkpoint-v1\n'+JSON.stringify(fields)),
    key,Buffer.from(w.signature,'base64url'))) throw denied();
  return canonical(w,WITNESS);
}
function checkRow(r,site,key) {
  if (!exact(r,ROW) || r.kind!=='mansu-synthetic-persistent-custody' ||
      r.version!==1 || r.siteId!==site || !UUID.test(r.operationId || '') ||
      !Number.isSafeInteger(r.sequence) || r.sequence<1 ||
      !HEX.test(r.tag) || !HEX.test(r.witnessDigest) ||
      !HEX.test(r.previousAnchorDigest) || !time(r.issuedAt) ||
      !signature(r.signature)) throw denied();
  const fields=canonical(r,ROW.slice(0,-1));
  if (!verify(null,Buffer.from('mansupos-synthetic-persistent-custody-v1\n'+JSON.stringify(fields)),
    key,Buffer.from(r.signature,'base64url'))) throw denied();
  return canonical(r,ROW);
}
function directory(d) {
  if (typeof d!=='string') throw denied();
  let real;
  try {real=fs.realpathSync(d);} catch {throw denied();}
  const root=fs.realpathSync(os.tmpdir());
  const stat=fs.statSync(real);
  if (path.resolve(d)!==real || path.dirname(real)!==root ||
      !path.basename(real).startsWith('mansu-persistent-custody-ci-') ||
      !stat.isDirectory() || (stat.mode & 0o077)!==0) throw denied();
  return real;
}
function statFile(fd) {
  const s=fs.fstatSync(fd);
  if (!s.isFile() || (s.mode & 0o077)!==0 || s.size>LIMIT) throw denied();
  return s.size;
}
function read(file,site,key) {
  let fd;
  try {fd=fs.openSync(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));}
  catch(e){if(e.code==='ENOENT')return []; throw denied();}
  let data;
  try{statFile(fd);data=fs.readFileSync(fd,'utf8');}
  catch{throw denied();}
  finally{fs.closeSync(fd);}
  if (!data)return [];
  if (!data.endsWith('\n'))throw denied();
  const lines=data.slice(0,-1).split('\n');
  if (lines.length>MAX_ROWS || lines.some(l=>l.length>4096 || !l))throw denied();
  const records=[];
  let prev=GENESIS,lastSequence=0,lastTime=0;
  const ids=new Set();
  for(const line of lines) {
    let parsed;
    try {parsed=JSON.parse(line);}catch{throw denied();}
    const record=checkRow(parsed,site,key);
    if (JSON.stringify(record)!==line ||
        record.previousAnchorDigest!==prev ||
        record.sequence<=lastSequence || Date.parse(record.issuedAt)<lastTime ||
        ids.has(record.operationId))throw denied();
    prev=hash(JSON.stringify(record));
    lastSequence=record.sequence;
    lastTime=Date.parse(record.issuedAt);
    ids.add(record.operationId);
    records.push(record);
  }
  return records;
}
function guard(env) {
  if(env?.NODE_ENV!=='test' ||
    env?.MANSU_CI_SYNTHETIC_PERSISTENT_CUSTODY!=='true')throw denied();
}
function safeStatus(status,data={}) {
  return Object.freeze({
    kind:'synthetic-persistent-custody-status',status,...data,...FLAGS,
    productionCustodyApproved:false,
  });
}
function checkHead(journal,witness) {
  if (!journal || typeof journal.verify!=='function')throw denied();
  const check=journal.verify({expectedHead:{sequence:witness.sequence,tag:witness.tag}});
  if(check.localHmacChainValid!==true || check.recordCount!==witness.sequence)throw denied();
}
export class SyntheticPersistentAuditCustodian {
  constructor({env,directory:location,siteId,witnessPublicKey,custodianPrivateKey}={}) {
    guard(env);
    if (!UUID.test(siteId||'') || !pub(witnessPublicKey) || !priv(custodianPrivateKey))throw denied();
    const publicKey=createPublicKey(custodianPrivateKey);
    if (publicKey.export({format:'der',type:'spki'}).equals(
      witnessPublicKey.export({format:'der',type:'spki'})))throw denied();
    this.siteId=siteId.toLowerCase();
    this.directory=directory(location);
    this.file=path.join(this.directory,'synthetic-persistent-anchors.ndjson');
    this.lock=path.join(this.directory,'synthetic-persistent-anchors.lock');
    this.witnessPublicKey=witnessPublicKey;
    this.privateKey=custodianPrivateKey;
    this.publicKey=publicKey;
  }
  records() {return read(this.file,this.siteId,this.publicKey);}
  latest() {return this.records().at(-1)||null;}
  find(operationId) {
    if(!UUID.test(operationId||''))throw denied();
    return this.records().find(r=>r.operationId===operationId)||null;
  }
  append({operationId,witness,journal,issuedAt}={}) {
    if(!UUID.test(operationId||'') || !time(issuedAt))throw denied();
    const signed=checkWitness(witness,this.witnessPublicKey);
    checkHead(journal,signed);
    let lockFd;
    try {lockFd=fs.openSync(this.lock,fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW || 0),0o600);}
    catch {throw denied();}
    try {
      const existing=this.records();
      const found=existing.find(r=>r.operationId===operationId);
      const digest=hash(JSON.stringify(signed));
      if(found){
        if(found.sequence!==signed.sequence || found.tag!==signed.tag ||
          found.witnessDigest!==digest)throw denied();
        return Object.freeze({created:false,receipt:found,...FLAGS});
      }
      const previous=existing.at(-1);
      if (previous && (signed.sequence<=previous.sequence ||
          Date.parse(issuedAt)<Date.parse(previous.issuedAt)))throw denied();
      if (existing.length>=MAX_ROWS)throw denied();
      const fields={
        kind:'mansu-synthetic-persistent-custody',version:1,
        siteId:this.siteId,operationId,sequence:signed.sequence,
        tag:signed.tag,witnessDigest:digest,
        previousAnchorDigest:previous?hash(JSON.stringify(previous)):GENESIS,
        issuedAt,
      };
      const row={...fields,signature:sign(null,
        Buffer.from('mansupos-synthetic-persistent-custody-v1\n'+JSON.stringify(fields)),
        this.privateKey).toString('base64url')};
      const line=JSON.stringify(row)+'\n';
      let fd;
      try{
        fd=fs.openSync(this.file,fs.constants.O_WRONLY|fs.constants.O_APPEND|
          fs.constants.O_CREAT|(fs.constants.O_NOFOLLOW||0),0o600);
        const size=statFile(fd);
        if(size+Buffer.byteLength(line)>LIMIT)throw denied();
        if(fs.writeSync(fd,line,null,'utf8')!==Buffer.byteLength(line))throw denied();
        fs.fsyncSync(fd);
      }finally{if(fd!==undefined)fs.closeSync(fd);}
      return Object.freeze({created:true,receipt:Object.freeze(row),...FLAGS});
    } finally {
      fs.closeSync(lockFd);
      fs.unlinkSync(this.lock);
    }
  }
  inspect({journal,witness,pinnedLatestReceipt}={}) {
    try{
      const signed=checkWitness(witness,this.witnessPublicKey);
      checkHead(journal,signed);
      const latest=this.latest();
      if(!latest || latest.sequence!==signed.sequence ||
        latest.tag!==signed.tag ||
        latest.witnessDigest!==hash(JSON.stringify(signed)))throw denied();
      if (pinnedLatestReceipt!==undefined) {
        const pinned=checkRow(pinnedLatestReceipt,this.siteId,this.publicKey);
        if(JSON.stringify(pinned)!==JSON.stringify(latest))throw denied();
      }
      return safeStatus('synthetic_local_records_consistent',{
        observedSequence:latest.sequence,recordCount:this.records().length,
        externalHighWatermarkAuthenticated:false,
      });
    }catch{
      return safeStatus('blocked_manual_investigation',{
        issueCode:'DURABLE_CUSTODY_OR_WITNESS_DIVERGENCE',
        requiresOwnerSecurityReview:true,
      });
    }
  }
  assessRecovery({candidateJournal,witness,pinnedLatestReceipt}={}) {
    const state=this.inspect({journal:candidateJournal,witness,pinnedLatestReceipt});
    return Object.freeze({...state,kind:'synthetic-custody-recovery-assessment',
      candidateMatchesLocalRecords:state.status==='synthetic_local_records_consistent',
      productionRestoreApproved:false,recoveryPerformed:false,journalWritten:false});
  }
}
// No provider API, live/merchant credentials, remote witness, payment, stock,
// external incident channel, auto-repair or production enablement.
