import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessMerchantEvidenceProvisioning,
  buildMerchantEvidenceAuditEvent, compareMerchantIdentityClaims
} from '../server/merchant-evidence-boundary.js';

const wooKey = 'ck_0123456789abcdef0123456789abcdef';
const wooSecret = 'cs_abcdef0123456789abcdef0123456789';
const paystackSecret = 'sk_test_0123456789abcdef0123456789abcdef';
const auditSecret = 'synthetic_audit_hmac_key_separate_for_test_123456789';
const siteId = '72b1645b-bc7e-4be4-924d-3d3b9dbfbe89';
const otherSite = 'd936787e-8903-43c4-a4dc-5bedf25432da';
const reference = 'synthetic_transaction_original_1234';
const approved = () => ({
  MANSU_EVIDENCE_WOO_ORIGIN: 'https://mansutrendzgh.com',
  MANSU_EVIDENCE_DEDICATED_RUNTIME: 'true',
  MANSU_EVIDENCE_APPROVAL_REFERENCE: 'AUDIT-OWNER-REVIEW-20261115-CASE01',
  MANSU_EVIDENCE_WOO_KEY: wooKey,
  MANSU_EVIDENCE_WOO_SECRET: wooSecret,
  MANSU_EVIDENCE_PAYSTACK_SECRET: paystackSecret,
  MANSU_EVIDENCE_EXPECTED_INTEGRATION_ID: '1387567',
  MANSU_EVIDENCE_EXPECTED_SITE_ID: siteId,
  MANSU_EVIDENCE_AUDIT_HMAC_KEY: auditSecret,
  POS_OWNER_APPROVAL_REFERENCE: 'legacy-POS-owner-approval',
  POS_ONLINE_BRIDGE_LIVE_ACCEPTANCE_REFERENCE: 'another-bridge-acceptance',
});
const credentialOptions = () => ({
  catalogueCredentials: {
    consumerKey: 'ck_11111111111111111111111111111111',
    consumerSecret: 'cs_22222222222222222222222222222222',
  },
  onlineBridgeCredentials: { appPassword: 'a-separate-synthetic-wordpress-password' },
});
const resultFor = env => assessMerchantEvidenceProvisioning({ env, ...credentialOptions() });

test('complete syntactic provisioning only qualifies for manual review, never connects a live reader', () => {
  const info = resultFor(approved());
  assert.equal(info.kind, 'merchant-evidence-provisioning-preflight');
  assert.equal(info.formattingChecksPassed, true, JSON.stringify(info.blockers));
  assert.deepEqual(info.blockers, []);
  for (const [name, value] of Object.entries(info.checks)) {
    assert.equal(value, true, name);
  }
  for (const key of [
    'merchantOwnershipIndependentlyVerified', 'wooReadPermissionIndependentlyVerified',
    'paystackMerchantIntegrationVerified', 'installedSiteCompatibilityVerified',
    'bankSettlementVerified', 'refundPayoutVerified', 'clientCreated',
    'liveSiteContacted', 'credentialsExposed', 'enabledForLivePOS',
    'checkoutAuthorized', 'mutationsAllowed',
  ]) assert.equal(info[key], false, key);
  assert.equal(info.releaseStatus, 'separate_authorized_read_only_review_required');
  const s = JSON.stringify(info);
  for (const value of [wooKey,wooSecret,paystackSecret,auditSecret,siteId,reference]) {
    assert.equal(s.includes(value), false, 'No configuration secret or merchant claim should be exposed');
  }
});

test('catalogue, reservation bridge, recycled owner approval and audit-key reuse fail closed', () => {
  const config = approved();
  const sameKey = assessMerchantEvidenceProvisioning({
    env: { ...config, MANSU_EVIDENCE_WOO_KEY: 'ck_11111111111111111111111111111111' },
    ...credentialOptions(),
  });
  assert.ok(sameKey.blockers.includes('wooCredentialsNotReusedFromCatalogue'));
  const sameSecret = resultFor({ ...config,
    MANSU_EVIDENCE_AUDIT_HMAC_KEY: paystackSecret });
  assert.ok(sameSecret.blockers.includes('dedicatedAuditKeyPresent'));
  const sameBridge = assessMerchantEvidenceProvisioning({
    env: { ...config, MANSU_EVIDENCE_WOO_SECRET: 'cs_' + 'bridge_shared_password_123456789' },
    ...credentialOptions(),
    onlineBridgeCredentials: { appPassword: 'cs_' + 'bridge_shared_password_123456789' },
  });
  assert.ok(sameBridge.blockers.includes('wooCredentialsNotReusedFromReservationBridge'));
  const approvalReused = resultFor({ ...config, MANSU_EVIDENCE_APPROVAL_REFERENCE:
    config.POS_OWNER_APPROVAL_REFERENCE });
  assert.ok(approvalReused.blockers.includes('separateOwnerApprovalFormat'));
});

