/**
 * Phase 3.7 — separately signed incident ticket and notification CLAIMS.
 * Pure CI-only acceptance fixture, not email/SMS/WhatsApp/push delivery.
 * Even a signed "delivered" claim CANNOT independently verify Owner receipt.
 */
import { createHash, sign, verify } from 'node:crypto';
const HEX=/^[0-9a-f]{64}$/;
const B64=/^[A-Za-z0-9_-]{86}$/;
const DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const CODES=new Set([
  'ACKNOWLEDGEMENT_UNKNOWN','EXTERNAL_WITNESS_UNAVAILABLE',
  'EXTERNAL_ANCHOR_MISMATCH','LOCAL_EVIDENCE_INVALID',
  'DURABLE_CUSTODY_OR_WITNESS_DIVERGENCE',
]);
const TICKET=['kind','version','incidentId','code','status','issuedAt','signature'];
const CLAIM=['kind','version','incidentId','ticketDigest','recipientRole','deliveryStatus','issuedAt','signature'];
const DOMAIN_TICKET='mansupos-synthetic-incident-ticket-v1\n';
const DOMAIN_CLAIM='mansupos-synthetic-notification-claim-v1\n';
function denied(){return new Error('Synthetic incident delivery evidence refused; manual security escalation required.');}
function exact(x,keys){return !!x && typeof x==='object' && !Array.isArray(x) &&
  Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));}
function validTime(x){return typeof x==='string' && DATE.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(x).toISOString()===x;}
function validSig(x){return typeof x==='string' && B64.test(x) &&
  Buffer.from(x,'base64url').length===64;}
function pub(k){return k?.type==='public' && k.asymmetricKeyType==='ed25519';}
function priv(k){return k?.type==='private' && k.asymmetricKeyType==='ed25519';}
function hash(s){return createHash('sha256').update(s,'utf8').digest('hex');}
function guard(env){if(env?.NODE_ENV!=='test' ||
  env?.MANSU_CI_SYNTHETIC_INCIDENT_DELIVERY!=='true')throw denied();}
function signedPayload(item,keys){return Object.fromEntries(keys.slice(0,-1).map(k=>[k,item[k]]));}
function checkTicket(t){
  if (!exact(t,TICKET) || t.kind!=='mansu-synthetic-incident-ticket' ||
    t.version!==1 || !HEX.test(t.incidentId) || !CODES.has(t.code) ||
    t.status!=='recorded' || !validTime(t.issuedAt) || !validSig(t.signature))throw denied();
}
function checkClaim(c){
  if (!exact(c,CLAIM) || c.kind!=='mansu-synthetic-alert-delivery-claim' ||
    c.version!==1 || !HEX.test(c.incidentId) || !HEX.test(c.ticketDigest) ||
    c.recipientRole!=='owner' ||
    !['delivered','failed','pending'].includes(c.deliveryStatus) ||
    !validTime(c.issuedAt) || !validSig(c.signature))throw denied();
}
function signRecord(record,keys,privateKey,domain){
  if (!priv(privateKey))throw denied();
  return Object.freeze({...record,signature:sign(null,
    Buffer.from(domain+JSON.stringify(record)),privateKey).toString('base64url')});
}
function verifyRecord(record,keys,publicKey,domain){
  if(!pub(publicKey))throw denied();
  const fields=signedPayload(record,keys);
  if(!verify(null,Buffer.from(domain+JSON.stringify(fields)),
    publicKey,Buffer.from(record.signature,'base64url')))throw denied();
}
export function signSyntheticIncidentTicket({env,incidentId,code,issuedAt,privateKey}={}){
  guard(env);
  const fields={kind:'mansu-synthetic-incident-ticket',version:1,
    incidentId,code,status:'recorded',issuedAt};
  checkTicket({...fields,signature:'A'.repeat(86)});
  return signRecord(fields,TICKET,privateKey,DOMAIN_TICKET);
}
export function signSyntheticAlertDeliveryClaim({
  env,ticket,recipientRole,deliveryStatus,issuedAt,privateKey,
}={}){
  guard(env);
  checkTicket(ticket);
  const fields={kind:'mansu-synthetic-alert-delivery-claim',version:1,
    incidentId:ticket.incidentId,ticketDigest:hash(JSON.stringify(ticket)),
    recipientRole,deliveryStatus,issuedAt};
  checkClaim({...fields,signature:'A'.repeat(86)});
  return signRecord(fields,CLAIM,privateKey,DOMAIN_CLAIM);
}
export function assessSyntheticIncidentAlertDelivery({
  env,ticket,claim,pinnedTicketPublicKey,pinnedNotifierPublicKey,now,
}={}){
  guard(env);
  checkTicket(ticket);
  checkClaim(claim);
  if (!validTime(now) || !pub(pinnedTicketPublicKey) || !pub(pinnedNotifierPublicKey) ||
    pinnedTicketPublicKey.export({format:'der',type:'spki'}).equals(
      pinnedNotifierPublicKey.export({format:'der',type:'spki'})))throw denied();
  verifyRecord(ticket,TICKET,pinnedTicketPublicKey,DOMAIN_TICKET);
  verifyRecord(claim,CLAIM,pinnedNotifierPublicKey,DOMAIN_CLAIM);
  if (claim.incidentId!==ticket.incidentId ||
    claim.ticketDigest!==hash(JSON.stringify(ticket)))throw denied();
  const issued=Date.parse(ticket.issuedAt);
  const claimed=Date.parse(claim.issuedAt);
  const current=Date.parse(now);
  const chronological=issued<=claimed && claimed<=current &&
    current-issued<=7*24*60*60*1000;
  const mockClaimSaysDelivered=claim.deliveryStatus==='delivered' && chronological;
  return Object.freeze({
    kind:'synthetic-incident-notification-evidence',
    ticketSignatureValid:true,notifierSignatureValid:true,
    ticketBoundToClaim:true,chronological,
    syntheticDeliveredClaimMatches:mockClaimSaysDelivered,
    status:mockClaimSaysDelivered ?
      'synthetic_claim_consistent_not_authentic_delivery':
      'blocked_missing_or_unconfirmed_notification',
    // A ticket or signature is NOT independently verified delivery.
    externalTicketDurabilityVerified:false,
    recipientIdentityIndependentlyVerified:false,
    realOwnerReceivedAlert:false,
    independentlyVerifiedDeliveryReceipt:false,
    productionAlertServiceConnected:false,
    automaticIncidentClosureAuthorized:false,
    customerPayoutAuthorized:false,checkoutAuthorized:false,
    refundAuthorized:false,stockRestored:false,
    notice:'These cryptographic signatures authenticate synthetic claim bytes, not a real provider, delivery endpoint, or the Owner receiving an alert.',
  });
}
// No POS import, provider SDK, network, mailbox, notification send, bank,
// WooCommerce order edit, Paystack transaction or production activation.
