/**
 * Phase 3.1: independent merchant-evidence provisioning and audit boundary.
 *
 * This is a PURE PRE-DEPLOYMENT CHECK. It does not create a Paystack/Woo
 * client, fetch records, accept user input in Express, grant access, issue
 * a refund, or unlock checkout. It is deliberately absent from app.js.
 *
 * Merchant account/permission/scope/settlement validation must be witnessed
 * independently before any production reader is added in a separate service.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

const origins = new Set([
  'https://mansutrendzgh.com',
  'https://www.mansutrendzgh.com',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decisions = new Set([
  'review_started',
  'source_configuration_blocked',
  'identity_mismatch',
  'source_snapshot_incomplete',
  'source_snapshot_consistent_unverified',
  'source_read_failed',
]);
const minKeyLength = 32;
const hash = value => createHash('sha256').update(value, 'utf8').digest();
function equalSecret(a, b) {
  if (!a || !b) return false;
  return timingSafeEqual(hash(a), hash(b));
}
function matchesProvidedFingerprint(value, fingerprint) {
  // The existing catalogue and bridge secrets must NEVER enter the new
  // financial-read runtime. Compare only independently supplied SHA-256
  // digests of these high-entropy credentials. A digest's provenance still
  // requires an external trust/approval check.
  if (typeof value !== 'string' || !value ||
      typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint)) return false;
  return timingSafeEqual(hash(value), Buffer.from(fingerprint, 'hex'));
}
function fingerprintValid(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}
function validOrigin(value) {
  if (!origins.has(value)) return false;
  try {
    const url = new URL(value);
    return url.origin === value && url.protocol === 'https:' &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/';
  } catch { return false; }
}
function validIntegrationId(value) {
  // Paystack's integration identity must be bound to a separately verified
  // merchant account; a number in config or a JSON response is not proof.
  return typeof value === 'string' &&
    /^[1-9][0-9]{0,14}$/.test(value) &&
    Number.isSafeInteger(Number(value));
}
function validApproval(value) {
  // Must be recorded in an external, owner-approved change record. This
  // format check alone does NOT attest the approval is genuine.
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{15,79}$/.test(value);
}

export function assessMerchantEvidenceProvisioning({ env = {},
  catalogueFingerprints = {}, onlineBridgeFingerprint = '' } = {}) {
  const wooKey = env.MANSU_EVIDENCE_WOO_KEY || '';
  const wooSecret = env.MANSU_EVIDENCE_WOO_SECRET || '';
  const paystackSecret = env.MANSU_EVIDENCE_PAYSTACK_SECRET || '';
  const approval = env.MANSU_EVIDENCE_APPROVAL_REFERENCE || '';
  const checks = {
    approvedWooOriginFormat: validOrigin(env.MANSU_EVIDENCE_WOO_ORIGIN),
    dedicatedRuntimeDeclared: env.MANSU_EVIDENCE_DEDICATED_RUNTIME === 'true',
    separateOwnerApprovalFormat: validApproval(approval) &&
      approval !== env.POS_OWNER_APPROVAL_REFERENCE &&
      approval !== env.POS_ONLINE_BRIDGE_LIVE_ACCEPTANCE_REFERENCE,
    dedicatedWooReadCredentialsPresent:
      typeof wooKey === 'string' && /^ck_[A-Za-z0-9]{16,}$/.test(wooKey) &&
      typeof wooSecret === 'string' && /^cs_[A-Za-z0-9]{16,}$/.test(wooSecret),
    wooCredentialsNotReusedFromCatalogue:
      Boolean(wooKey && wooSecret &&
        fingerprintValid(catalogueFingerprints.consumerKeySha256) &&
        fingerprintValid(catalogueFingerprints.consumerSecretSha256)) &&
      !matchesProvidedFingerprint(wooKey, catalogueFingerprints.consumerKeySha256) &&
      !matchesProvidedFingerprint(wooSecret, catalogueFingerprints.consumerSecretSha256),
    wooCredentialsNotReusedFromReservationBridge:
      Boolean(wooSecret && fingerprintValid(onlineBridgeFingerprint)) &&
      !matchesProvidedFingerprint(wooSecret, onlineBridgeFingerprint),
    paystackReadSecretPresent:
      typeof paystackSecret === 'string' &&
      /^sk_(?:live|test)_[A-Za-z0-9]{20,}$/.test(paystackSecret),
    paystackMerchantIntegrationIdentityProvided:
      validIntegrationId(env.MANSU_EVIDENCE_EXPECTED_INTEGRATION_ID),
    knownWooSiteIdentityProvided: uuid.test(env.MANSU_EVIDENCE_EXPECTED_SITE_ID || ''),
    dedicatedAuditKeyPresent:
      typeof env.MANSU_EVIDENCE_AUDIT_HMAC_KEY === 'string' &&
      Buffer.byteLength(env.MANSU_EVIDENCE_AUDIT_HMAC_KEY) >= minKeyLength &&
      !equalSecret(env.MANSU_EVIDENCE_AUDIT_HMAC_KEY, wooSecret) &&
      !equalSecret(env.MANSU_EVIDENCE_AUDIT_HMAC_KEY, paystackSecret),
  };
  const blockers = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    kind: 'merchant-evidence-provisioning-preflight',
    source: 'configuration-format-only',
    checks,
    blockers,
    formattingChecksPassed: blockers.length === 0,
    // A local env file cannot prove permission scope, account ownership,
    // the installed Woo/Paystack versions, or real bank settlement.
    merchantOwnershipIndependentlyVerified: false,
    wooReadPermissionIndependentlyVerified: false,
    paystackMerchantIntegrationVerified: false,
    installedSiteCompatibilityVerified: false,
    bankSettlementVerified: false,
    refundPayoutVerified: false,
    clientCreated: false,
    liveSiteContacted: false,
    credentialsExposed: false,
    enabledForLivePOS: false,
    checkoutAuthorized: false,
    mutationsAllowed: false,
    releaseStatus: 'separate_authorized_read_only_review_required',
    notice: 'Provisioning checks are NOT credentials approval. Do not connect the catalogue-only pilot or collect a real payment. A separately witnessed account, key scope, installed-site and settlement review is required.',
  };
}

function safeOrderId(id) {
  return Number.isSafeInteger(id) && id > 0 && id <= 999999999999;
}
function safeTime(time) {
  if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) ||
      !Number.isFinite(Date.parse(time))) throw new Error('Evidence audit timestamp invalid.');
  return time;
}
function safeCode(code) {
  if (!decisions.has(code)) throw new Error('Unapproved evidence audit outcome.');
  return code;
}
function auditKey(key) {
  if (typeof key !== 'string' || Buffer.byteLength(key) < minKeyLength) {
    throw new Error('A separately provisioned evidence audit HMAC key is required.');
  }
  return key;
}
export function buildMerchantEvidenceAuditEvent({ auditHmacKey, orderId,
  outcome, time, correlationId, siteId } = {}) {
  auditKey(auditHmacKey);
  if (!safeOrderId(orderId) || !uuid.test(siteId || '') ||
      typeof correlationId !== 'string' || !uuid.test(correlationId)) {
    throw new Error('Evidence audit identity or correlation invalid.');
  }
  safeCode(outcome);
  safeTime(time);
  // Store only an opaque, separately keyed original-order token. Never
  // log raw Woo order IDs, customers, references, Paystack IDs or credentials.
  const orderToken = createHmac('sha256', auditHmacKey)
    .update(siteId + ':' + orderId, 'utf8').digest('hex');
  return Object.freeze({
    kind: 'merchant-evidence-access-audit',
    eventVersion: 1,
    correlationId,
    originalOrderToken: orderToken,
    outcome,
    occurredAt: time,
    source: 'dedicated-financial-reader',
    readOnly: true,
    bankFundsVerified: false,
    merchantIdentityVerified: false,
    payoutConfirmed: false,
    refundAuthorized: false,
    checkoutAuthorized: false,
    financialWriteAuthorized: false,
  });
}

export function compareMerchantIdentityClaims({ expectedIntegrationId,
  expectedSiteId, observedIntegrationId, observedSiteId,
  wooOriginalReference, gatewayOriginalReference,
  wooAmountCents, gatewayAmountCents, currency = 'GHS' } = {}) {
  // This is an independent source-claim consistency test, NOT independent
  // account authentication. An attacker could fabricate every supplied value.
  const known = validIntegrationId(expectedIntegrationId) &&
    validIntegrationId(observedIntegrationId) &&
    uuid.test(expectedSiteId || '') && uuid.test(observedSiteId || '');
  const refs = [wooOriginalReference, gatewayOriginalReference];
  const refsValid = refs.every(x => typeof x === 'string' &&
    /^[A-Za-z0-9_.-]{8,256}$/.test(x));
  const amountsValid = Number.isSafeInteger(wooAmountCents) && wooAmountCents > 0 &&
    Number.isSafeInteger(gatewayAmountCents) && gatewayAmountCents > 0;
  const issueCodes = [];
  if (!known) issueCodes.push('merchant_identity_claim_missing');
  if (known && expectedIntegrationId !== observedIntegrationId) {
    issueCodes.push('paystack_integration_identity_mismatch');
  }
  if (known && expectedSiteId.toLowerCase() !== observedSiteId.toLowerCase()) {
    issueCodes.push('woocommerce_site_identity_mismatch');
  }
  if (!refsValid || wooOriginalReference !== gatewayOriginalReference) {
    issueCodes.push('original_payment_reference_mismatch');
  }
  if (!amountsValid || wooAmountCents !== gatewayAmountCents || currency !== 'GHS') {
    issueCodes.push('payment_amount_or_currency_mismatch');
  }
  return {
    kind: 'merchant-source-identity-claims-comparison',
    source: 'untrusted-claimed-identities',
    sourceFieldsConsistent: issueCodes.length === 0,
    issues: issueCodes,
    independentMerchantAuthentication: false,
    independentlyVerifiedWooPermissions: false,
    independentlyVerifiedPaystackAccount: false,
    bankSettlementVerified: false,
    customerPayoutVerified: false,
    returnInspected: false,
    checkoutAuthorized: false,
    refundAuthorized: false,
    stockAdjustmentAuthorized: false,
    mutationsAllowed: false,
    releaseStatus: 'read_only_source_authentication_pending',
    notice: 'Matching merchant IDs, original references and amounts are not proof of authentic API responses, bank credit, customer refunds or inventory entitlement.',
  };
}

// No automatic configuration import, Express route, scheduled task, network
// transport, filesystem secrets or live service activation in this module.