test('rejects credentials in Woo URL, arbitrary Woo host, poor keys or incomplete identity', () => {
  for (const badOrigin of [
    'https://mansutrendzgh.com.evil.example', 'http://mansutrendzgh.com',
    'https://attacker@mansutrendzgh.com', 'https://mansutrendzgh.com/wp-json',
    'https://mansutrendzgh.com/?reference=private', 'https://mansutrendzgh.com#private',
  ]) {
    const r=resultFor({ ...approved(), MANSU_EVIDENCE_WOO_ORIGIN:badOrigin });
    assert.ok(r.blockers.includes('approvedWooOriginFormat'));
    assert.equal(r.liveSiteContacted,false);
  }
  for (const props of [
    { MANSU_EVIDENCE_WOO_KEY: 'ck_bad' },
    { MANSU_EVIDENCE_PAYSTACK_SECRET: 'pk_live_public_key' },
    { MANSU_EVIDENCE_EXPECTED_INTEGRATION_ID: '0' },
    { MANSU_EVIDENCE_EXPECTED_SITE_ID: 'NOT-A-UUID' },
    { MANSU_EVIDENCE_DEDICATED_RUNTIME: 'false' },
    { MANSU_EVIDENCE_APPROVAL_REFERENCE: '' },
  ]) {
    const r=resultFor({ ...approved(), ...props });
    assert.equal(r.formattingChecksPassed,false);
    assert.ok(r.blockers.length >= 1);
    assert.equal(r.checkoutAuthorized,false);
  }
  const unconfigured=resultFor({});
  assert.equal(unconfigured.formattingChecksPassed,false);
  assert.equal(unconfigured.clientCreated,false);
});

test('untrusted merchant identity claims never turn into verified settlement or allowed stock changes', () => {
  const baseline = {
    expectedIntegrationId:'1387567', observedIntegrationId:'1387567',
    expectedSiteId:siteId, observedSiteId:siteId.toUpperCase(),
    wooOriginalReference:reference, gatewayOriginalReference:reference,
    wooAmountCents:24000, gatewayAmountCents:24000, currency:'GHS',
  };
  const ok=compareMerchantIdentityClaims(baseline);
  assert.equal(ok.sourceFieldsConsistent,true);
  assert.deepEqual(ok.issues,[]);
  const all=[
    'independentMerchantAuthentication','independentlyVerifiedWooPermissions',
    'independentlyVerifiedPaystackAccount','bankSettlementVerified',
    'customerPayoutVerified','returnInspected','checkoutAuthorized',
    'refundAuthorized','stockAdjustmentAuthorized','mutationsAllowed',
  ];
  for (const key of all) assert.equal(ok[key],false,key);
  assert.equal(JSON.stringify(ok).includes(reference),false);
  assert.equal(JSON.stringify(ok).includes('1387567'),false);
  for (const [variant,expected] of [
    [{observedIntegrationId:'1387568'},'paystack_integration_identity_mismatch'],
    [{observedSiteId:otherSite},'woocommerce_site_identity_mismatch'],
    [{gatewayOriginalReference:'different_payment_ref_0001'},'original_payment_reference_mismatch'],
    [{gatewayAmountCents:23999},'payment_amount_or_currency_mismatch'],
    [{currency:'USD'},'payment_amount_or_currency_mismatch'],
    [{observedIntegrationId:null},'merchant_identity_claim_missing'],
  ]) {
    const r=compareMerchantIdentityClaims({ ...baseline,...variant });
    assert.ok(r.issues.includes(expected),expected);
    assert.equal(r.mutationsAllowed,false);
  }
});

