/**
 * Phase 3.6 — OFFLINE ONLY: signed acceptance matrix for an eventual
 * independently administered financial-audit provider and incident service.
 *
 * This is a TEST FIXTURE contract, not a provider connection, permission
 * grant, external audit attestation, or production deployment gate.
 * Even a perfectly completed synthetic matrix NEVER permits live operations.
 */
import { createHash, sign, timingSafeEqual, verify } from 'node:crypto';

export const AUDIT_PROVIDER_CONTROLS=Object.freeze([
  'off_host_separate_custodian',
  'immutable_retention_and_legal_hold',
  'monotonic_remote_checkpoint',
  'independent_pinned_public_key',
  'least_privilege_append_and_query',
  'authenticated_signed_acknowledgement',
  'durable_critical_incident_ticket',
  'independently_confirmed_owner_alert',
  'incident_escalation_and_acknowledgement',
  'key_rotation_revocation_and_break_glass',
  'private_data_retention_and_access_review',
  'isolated_backup_and_manual_restore',
]);
export const AUDIT_PROVIDER_DRILLS=Object.freeze([
  'lost_ack_before_commit',
  'lost_ack_after_commit',
  'replay_and_conflicting_receipt',
  'dual_local_file_rollback',
  'external_provider_unavailable',
  'alert_delivery_unconfirmed',
  'signing_key_revoked',
  'disaster_restore_owner_plus_security',
]);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const SIG=/^[A-Za-z0-9_-]{86}$/;
const STATUS=new Set(['passed_in_fixture','failed','not_tested']);
const DOMAIN='mansupos-synthetic-audit-provider-readiness-v1\n';
const MAX_AGE=7*24*60*60*1000;
const FIELDS=['kind','version','environment','siteId','reviewId','reviewedAt',
  'controls','drills'];
const ROW=['code','status','evidenceId'];
const ENDORSEMENT=['role','reviewId','signature'];

function refused() {
  return new Error('Synthetic audit provider acceptance rejected; independent security review required.');
}
function keysAre(o,keys) {
  return o!==null && typeof o==='object' && !Array.isArray(o) &&
    Object.keys(o).length===keys.length && keys.every(k=>Object.hasOwn(o,k));
}
function timestamp(x) {
  return typeof x==='string' && DATE.test(x) && Number.isFinite(Date.parse(x)) &&
    new Date(x).toISOString()===x;
}
function guard(env) {
  if (env?.NODE_ENV!=='test' ||
      env?.MANSU_CI_SYNTHETIC_AUDIT_PROVIDER_ACCEPTANCE!=='true') throw refused();
}
function validKey(key,type) {
  return key?.type===type && key.asymmetricKeyType==='ed25519';
}
function differentKeys(a,b) {
  const ad=a.export({type:'spki',format:'der'});
  const bd=b.export({type:'spki',format:'der'});
  return ad.length!==bd.length || !timingSafeEqual(ad,bd);
}
function normalizedRows(rows,codes) {
  if (!Array.isArray(rows) || rows.length!==codes.length) throw refused();
  const byCode=new Map();
  for (const item of rows) {
    if (!keysAre(item,ROW) || !codes.includes(item.code) ||
        !STATUS.has(item.status) ||
        (item.status==='not_tested' ? item.evidenceId!==null :
          !UUID.test(item.evidenceId || '')) ||
        byCode.has(item.code)) throw refused();
    byCode.set(item.code,Object.freeze({...item}));
  }
  if (!codes.every(code=>byCode.has(code))) throw refused();
  return Object.freeze(codes.map(code=>byCode.get(code)));
}
function parseManifest(manifest) {
  if (!keysAre(manifest,FIELDS) ||
      manifest.kind!=='synthetic-audit-provider-acceptance-matrix' ||
      manifest.version!==1 || manifest.environment!=='synthetic_fixture' ||
      !UUID.test(manifest.siteId || '') || !UUID.test(manifest.reviewId || '') ||
      !timestamp(manifest.reviewedAt)) throw refused();
  return Object.freeze({
    kind:manifest.kind,version:1,environment:'synthetic_fixture',
    siteId:manifest.siteId.toLowerCase(),reviewId:manifest.reviewId.toLowerCase(),
    reviewedAt:manifest.reviewedAt,
    controls:normalizedRows(manifest.controls,AUDIT_PROVIDER_CONTROLS),
    drills:normalizedRows(manifest.drills,AUDIT_PROVIDER_DRILLS),
  });
}
function canonicalMessage(role,manifest) {
  return Buffer.from(DOMAIN+role+'\n'+JSON.stringify(manifest),'utf8');
}
function validEndorsement(x,role,reviewId) {
  return keysAre(x,ENDORSEMENT) && x.role===role &&
    x.reviewId===reviewId && typeof x.signature==='string' &&
    SIG.test(x.signature) && Buffer.from(x.signature,'base64url').length===64;
}

