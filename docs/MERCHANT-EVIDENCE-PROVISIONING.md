# Phase 3.1 — Dedicated merchant financial-evidence provisioning (NOT enabled)

**Status:** Draft-only, non-executing, offline readiness and identity controls. No production reader, POS API route, scheduled job, Paystack connection, installation or deploy. Live checkout remains locked: lateGatewayGuardVerified is false.

## Why a separate service is required

The current Contabo catalogue pilot has a WooCommerce key whose access is restricted to product reads. **Never upgrade or reuse that key** for financial evidence. A separate future financial-read service must use an independent runtime and WooCommerce credentials, a separately reviewed Paystack access method, a verified expected merchant/integration identity and private audit material. It must not share cashier-facing POS financial write access.

**Paystack secret API keys may provide powerful non-read-only operations.** A secret key is not inherently a read-only credential. Its permissions, handling and provider-approved least-privilege method must be reviewed independently. No credentials should be pasted into the repository, pull requests, tickets, ChatGPT, logs, or screenshots.

## Built modules

- **server/merchant-evidence-boundary.js:** Pure provisioning-format checks; separate Woo/catalogue/bridge credential comparisons; comparison of claimed Woo site UUID and Paystack integration identity; HMAC-pseudonymized financial evidence audit event envelopes. This file makes no network calls, imports no POS app and does not authorize business operations.
- **scripts/merchant-evidence-preflight.mjs:** Manual **offline** preflight. Invoke with node scripts/merchant-evidence-preflight.mjs in an explicitly authorized private environment. Reads only process environment, prints sanitized booleans and blockers, and does not connect to the store or Paystack. Exit code 0 means the program executed, NOT that any release is approved.
- **tests/merchant-evidence-boundary.test.js:** Tests valid and invalid configurations, recycled credentials, malicious store origins, merchant identity claim mismatches, HMAC event privacy, offline command output and permanent false checkout/settlement authorization.

## Future provisioning names — not active here

The separate manual preflight reads these future variables: MANSU_EVIDENCE_WOO_ORIGIN, MANSU_EVIDENCE_DEDICATED_RUNTIME, MANSU_EVIDENCE_APPROVAL_REFERENCE, MANSU_EVIDENCE_WOO_KEY, MANSU_EVIDENCE_WOO_SECRET, MANSU_EVIDENCE_PAYSTACK_SECRET, MANSU_EVIDENCE_EXPECTED_INTEGRATION_ID, MANSU_EVIDENCE_EXPECTED_SITE_ID, MANSU_EVIDENCE_AUDIT_HMAC_KEY.

It compares the proposed Woo credentials against **independently provisioned SHA-256 fingerprints** of the existing catalogue key and secret (MANSU_EVIDENCE_CATALOGUE_KEY_SHA256, MANSU_EVIDENCE_CATALOGUE_SECRET_SHA256) and the reservation bridge application password (MANSU_EVIDENCE_BRIDGE_PASSWORD_SHA256). **Never copy raw WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET or POS_ONLINE_BRIDGE_APP_PASSWORD into the financial reader.** Fingerprints should be computed by a trusted provisioning operator in the source credential's private runtime and transferred separately through the secret-management process. The report does not print fingerprints. A supplied fingerprint is not independently authenticated by this code and can be incorrect or forged. Existing POS_OWNER_APPROVAL_REFERENCE and POS_ONLINE_BRIDGE_LIVE_ACCEPTANCE_REFERENCE are compared only to prevent approval-reference reuse. API permission scope and genuine Owner authorization cannot be verified from configuration strings.

Approved Woo origins must match exactly https://mansutrendzgh.com or https://www.mansutrendzgh.com without a path, query, fragment, user-info or redirect. Paystack account/integration identity and Woo site UUID must be separately checked from trusted merchant-controlled records; identical values in two untrusted responses are not independent evidence.

## Audit limitations

The event creator accepts only fixed decisions: review_started, source_configuration_blocked, identity_mismatch, source_snapshot_incomplete, source_snapshot_consistent_unverified or source_read_failed. It uses a separately keyed HMAC to pseudonymize the original Woo order ID, with a correlation UUID and exact timestamp. No raw order ID, customer data, transaction reference, gateway secret or bank number belongs in the resulting event. All refund, payout, stock and checkout authorizations remain false.

**This is an audit schema, not an independently protected audit store.** A dedicated tamper-evident append-only sink, retention policy, operator permissions, alerting and independent review remain future requirements. No audit events are saved automatically by this draft.

## Required before a real read-only connection

1. Independently inventory the live WooCommerce version, installed Paystack gateway version, HPOS settings, payment/stock plugins, and Paystack reference storage. The pinned disposable CI versions may differ from the merchant site.
2. Provision a narrowly scoped WooCommerce order/refund read credential, distinct from the catalogue key. Verify that POST, PUT and DELETE actions are actually denied by the installed site's permissions.
3. Have the merchant independently authenticate the real Paystack account and expected integration identity. Review the provider's available least-privilege read options, transaction verification, refund history, access key exposure risks and outbound egress restrictions.
4. Separately obtain bank settlement and customer payout evidence. A gateway transaction-success response does not prove bank credit; a Woo refund record does not prove cash was returned.
5. Choose secure, independently reviewed audit persistence and incident/rollback procedures. Obtain explicit Owner approval for any future credential provisioning and restricted site-read testing.
6. Build and independently accept a dedicated, read-only service with secure secret storage, strict origin allowlists, account binding, permission verification, rate limits and no shopping/payout/stock write methods.
7. Keep this draft unmerged and uninstalled. Do not alter the live website, POS pilot or Contabo deployment, and do not change the checkout safety lock without separate release acceptance.

The Phase 3.0 synthetic reader remains pinned to a .invalid WooCommerce origin and an injected fake HTTP client. **Phase 3.1 does not convert it into a live integration.**
