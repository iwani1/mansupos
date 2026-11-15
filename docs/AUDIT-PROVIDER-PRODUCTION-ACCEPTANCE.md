# MansuPOS Phase 3.6 — Independent financial-audit provider acceptance specification

**Status: DRAFT technical specification and CI-only readiness harness. NOT a deployed provider, external audit ledger, real alert notifier, production permission or live checkout release.**

This specifies what a separately administered audit service must prove before MansuPOS may capture authentic financial-evidence audit receipts. All prior financial, checkout, Paystack and stock locks remain in place. The current POS catalogue-only WooCommerce credential MUST NOT be upgraded or reused.

## 1. Infrastructure separation

| Boundary | Allowed future responsibility | Not allowed |
|---|---|---|
| Current POS / Contabo | User interface, existing catalogue pilot | Audit-custodian private keys, actual financial-evidence secrets, changing Woo stock or payments |
| Dedicated financial evidence reader (not built) | Narrowly authorized Woo original-order/refund reads and provider-approved Paystack verification | Refund, bank payout, Woo order creation or stock adjustment |
| Independent audit custodian (not built) | Verify original signed receipts and durably retain an immutable, monotonically increasing high watermark | Payment processing, customer details, POS order mutation |
| Independent incident service (not built) | Durable critical ticket, authenticated notification receipt, escalation and monitoring | Unilateral refund approval, stock restoration |
| Owner and independent security reviewer | Account/role validation, policy, controlled release and recovery authorization | Self-approving incident closure and resetting an audit history silently |

Independent custody requires independent credentials, administrators, private keys, retention permissions and failure domain. Two folders on the same server, in-memory maps or even two local signing keys are NOT an independently administered durable witness.

## 2. Provider-neutral service methods (design only)

| Logical operation | Minimum input | Authenticated response | Failure rule |
|---|---|---|---|
| appendCheckpoint | Site UUID, unique original operation UUID, complete Ed25519-signed witness receipt | Durable acceptance ID, same operation UUID, signed sequence/head, retention identifier | Persist before acknowledge. Reject older/forked receipts |
| findCheckpoint | Original operation UUID | Same original signed acceptance or authenticated not-found | Unknown outcomes remain blocked; never generate a new operation UUID on timeout |
| latestCheckpoint | Site UUID | Signed monotonically increasing trusted high watermark | Must survive service restart, region failure and client rollback |
| appendIncident / findIncident | Deterministic incident ID, enumerated code and severity | Durable signed incident ticket, separately authenticated Owner delivery receipt | Ticket persistence does NOT prove recipient delivery; track both |

Production transport requires service authentication (mTLS or equivalent), independent trust-root pinning, strict host allowlists and schemas, payload/timeout/rate bounds, replay protection, key rotation/revocation and controlled recipient authorization. No URL or credential may be supplied from a POS order, browser, Woo metadata or free-text user field. Transport must never be able to initiate bank payments, Paystack refunds, or Woo inventory mutations.

Custodian payloads should contain only narrowly scoped site identity, signed checkpoint, pseudonymized order tokens when strictly necessary, and incident identifiers. Do not put names, phone numbers, emails, bank accounts, full gateway references, Woo order content, security tokens, or secret keys into audit or alert payloads.

## 3. Explicit uncertainty and integrity behavior

A lost append acknowledgement **after** commit can be resolved only by querying the same operation UUID and independently verifying the signed reply and current remote high watermark. A lost response **before** commit, invalid signature, conflicting operation content, wrong merchant/site UUID, unavailable inquiry, revoked key, unknown retention state or stale head is NOT success. Do not automatically resubmit with a different ID or allow payout, order fulfilment, stock adjustment, checkout unlock or recovery.

A recorded incident ticket is not an alert-delivery confirmation. Actual alert delivery requires a separate authenticated receipt tied to the intended Owner/security recipient, with escalation when unavailable, expired or contested. Provider outages must trigger a separately approved incident/monitoring channel. Never describe a locally recorded fixture incident as an email, SMS, WhatsApp message or delivered page.

## 4. Acceptance matrix in source control (synthetic only)

The executable acceptance matrix lives in server/audit-provider-acceptance.js.

It defines **12 required audit custody/operations controls**:
- Separate off-host custodian administration
- Immutable retention and legal hold
- Monotonic remote checkpoint
- Independent pinned verification key
- Least-privilege append/query authority
- Authenticated signed acknowledgement
- Durable critical incident ticket
- Independently confirmed Owner alert receipt
- Incident escalation and acknowledgement
- Key rotation, revocation and break-glass
- Privacy/retention and access review
- Isolated backup and manual restore

It also defines **8 required safety drills**:
- Lost acknowledgement before durable commit
- Lost acknowledgement after durable commit
- Duplicate/replayed or conflicting receipts
- Both local journal and witness rolled back
- External provider unavailable
- Alert delivery unconfirmed
- Signing key revoked
- Disaster restore with Owner and independent reviewer