export function signSyntheticAuditProviderReview({env,manifest,role,privateKey}={}) {
  guard(env);
  if (!['owner','independent_security'].includes(role) ||
      !validKey(privateKey,'private')) throw refused();
  const canonical=parseManifest(manifest);
  return Object.freeze({
    role,reviewId:canonical.reviewId,
    signature:sign(null,canonicalMessage(role,canonical),privateKey).toString('base64url'),
  });
}
export function evaluateSyntheticAuditProviderReadiness({
  env,manifest,ownerEndorsement,securityEndorsement,
  pinnedOwnerPublicKey,pinnedSecurityPublicKey,
  expectedSiteId,now,
}={}) {
  guard(env);
  const canonical=parseManifest(manifest);
  if (!UUID.test(expectedSiteId || '') ||
      canonical.siteId!==expectedSiteId.toLowerCase() ||
      !validKey(pinnedOwnerPublicKey,'public') ||
      !validKey(pinnedSecurityPublicKey,'public') ||
      !differentKeys(pinnedOwnerPublicKey,pinnedSecurityPublicKey) ||
      !validEndorsement(ownerEndorsement,'owner',canonical.reviewId) ||
      !validEndorsement(securityEndorsement,'independent_security',canonical.reviewId) ||
      !timestamp(now)) throw refused();
  if (!verify(null,canonicalMessage('owner',canonical),pinnedOwnerPublicKey,
      Buffer.from(ownerEndorsement.signature,'base64url')) ||
      !verify(null,canonicalMessage('independent_security',canonical),
        pinnedSecurityPublicKey,Buffer.from(securityEndorsement.signature,'base64url'))) {
    throw refused();
  }
  const age=Date.parse(now)-Date.parse(canonical.reviewedAt);
  const withinReviewWindow=age>=0 && age<=MAX_AGE;
  const missingControls=canonical.controls.filter(item=>
    item.status!=='passed_in_fixture').map(item=>item.code);
  const missingDrills=canonical.drills.filter(item=>
    item.status!=='passed_in_fixture').map(item=>item.code);
  const syntheticallyComplete=withinReviewWindow &&
    missingControls.length===0 && missingDrills.length===0;
  const digest=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return Object.freeze({
    kind:'synthetic-audit-provider-acceptance-assessment',
    reviewDigest:digest,
    fixtureEndorsementsCryptographicallyValid:true,
    reviewWithinSyntheticWindow:withinReviewWindow,
    controlsInspected:canonical.controls.length,
    drillsInspected:canonical.drills.length,
    unpassedControls:missingControls,
    unpassedDrills:missingDrills,
    syntheticMatrixComplete:syntheticallyComplete,
    reviewStatus:syntheticallyComplete
      ? 'synthetic_requirements_satisfied_only'
      : 'blocked_missing_or_stale_fixture_evidence',
    // These fields stay FALSE even if all synthetic checks pass. A CI
    // signature and UUID cannot establish a real person's approval, remote
    // retention policy, actual security alerts or genuine merchant account.
    ownerIdentityIndependentlyVerified:false,
    securityReviewerIndependentlyVerified:false,
    immutableRemoteCustodyVerified:false,
    externalHighWatermarkDurabilityVerified:false,
    authenticatedIncidentDeliveryVerified:false,
    liveRestoreDrillVerified:false,
    realProviderConnected:false,
    productionAuditReady:false,
    liveMerchantCredentialsApproved:false,
    paymentSettlementVerified:false,
    refundAuthorized:false,
    stockAdjustmentAuthorized:false,
    checkoutAuthorized:false,
    deploymentAuthorized:false,
    mutationsAllowed:false,
    notice:'Only isolated fixture evidence and synthetically pinned keys were checked. No genuine provider, legal retention, bank settlement, human sign-off, external alert or recovery is authenticated.',
  });
}

// No app.js import, production signer, HTTP transport, private keys,
// background monitoring, audit store write, customer data, payout or stock.
