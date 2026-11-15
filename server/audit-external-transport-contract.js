/**
 * Phase 3.5: provider-neutral EXTERNAL AUDIT protocol contract, exercised
 * ONLY by an IN-MEMORY SYNTHETIC transport and local temporary CI journals.
 *
 * No production endpoint, DNS, HTTP, POS app integration, recurring task,
 * real merchant credential, payment, refund, stock or actual alert delivery.
 * This protocol models separate append/query/health/incident operations and
 * explicitly treats unknown acknowledgements as unresolved, NEVER success.
 */
import { createHash, verify } from 'node:crypto';
import {
  latestSyntheticSignedWitnessReceipt,
  verifySyntheticWitnessAgainstJournal,
} from './evidence-checkpoint-witness.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX=/^[a-f0-9]{64}$/;
const B64=/^[A-Za-z0-9_-]{86}$/;
const DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const RECEIPT_FIELDS=[
  'kind','version','siteId','sequence','tag','witnessReceiptDigest',
  'previousAnchorDigest','issuedAt','signature',
];
const ALERT_CODES=new Set([
  'ACKNOWLEDGEMENT_UNKNOWN','EXTERNAL_WITNESS_UNAVAILABLE',
  'EXTERNAL_ANCHOR_MISMATCH','LOCAL_EVIDENCE_INVALID',
]);
function refused() {
  return new Error('Synthetic audit transport refused an unsafe operation; manual security review required.');
}
function guard(env) {
  if (env?.NODE_ENV!=='test' ||
      env?.MANSU_CI_SYNTHETIC_EXTERNAL_AUDIT_TRANSPORT!=='true' ||
      env?.MANSU_CI_SYNTHETIC_EVIDENCE_WITNESS!=='true') throw refused();
}
const sha=v=>createHash('sha256').update(v,'utf8').digest('hex');
function safeDate(v) {return typeof v==='string' && DATE.test(v) && Number.isFinite(Date.parse(v));}
function fieldsExactly(o,keys) {
  return o!==null && typeof o==='object' && !Array.isArray(o) &&
    Object.keys(o).length===keys.length && keys.every(key=>Object.hasOwn(o,key));
}
function safePublic(k) {
  return k?.type==='public' && k.asymmetricKeyType==='ed25519';
}
function validateAnchor(anchor,publicKey,siteId) {
  if (!safePublic(publicKey) || !fieldsExactly(anchor,RECEIPT_FIELDS) ||
      anchor.kind!=='mansu-synthetic-separated-anchor' ||
      anchor.version!==1 || anchor.siteId!==siteId ||
      !Number.isSafeInteger(anchor.sequence) || anchor.sequence<1 ||
      !HEX.test(anchor.tag) || !HEX.test(anchor.witnessReceiptDigest) ||
      !HEX.test(anchor.previousAnchorDigest) || !safeDate(anchor.issuedAt) ||
      typeof anchor.signature!=='string' || !B64.test(anchor.signature)) throw refused();
  const {signature,...fields}=anchor;
  if (Buffer.from(signature,'base64url').length!==64 ||
      !verify(null,Buffer.from('mansupos-separated-anchor-v1\n'+JSON.stringify(fields)),
        publicKey,Buffer.from(signature,'base64url'))) throw refused();
  return anchor;
}
function noFinance(kind,status,more={}) {
  return Object.freeze({
    kind,status,...more,
    independentExternalCustodyVerified:false,
    durableOffHostRetentionVerified:false,
    independentAlertDeliveryVerified:false,
    merchantBankSettlementVerified:false,
    customerRefundExecuted:false,refundAuthorized:false,
    payoutVerified:false,stockRestored:false,
    checkoutAuthorized:false,recoveryPerformed:false,
    financialWritesEnabled:false,
  });
}
function compareExpected(anchor,witness,key,siteId) {
  const a=validateAnchor(anchor,key,siteId);
  if (a.sequence!==witness.sequence || a.tag!==witness.tag ||
      a.witnessReceiptDigest!==sha(JSON.stringify(witness))) throw refused();
  return a;
}
function incKey(operationId,code) {return sha('mansu-synthetic-incident-v1:'+operationId+':'+code);}
function incidentShape(operationId,code) {
  if (!UUID.test(operationId) || !ALERT_CODES.has(code)) throw refused();
  return Object.freeze({
    kind:'synthetic-audit-integrity-incident',version:1,
    id:incKey(operationId,code),code,severity:'critical',
    requiresOwnerSecurityReview:true,
    automatedRecoveryPermitted:false,financialOperationsAllowed:false,
  });
}
/**
 * The "provider" is a same-process fake and is never used as an actual
 * third-party object store, queue, pager or bank service.
 */
