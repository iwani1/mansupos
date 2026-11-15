/**
 * Phase 3.4: OFFLINE separated-audit-custody protocol simulator.
 *
 * Demonstrates an independent HIGH-WATERMARK authority using a distinct
 * Ed25519 key. This fixture is IN MEMORY ON THE SAME CI HOST, not an
 * independently administered, durable remote witness. No live credentials,
 * network clients, POS integration, merchant data, refunds or stock actions.
 *
 * Never use this class for a production custody, settlement or release claim.
 */
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const WITNESS_KEYS=[
  'kind','version','sequence','tag','previousReceiptHash','issuedAt','signature',
];
const ANCHOR_KEYS=[
  'kind','version','siteId','sequence','tag','witnessReceiptDigest',
  'previousAnchorDigest','issuedAt','signature',
];
const ZERO='0'.repeat(64);
const MAX_RECEIPTS=1000;
function refused() {
  return new Error('Synthetic external-anchor custody check failed closed; manual audit review required.');
}
function keysAre(input, fields) {
  return input!==null && typeof input==='object' && !Array.isArray(input) &&
    Object.keys(input).length===fields.length &&
    fields.every(k=>Object.hasOwn(input,k));
}
function sha(x) {
  return createHash('sha256').update(x,'utf8').digest('hex');
}
function okDate(time) {
  return typeof time==='string' && DATE.test(time) && Number.isFinite(Date.parse(time));
}
function validPublic(key) {
  return key?.type==='public' && key.asymmetricKeyType==='ed25519';
}
function validPrivate(key) {
  return key?.type==='private' && key.asymmetricKeyType==='ed25519';
}
function validateSig(value) {
  return typeof value==='string' &&
    /^[a-zA-Z0-9_-]{86}$/.test(value) &&
    Buffer.from(value,'base64url').length===64;
}
function canonical(row, keys) {
  return Object.fromEntries(keys.map(k=>[k,row[k]]));
}
function signedMessage(domain, fields) {
  return Buffer.from(domain+'\n'+JSON.stringify(fields),'utf8');
}
function guardEnv(env) {
  if (env?.NODE_ENV!=='test' ||
      env?.MANSU_CI_SYNTHETIC_EXTERNAL_ANCHOR!=='true') throw refused();
}
function witnessReceipt(value,pinnedPublicKey) {
  if (!keysAre(value,WITNESS_KEYS) ||
      value.kind!=='mansu-synthetic-evidence-checkpoint' ||
      value.version!==1 ||
      !Number.isSafeInteger(value.sequence) || value.sequence<1 ||
      !SHA.test(value.tag) || !SHA.test(value.previousReceiptHash) ||
      !okDate(value.issuedAt) || !validateSig(value.signature)) throw refused();
  const signed=canonical(value,WITNESS_KEYS.slice(0,-1));
  if (!verify(null,
      signedMessage('mansupos-financial-evidence-checkpoint-v1',signed),
      pinnedPublicKey,Buffer.from(value.signature,'base64url'))) throw refused();
  return Object.freeze({...signed,signature:value.signature});
}
function anchorReceipt(value,pinnedCustodianKey) {
  if (!keysAre(value,ANCHOR_KEYS) ||
      value.kind!=='mansu-synthetic-separated-anchor' ||
      value.version!==1 || !UUID.test(value.siteId) ||
      !Number.isSafeInteger(value.sequence) || value.sequence<1 ||
      !SHA.test(value.tag) || !SHA.test(value.witnessReceiptDigest) ||
      !SHA.test(value.previousAnchorDigest) ||
      !okDate(value.issuedAt) || !validateSig(value.signature)) throw refused();
  const fields=canonical(value,ANCHOR_KEYS.slice(0,-1));
  if (!verify(null,signedMessage('mansupos-separated-anchor-v1',fields),
      pinnedCustodianKey,Buffer.from(value.signature,'base64url'))) throw refused();
  return Object.freeze({...fields,signature:value.signature});
}
function compareHead(journal,head) {
  if (!journal || typeof journal.verify!=='function') throw refused();
  const local=journal.verify({expectedHead:{
    sequence:head.sequence,tag:head.tag,
  }});
  if (local.localHmacChainValid!==true ||
      local.recordCount!==head.sequence) throw refused();
}
function checkResult(kind, passed, code, count=0) {
  return Object.freeze({
    kind,
    status:passed?'local_protocol_consistent':'blocked_manual_investigation',
    alertCodes:passed?[]:[code],
    severity:passed?'none':'critical',
    lastAnchoredSequence:count,
    checkoutAuthorized:false,refundAuthorized:false,
    payoutVerified:false,stockRestoreAuthorized:false,
    recoveryPerformed:false,independentExternalCustodyVerified:false,
    publicKeyTrustRootIndependentlyVerified:false,
    productionRollbackProtectionVerified:false,
    bankSettlementVerified:false,
    needsOwnerSecurityReview:!passed,
    notice:passed
      ? 'Synthetic signed checkpoint matches journal and in-memory watermark. Real remote custody and merchant settlement remain unverified.'
      : 'Evidence integrity/availability could not be established. Do not repair, pay, refund, fulfil, or restock automatically.',
  });
}

