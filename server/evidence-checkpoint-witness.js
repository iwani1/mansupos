/**
 * Phase 3.3: Ed25519-signed checkpoint witness for an isolated synthetic
 * financial-evidence audit journal. OFFLINE CI ONLY. No merchant integration.
 *
 * The signer must be administered outside the journal's trust boundary in
 * production. This local simulator does NOT establish such independence:
 * even a valid signature can be rolled back with its witness file if both
 * locations are compromised. A trusted external high-watermark is required.
 *
 * No POS imports, network, API, settlement, payment, refund or stock methods.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

const F=fs.constants;
const ZERO='0'.repeat(64);
const HEX=/^[a-f0-9]{64}$/;
const DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const RECORD_KEYS=['kind','version','sequence','tag','previousReceiptHash','issuedAt','signature'];
const SIGNED_KEYS=RECORD_KEYS.slice(0,-1);
const MAX_BYTES=1024*1024;
const MAX_RECORDS=1000;
function refused() {
  return new Error('Synthetic checkpoint witness failed closed; independent integrity review required.');
}
function exactKeys(x,fields) {
  return !!x && typeof x==='object' && !Array.isArray(x) &&
    Object.keys(x).length===fields.length && fields.every(k=>Object.hasOwn(x,k));
}
function hash(x) {
  return createHash('sha256').update(x,'utf8').digest('hex');
}
function canonicalFields(row) {
  if (!exactKeys(row,RECORD_KEYS) || row.kind!=='mansu-synthetic-evidence-checkpoint' ||
      row.version!==1 || !Number.isSafeInteger(row.sequence) || row.sequence<1 ||
      !HEX.test(row.tag) || !HEX.test(row.previousReceiptHash) ||
      typeof row.issuedAt!=='string' || !DATE.test(row.issuedAt) ||
      !Number.isFinite(Date.parse(row.issuedAt)) ||
      typeof row.signature!=='string' || !/^[A-Za-z0-9_-]{86}$/.test(row.signature)) throw refused();
  return Object.fromEntries(SIGNED_KEYS.map(k=>[k,row[k]]));
}
function signedMessage(value) {
  return Buffer.from('mansupos-financial-evidence-checkpoint-v1\n'+JSON.stringify(value),'utf8');
}
function validPrivate(key) {
  return key?.type==='private' && key.asymmetricKeyType==='ed25519';
}
function validPublic(key) {
  return key?.type==='public' && key.asymmetricKeyType==='ed25519';
}
function checkedDirectory(dir) {
  if (typeof dir!=='string') throw refused();
  let real;
  try { real=fs.realpathSync(dir); } catch { throw refused(); }
  const root=fs.realpathSync(os.tmpdir());
  const stat=fs.statSync(real);
  if (!stat.isDirectory() || (stat.mode & 0o077)!==0 ||
      path.resolve(dir)!==real || path.dirname(real)!==root ||
      !path.basename(real).startsWith('mansu-evidence-witness-ci-')) throw refused();
  return real;
}
function checkedFile(fd) {
  const stat=fs.fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o077)!==0 || stat.size>MAX_BYTES) throw refused();
}
function readRecords(file,publicKey) {
  let fd;
  try { fd=fs.openSync(file,F.O_RDONLY | (F.O_NOFOLLOW || 0)); }
  catch (error) { if (error.code==='ENOENT') return []; throw refused(); }
  let text;
  try { checkedFile(fd); text=fs.readFileSync(fd,'utf8'); }
  catch { throw refused(); }
  finally { fs.closeSync(fd); }
  if (!text) return [];
  if (!text.endsWith('\n')) throw refused();
  const lines=text.slice(0,-1).split('\n');
  if (lines.length>MAX_RECORDS || lines.some(line=>!line || line.length>4096)) throw refused();
  const entries=[];
  let previousHash=ZERO;
  let previousSequence=0;
  let previousTime=0;
  for (const line of lines) {
    let row;
    try { row=JSON.parse(line); } catch { throw refused(); }
    const fields=canonicalFields(row);
    if (fields.sequence<=previousSequence || fields.previousReceiptHash!==previousHash ||
        Date.parse(fields.issuedAt)<previousTime) throw refused();
    let sig;
    try { sig=Buffer.from(row.signature,'base64url'); }
    catch { throw refused(); }
    if (sig.length!==64 || !verify(null,signedMessage(fields),publicKey,sig)) throw refused();
    const canonical={...fields,signature:row.signature};
    if (line!==JSON.stringify(canonical)) throw refused();
    previousHash=hash(JSON.stringify(canonical));
    previousSequence=fields.sequence;
    previousTime=Date.parse(fields.issuedAt);
    entries.push(canonical);
  }
  return entries;
}
function checkedHead(head) {
  if (!exactKeys(head,['sequence','tag']) || !Number.isSafeInteger(head.sequence) ||
      head.sequence<1 || !HEX.test(head.tag)) throw refused();
  return head;
}
function signatureEnvelope(receipt) {
  return Object.freeze({
    kind:'synthetic-signed-financial-evidence-checkpoint',
    sequence:receipt.sequence,tag:receipt.tag,
    signature:receipt.signature,issuedAt:receipt.issuedAt,
    externalCustodyVerified:false,bankSettlementVerified:false,
    refundAuthorized:false,stockRestored:false,checkoutAuthorized:false,
  });
}
function requireSynthetic(env) {
  if (env?.NODE_ENV!=='test' || env?.MANSU_CI_SYNTHETIC_EVIDENCE_WITNESS!=='true') throw refused();
}

export class SyntheticEvidenceCheckpointWitness {
  constructor({env,directory,privateKey}={}) {
    requireSynthetic(env);
    if (!validPrivate(privateKey)) throw refused();
    this.directory=checkedDirectory(directory);
    this.file=path.join(this.directory,'synthetic-signed-checkpoints.ndjson');
    this.lock=path.join(this.directory,'synthetic-signed-checkpoints.lock');
    this.privateKey=privateKey;
    this.publicKey=createPublicKey(privateKey);
  }
  append(head,{issuedAt}={}) {
    checkedHead(head);
    if (typeof issuedAt!=='string' || !DATE.test(issuedAt) ||
        !Number.isFinite(Date.parse(issuedAt))) throw refused();
    let lockFd;
    try { lockFd=fs.openSync(this.lock,F.O_CREAT | F.O_EXCL |
      F.O_WRONLY | (F.O_NOFOLLOW || 0),0o600); }
    catch { throw refused(); }
    try {
      const entries=readRecords(this.file,this.publicKey);
      const prior=entries.at(-1);
      if (prior && head.sequence===prior.sequence && head.tag===prior.tag) {
        return Object.freeze({created:false,receipt:signatureEnvelope(prior)});
      }
      if (prior && head.sequence<=prior.sequence) throw refused();
      if (prior && Date.parse(issuedAt)<Date.parse(prior.issuedAt)) throw refused();
      if (entries.length>=MAX_RECORDS) throw refused();
      const fields={
        kind:'mansu-synthetic-evidence-checkpoint',
        version:1,sequence:head.sequence,tag:head.tag,
        previousReceiptHash:prior?hash(JSON.stringify(prior)):ZERO,
        issuedAt,
      };
      const row={...fields,signature:sign(null,signedMessage(fields),this.privateKey).toString('base64url')};
      const line=JSON.stringify(row)+'\n';
      let fd;
      try {
        fd=fs.openSync(this.file,F.O_WRONLY | F.O_CREAT | F.O_APPEND | (F.O_NOFOLLOW || 0),0o600);
        checkedFile(fd);
        if (fs.fstatSync(fd).size+Buffer.byteLength(line)>MAX_BYTES) throw refused();
        const written=fs.writeSync(fd,line,null,'utf8');
        if (written!==Buffer.byteLength(line)) throw refused();
        fs.fsyncSync(fd);
      } finally { if (fd!==undefined) fs.closeSync(fd); }
      return Object.freeze({created:true,receipt:signatureEnvelope(row)});
    } finally {
      fs.closeSync(lockFd);
      fs.unlinkSync(this.lock);
    }
  }
}

/**
 * Uses a separately supplied, pinned Ed25519 PUBLIC key, not a private signer
 * key. The test directory may be different from journal storage. Does NOT
 * prove that the public key was obtained via a trusted independent channel.
 *
 * An intact journal longer than the latest signed head is NOT fully anchored,
 * and fails closed. A journal rolled back behind that head also fails closed.
 */