test('HMAC audit envelope pseudonymizes original Woo order; rejects arbitrary actions and PII', () => {
  const when='2026-11-15T14:40:00.000Z';
  const correlationId=randomUUID();
  const first=buildMerchantEvidenceAuditEvent({
    auditHmacKey:auditSecret, orderId:123456789, outcome:'review_started',
    time:when, correlationId, siteId,
  });
  assert.equal(first.kind,'merchant-evidence-access-audit');
  assert.equal(first.originalOrderToken.length,64);
  assert.equal(first.source,'dedicated-financial-reader');
  assert.equal(first.originalOrderToken,buildMerchantEvidenceAuditEvent({
    auditHmacKey:auditSecret, orderId:123456789, outcome:'source_read_failed',
    time:when, correlationId:randomUUID(), siteId,
  }).originalOrderToken);
  assert.notEqual(first.originalOrderToken,buildMerchantEvidenceAuditEvent({
    auditHmacKey:auditSecret, orderId:123456790, outcome:'review_started',
    time:when, correlationId, siteId,
  }).originalOrderToken);
  assert.notEqual(first.originalOrderToken,buildMerchantEvidenceAuditEvent({
    auditHmacKey:'different-strong-audit-key-abcdefgh123456789',
    orderId:123456789, outcome:'review_started', time:when, correlationId, siteId,
  }).originalOrderToken);
  for (const key of ['bankFundsVerified','merchantIdentityVerified','payoutConfirmed',
    'refundAuthorized','checkoutAuthorized','financialWriteAuthorized']) {
    assert.equal(first[key],false,key);
  }
  for (const sensitive of ['123456789',auditSecret,paystackSecret,wooSecret,reference]) {
    assert.equal(JSON.stringify(first).includes(sensitive),false);
  }
  assert.equal(Object.isFrozen(first),true);
  for (const change of [
    { outcome:'refund_approved' },{ auditHmacKey:'short' },
    { orderId:0 },{ time:'2026-11-15' },
    { correlationId:'raw-customer-address' },{ siteId:'https://evil.example' },
  ]) assert.throws(()=>buildMerchantEvidenceAuditEvent({
    auditHmacKey:auditSecret, orderId:123456789, outcome:'review_started',
    time:when, correlationId, siteId, ...change,
  }));
});

test('preflight module never imports the Woo, Paystack, POS app or network transport', () => {
  const url = new URL('../server/merchant-evidence-boundary.js', import.meta.url);
  const source = fs.readFileSync(fileURLToPath(url),'utf8');
  assert.equal(source.includes('fetch('),false);
  assert.equal(source.includes('http.request('),false);
  assert.equal(source.includes('createApp('),false);
  assert.equal(source.includes('app.js'),true, 'Boundary documents deliberate absence from POS app');
});

test('manually invoked offline preflight does not print environment secrets or enable any live operation', () => {
  const catalogue=credentialOptions();
  const script=fileURLToPath(new URL('../scripts/merchant-evidence-preflight.mjs',import.meta.url));
  const run=spawnSync(process.execPath,[script],{
    encoding:'utf8',timeout:5000,
    env:{ ...process.env,...approved(),
      WOO_CONSUMER_KEY:catalogue.catalogueCredentials.consumerKey,
      WOO_CONSUMER_SECRET:catalogue.catalogueCredentials.consumerSecret,
      POS_ONLINE_BRIDGE_APP_PASSWORD:catalogue.onlineBridgeCredentials.appPassword,
    },
  });
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.stderr,'');
  const report=JSON.parse(run.stdout);
  assert.equal(report.kind,'merchant-evidence-provisioning-preflight');
  assert.equal(report.formattingChecksPassed,true,JSON.stringify(report.blockers));
  assert.equal(report.liveSiteContacted,false);
  assert.equal(report.enabledForLivePOS,false);
  assert.equal(report.checkoutAuthorized,false);
  assert.equal(report.clientCreated,false);
  for(const sensitive of [wooKey,wooSecret,paystackSecret,auditSecret,
    catalogue.catalogueCredentials.consumerSecret,
    catalogue.onlineBridgeCredentials.appPassword]) {
    assert.equal(run.stdout.includes(sensitive),false,'Offline CLI leaked secret');
  }
});