export class SyntheticSeparatedAuditAnchorCustodian {
  #anchors=[];
  #available=true;
  constructor({env,witnessPublicKey,custodianPrivateKey,siteId}={}) {
    guardEnv(env);
    if (!validPublic(witnessPublicKey) || !validPrivate(custodianPrivateKey) ||
        !UUID.test(siteId || '')) throw refused();
    const custodianPublicKey=createPublicKey(custodianPrivateKey);
    const witnessDer=witnessPublicKey.export({type:'spki',format:'der'});
    const custodianDer=custodianPublicKey.export({type:'spki',format:'der'});
    if (witnessDer.equals(custodianDer)) throw refused();
    this.witnessPublicKey=witnessPublicKey;
    this.custodianPublicKey=custodianPublicKey;
    this.custodianPrivateKey=custodianPrivateKey;
    this.siteId=siteId.toLowerCase();
  }
  // Simulates an unavailable external service, not an actual network call.
  setSimulatedAvailability(available) {
    if (available!==true && available!==false) throw refused();
    this.#available=available;
  }
  #inspectChain() {
    let prior=ZERO,seq=0,time=0;
    for (const row of this.#anchors) {
      const valid=anchorReceipt(row,this.custodianPublicKey);
      if (valid.siteId!==this.siteId || valid.previousAnchorDigest!==prior ||
          valid.sequence<=seq || Date.parse(valid.issuedAt)<time) throw refused();
      prior=sha(JSON.stringify(valid));
      seq=valid.sequence;
      time=Date.parse(valid.issuedAt);
    }
    return this.#anchors.at(-1) || null;
  }
  /**
   * The "external" durable sink is intentionally replaced by a private
   * IN-MEMORY synthetic store. The journal is fully checked before anchoring.
   * No unsafe caller-provided decision/status can authorize a release.
   */
  publish({journal,witness,issuedAt}={}) {
    if (!this.#available || !okDate(issuedAt)) throw refused();
    const signed=witnessReceipt(witness,this.witnessPublicKey);
    compareHead(journal,signed);
    const prior=this.#inspectChain();
    const digest=sha(JSON.stringify(signed));
    if (prior && prior.sequence===signed.sequence &&
        prior.tag===signed.tag &&
        prior.witnessReceiptDigest===digest) {
      return Object.freeze({created:false,receipt:prior});
    }
    if (prior && (signed.sequence<=prior.sequence ||
        Date.parse(issuedAt)<Date.parse(prior.issuedAt))) throw refused();
    if (this.#anchors.length>=MAX_RECEIPTS) throw refused();
    const fields={
      kind:'mansu-synthetic-separated-anchor',version:1,
      siteId:this.siteId,sequence:signed.sequence,tag:signed.tag,
      witnessReceiptDigest:digest,
      previousAnchorDigest:prior?sha(JSON.stringify(prior)):ZERO,
      issuedAt,
    };
    const row=Object.freeze({...fields,
      signature:sign(null,signedMessage('mansupos-separated-anchor-v1',fields),
        this.custodianPrivateKey).toString('base64url')});
    this.#anchors.push(row);
    return Object.freeze({created:true,receipt:row});
  }
  // Does not inspect any PIN/POS payment customer data or store raw refs.
  check({journal,witness,pinnedLatestAnchor}={}) {
    if (!this.#available) {
      return checkResult('synthetic-separated-audit-health',false,
        'WITNESS_UNAVAILABLE',this.#anchors.at(-1)?.sequence || 0);
    }
    try {
      const latest=this.#inspectChain();
      if (!latest) throw refused();
      const observed=witnessReceipt(witness,this.witnessPublicKey);
      if (latest.sequence!==observed.sequence ||
          latest.tag!==observed.tag ||
          latest.witnessReceiptDigest!==sha(JSON.stringify(observed))) throw refused();
      if (pinnedLatestAnchor!==undefined) {
        const pinned=anchorReceipt(pinnedLatestAnchor,this.custodianPublicKey);
        if (JSON.stringify(pinned)!==JSON.stringify(latest)) throw refused();
      }
      compareHead(journal,latest);
      return checkResult('synthetic-separated-audit-health',true,'',latest.sequence);
    } catch {
      return checkResult('synthetic-separated-audit-health',false,
        'AUDIT_ANCHOR_OR_JOURNAL_DIVERGENCE',this.#anchors.at(-1)?.sequence || 0);
    }
  }
  /**
   * READ-ONLY restoration candidate gate. Never edits or restores a file.
   * A matching candidate still requires independent Owner security review.
   */
  assessRecoveryCandidate({candidateJournal,witness,pinnedLatestAnchor}={}) {
    const health=this.check({
      journal:candidateJournal,witness,pinnedLatestAnchor,
    });
    return Object.freeze({
      ...health,
      kind:'synthetic-audit-recovery-candidate-assessment',
      candidateMatchesLocalSimulatedAnchor:health.status==='local_protocol_consistent',
      candidateApprovedForProductionRestore:false,
      manualOwnerSecuritySignoffRequired:true,
      recoveryPerformed:false,
      journalWritten:false,
    });
  }
}

// No filesystem writes, credentials, Express routes, scheduled checks,
// merchant Woo/Paystack connections, checkout changes or real witness service.