export function verifySyntheticWitnessAgainstJournal({env,witnessDirectory,publicKey,journal}={}) {
  requireSynthetic(env);
  if (!validPublic(publicKey) ||
      !journal || typeof journal.verify!=='function' ||
      witnessDirectory===journal.directory) throw refused();
  const directory=checkedDirectory(witnessDirectory);
  const file=path.join(directory,'synthetic-signed-checkpoints.ndjson');
  const receipts=readRecords(file,publicKey);
  const last=receipts.at(-1);
  if (!last) throw refused();
  // The original journal must recompute its HMAC chain, and its current
  // entire head must equal the latest independently signed checkpoint.
  const check=journal.verify({expectedHead:{sequence:last.sequence,tag:last.tag}});
  if (!check.localHmacChainValid || check.recordCount!==last.sequence) throw refused();
  return Object.freeze({
    kind:'synthetic-signed-checkpoint-comparison',
    signedHeadMatchesJournal:true,
    witnessSignatureChainValid:true,
    signedCheckpointCount:receipts.length,
    journalRecordCount:check.recordCount,
    pinnedPublicKeyProvided:true,
    publicKeyIndependentProvenanceVerified:false,
    remoteWitnessCustodyVerified:false,
    rollbackProtectionProductionVerified:false,
    bankFundsVerified:false,refundAuthorized:false,
    stockRestored:false,checkoutAuthorized:false,
    notice:'Signed local checkpoint matched all current journal records. Neither trusted witness custody nor independent public-key provenance is established in this CI simulator.',
  });
}

// No module side effects, network listeners, production signer, key export,
// POS endpoint, Paystack/Woo credentials, refund execution or storage mutation.