export class SyntheticAuditTransportFixture {
  #operations=new Map();
  #incidents=new Map();
  #latest=null;
  #available=true;
  #oneShot=null;
  constructor({env,custodian,siteId}={}) {
    guard(env);
    if (!custodian || typeof custodian.publish!=='function' ||
        typeof custodian.check!=='function' || !UUID.test(siteId||'')) throw refused();
    this.custodian=custodian;
    this.siteId=siteId.toLowerCase();
  }
  setAvailable(value) {
    if (value!==true && value!==false) throw refused();
    this.#available=value;
  }
  failNext(stage) {
    if (![
      'before_publish','after_publish','lookup','latest',
      'before_incident','after_incident',
    ].includes(stage)) throw refused();
    this.#oneShot=stage;
  }
  #fault(stage) {
    if (!this.#available) throw refused();
    if (this.#oneShot===stage) {
      this.#oneShot=null;
      throw refused();
    }
  }
  async publishCheckpoint({operationId,journal,witness,issuedAt}={}) {
    this.#fault('before_publish');
    if (!UUID.test(operationId) || !safeDate(issuedAt)) throw refused();
    const fingerprint=sha(JSON.stringify(witness));
    const existing=this.#operations.get(operationId);
    if (existing) {
      if (existing.witnessFingerprint!==fingerprint) throw refused();
      return Object.freeze({...existing});
    }
    const submitted=this.custodian.publish({journal,witness,issuedAt});
    const result=Object.freeze({
      operationId,witnessFingerprint:fingerprint,receipt:submitted.receipt,
    });
    if (submitted.receipt.siteId!==this.siteId) throw refused();
    this.#operations.set(operationId,result);
    this.#latest=submitted.receipt;
    this.#fault('after_publish');
    return result;
  }
  async findCheckpoint(operationId) {
    this.#fault('lookup');
    if (!UUID.test(operationId)) throw refused();
    return this.#operations.get(operationId) || null;
  }
  async latestCheckpoint() {
    this.#fault('latest');
    return this.#latest;
  }
  async recordIncident(event) {
    this.#fault('before_incident');
    if (!event || !fieldsExactly(event,[
      'kind','version','id','code','severity',
      'requiresOwnerSecurityReview','automatedRecoveryPermitted','financialOperationsAllowed',
    ]) || !HEX.test(event.id) || !ALERT_CODES.has(event.code) ||
        event.kind!=='synthetic-audit-integrity-incident' ||
        event.version!==1 || event.severity!=='critical' ||
        event.requiresOwnerSecurityReview!==true ||
        event.automatedRecoveryPermitted!==false ||
        event.financialOperationsAllowed!==false) throw refused();
    const previous=this.#incidents.get(event.id);
    if (previous && JSON.stringify(previous)!==JSON.stringify(event)) throw refused();
    this.#incidents.set(event.id,Object.freeze({...event}));
    this.#fault('after_incident');
    return Object.freeze({fixtureRecorded:true,incidentId:event.id});
  }
  async findIncident(id) {
    if (!this.#available || !HEX.test(id)) throw refused();
    return this.#incidents.get(id) || null;
  }
  // Fixture introspection ONLY: intentionally not a remote transport API.
  fixtureCounts() {
    return Object.freeze({checkpoints:this.#operations.size,incidents:this.#incidents.size});
  }
}
/**
 * Validates signed receipts and remote high watermark using separately pinned
 * public keys. A fake fixture can be reinitialized and lose everything; the
 * client never claims this to be durable or independently administered.
 */
export class SyntheticAuditExternalProtocol {
  constructor({env,transport,siteId,witnessPublicKey,custodianPublicKey,
    witnessDirectory}={}) {
    guard(env);
    if (!(transport instanceof SyntheticAuditTransportFixture) ||
        !UUID.test(siteId||'') || !safePublic(witnessPublicKey) ||
        !safePublic(custodianPublicKey) ||
        typeof witnessDirectory!=='string' ||
        transport.siteId!==siteId.toLowerCase()) throw refused();
    this.env=env;
    this.transport=transport;
    this.siteId=siteId.toLowerCase();
    this.witnessPublicKey=witnessPublicKey;
    this.custodianPublicKey=custodianPublicKey;
    this.witnessDirectory=witnessDirectory;
  }
  #localWitness(journal) {
    const witness=latestSyntheticSignedWitnessReceipt({
      env:this.env,witnessDirectory:this.witnessDirectory,
      publicKey:this.witnessPublicKey,
    });
    const state=verifySyntheticWitnessAgainstJournal({
      env:this.env,witnessDirectory:this.witnessDirectory,
      publicKey:this.witnessPublicKey,journal,
    });
    if (!state.signedHeadMatchesJournal) throw refused();
    return witness;
  }
  async #blocked(operationId,code) {
    const alert=incidentShape(operationId,code);
    let incidentRecording='unconfirmed';
    try {
      await this.transport.recordIncident(alert);
      const lookup=await this.transport.findIncident(alert.id);
      if (lookup && JSON.stringify(lookup)===JSON.stringify(alert)) {
        incidentRecording='synthetic_fixture_recorded';
      }
    } catch {
      try {
        const lookup=await this.transport.findIncident(alert.id);
        if (lookup && JSON.stringify(lookup)===JSON.stringify(alert)) {
          incidentRecording='synthetic_fixture_recorded';
        }
      } catch { /* Delivery and record state remain uncertain */ }
    }
    return noFinance('synthetic-external-audit-protocol',
      'blocked_manual_investigation',{
        issueCode:code,severity:'critical',needsOwnerSecurityReview:true,
        incidentId:alert.id,incidentRecording,
        notice:'Synthetic audit evidence or acknowledgment was uncertain. No retry, release, auto-repair, payment, refund or stock restoration was performed.',
      });
  }
  async submit({operationId,journal,issuedAt}={}) {
    if (!UUID.test(operationId) || !safeDate(issuedAt)) throw refused();
    let witness;
    try { witness=this.#localWitness(journal); }
    catch {return this.#blocked(operationId,'LOCAL_EVIDENCE_INVALID');}
    let existing;
    try {
      existing=await this.transport.findCheckpoint(operationId);
    } catch {
      return this.#blocked(operationId,'EXTERNAL_WITNESS_UNAVAILABLE');
    }
    if (existing && existing.witnessFingerprint!==sha(JSON.stringify(witness))) {
      return this.#blocked(operationId,'EXTERNAL_ANCHOR_MISMATCH');
    }
    if (!existing) {
      let latest;
      try {latest=await this.transport.latestCheckpoint();}
      catch {return this.#blocked(operationId,'EXTERNAL_WITNESS_UNAVAILABLE');}
      if (latest && (!Number.isSafeInteger(latest.sequence) ||
          latest.sequence>=witness.sequence)) {
        return this.#blocked(operationId,'EXTERNAL_ANCHOR_MISMATCH');
      }
      try {
        existing=await this.transport.publishCheckpoint({
          operationId,journal,witness,issuedAt,
        });
      } catch {
        // After a lost response, first inquire using the SAME operation id.
        // If the query is unavailable or the operation was not committed,
        // mark it unresolved; do NOT automatically create another checkpoint.
        try {existing=await this.transport.findCheckpoint(operationId);}
        catch {return this.#blocked(operationId,'ACKNOWLEDGEMENT_UNKNOWN');}
        if (!existing) return this.#blocked(operationId,'ACKNOWLEDGEMENT_UNKNOWN');
      }
    }
    try {
      if (existing.operationId!==operationId ||
          existing.witnessFingerprint!==sha(JSON.stringify(witness))) throw refused();
      const ack=compareExpected(existing.receipt,witness,
        this.custodianPublicKey,this.siteId);
      const latest=await this.transport.latestCheckpoint();
      if (!latest || JSON.stringify(
        validateAnchor(latest,this.custodianPublicKey,this.siteId))!==
        JSON.stringify(ack)) throw refused();
      return noFinance('synthetic-external-audit-protocol','fixture_receipt_consistent',{
        operationId,anchoredSequence:ack.sequence,
        syntheticReceiptAcknowledged:true,
        needsOwnerSecurityReview:false,
        notice:'A signed synthetic fixture receipt matches the local audit chain. External durability, alert delivery and authentic custody remain unverified.',
      });
    } catch {
      return this.#blocked(operationId,'EXTERNAL_ANCHOR_MISMATCH');
    }
  }
  async inspect({operationId,journal}={}) {
    if (!UUID.test(operationId)) throw refused();
    let witness;
    try {witness=this.#localWitness(journal);}
    catch {return this.#blocked(operationId,'LOCAL_EVIDENCE_INVALID');}
    try {
      const latest=await this.transport.latestCheckpoint();
      compareExpected(latest,witness,this.custodianPublicKey,this.siteId);
      return noFinance('synthetic-external-audit-health','fixture_receipt_consistent',{
        anchoredSequence:latest.sequence,needsOwnerSecurityReview:false,
        notice:'Local journal matches synthetic fixture checkpoint only; no independent external custody was verified.',
      });
    } catch {
      return this.#blocked(operationId,'EXTERNAL_ANCHOR_MISMATCH');
    }
  }
  async assessRecovery({operationId,candidateJournal}={}) {
    const report=await this.inspect({operationId,journal:candidateJournal});
    return Object.freeze({
      ...report,kind:'synthetic-external-audit-recovery',
      candidateMatchesSyntheticAnchor:report.status==='fixture_receipt_consistent',
      ownerAndIndependentReviewerApprovalRequired:true,
      productionRestoreApproved:false,
      recoveryPerformed:false,journalWritten:false,
    });
  }
}

// No real provider SDK, outbound request, owner messaging, secrets, worker,
// file restoration, WooCommerce, Paystack or Contabo integration.