Each check must use one of three enumerated states: passed_in_fixture, failed, or not_tested. Passed/failed checks require an opaque synthetic proof UUID; not_tested requires null. Raw customer or financial metadata is rejected.

The *whole canonical synthetic manifest* is digitally signed by separate Ed25519 Owner and independent-security test keys. The verifier rejects duplicate/missing controls, forged or wrong-role signatures, key reuse, cross-site/review replay and reports outside the seven-day synthetic window.

**A complete, synthetically signed manifest is NOT real Owner approval.** The result always keeps productionAuditReady, deploymentAuthorized, realProviderConnected, immutableRemoteCustodyVerified, authenticatedIncidentDeliveryVerified, checkoutAuthorized, refundAuthorized and stockAdjustmentAuthorized as false. These are not configurable release toggles. Real reviewers' identity and genuine key custody must be authenticated outside this repository.

## 5. Independent proof required for a real provider

The audit provider assessment must retain evidence **outside the POS server and repository**, accessible to the Owner and independent security reviewer:

| Area | Minimum authentic independent evidence |
|---|---|
| Custody and retention | Provider owner and role list, retention/WORM settings, deletion-denial and legal-hold test, access log |
| High watermark | Signed receipt sequence from multiple runs, verified key provenance, denial of old/forked receipt after restarts |
| Least privilege | Negative permission tests for record rewriting/deletion, payment access, customer data access and Woo writes |
| Incident durability and notifications | Persisted ticket ID, independently verified recipient delivery evidence, escalation on unconfirmed delivery |
| Key management | Non-exportable private key or approved custody, pinned verification key, revocation, rotation, compromise drill |
| Privacy/retention | Authorized retention schedule, encryption, pseudonymous identifier risk assessment, data-region decision |
| Backup and recovery | Isolated restore, candidate head matched to immutable external source, preserved originals and two-party security review |

**Operating targets have not been chosen.** Before integration, the Owner and security lead must specify and approve: data retention duration, audit recovery point objective (RPO), recovery time objective (RTO), incident alert response/acknowledgement targets, legal/data-region requirements and provider cost. Acceptance must validate the agreed figures; this draft intentionally does not invent thresholds.

## 6. Staging acceptance and recovery runbook

1. Choose an independently administered custody/storage service and separate alert provider. Confirm accounts, roles, retention controls and independent operations.
2. Authenticate trust roots out of band. Provision separate non-exportable keys and narrowly scoped append/query and incident identities, never reusing POS catalogue or bridge credentials.
3. Implement an explicitly authorized staging-only service client with strict network egress, site binding, request schemas, read-only local POS integration, and no checkout/refund/stock methods.
4. Run the 12 controls and 8 drills. Keep their real authenticated results in the independent assessment system, not as mutable source-code fixture assertions.
5. Verify unknown acknowledgement both before/after commit; require same-operation lookup, signed response and persistent monotonic head.
6. Simulate lost/tampered/forked receipts, dual local rollback, unavailable provider, revoked signing key, unauthenticated alert delivery, and changed custodian keys. Confirm critical alerts reach Owner/security via independently verified delivery and that all financial state remains unchanged.
7. Restore protected backups **only in an isolated environment**; compare complete journal and witness against the external high watermark. Preserve old evidence, identify gaps and require Owner plus independent security sign-off. Do not auto-repair/truncate, clear stale locks or reset trusted heads.
8. Independently inspect installed WooCommerce/Paystack versions and permissions; merchant-authorized payment evidence connection is a separate acceptance track. A Paystack secret key is not inherently read-only.
9. Obtain explicit Owner and independent security approval in a distinct change-control process, including backup, rollback and incident procedures. Passing synthetic CI must never be interpreted as go-live approval.
10. Only a separately approved release may add production provider credentials, merge or deploy, or widen read-only finance access. Website checkout must remain independently gated and locked until the payment, callback and stock safety acceptance is complete.

## 7. Delivered Phase 3.6 artifacts

- **server/audit-provider-acceptance.js:** pure CI-only conformance/dual-signature evaluator; no networking, production gateway or POS import.
- **tests/audit-provider-acceptance.test.js:** complete and missing controls, two-person cryptography, wrong keys, stale/replayed/forged reports, privacy checks, and permanent false release flags.
- **docs/AUDIT-PROVIDER-PRODUCTION-ACCEPTANCE.md:** this architecture and acceptance specification.

The audit provider is still **not connected**. The real durable off-host storage, authenticated Owner alerts, installed-site financial reader, provider/key authentication, independent bank settlement proof and explicit release approval remain outstanding. No part of this phase processes payments, refunds, cash, stocks or automatic restoration. The WooCommerce bridge still reports lateGatewayGuardVerified: false.
