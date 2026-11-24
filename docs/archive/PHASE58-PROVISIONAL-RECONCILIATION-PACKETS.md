# Phase 5.8 — Controlled Provisional Reconciliation Packets and Reviewer Issue Register

**Development status:** draft PR #1 only, not merged or deployed. The historical read-only Contabo pilot, WooCommerce, Paystack, real inventory, cash payments, checkout and website stock quantities remain unchanged.

## Purpose

Phase 5.7 mapped inventory evidence gaps but did not let the Owner prepare a specific reconciliation plan for an assigned reviewer account. Phase 5.8 now records **case-bound Owner proposals** in an append-only audit register and lets a **dedicated, previously granted reviewer POS account** report *unresolved evidence problems* in a separate journal.

**Neither account can declare an inventory acceptance.** A reviewer POS login does not independently verify the reviewer's real-world identity or independence. A reviewer issue report is an account-authenticated statement, not an independent count, signature, legal attestation or proof of original document provenance.

## Owner workflow — provisional proposals only

Under **Operations → Physical stock counts → Provisional reconciliation packets**, Owner can:

1. Examine the current row, open discrepancy, evidence readiness revision, and assigned reviewer grants.
2. Choose a previously provisioned, **active case-scoped reviewer grant**.
3. Record an investigation intent: blind recount request, inspection of the original sheet, product variation investigation, or a **provisional unit count**.
4. Enter provisional units *only* for the `prepare_provisional_count` intent, 0 to 1,000,000 whole units. These numbers stay **Owner-only** and are not imported into WooCommerce or treated as physical stock.
5. Provide a brief factual note; save as immutable `inventory.reconciliation_packet_proposed` evidence.

The submitted packet is bound to the current Phase 5.7 readiness checksum, the selected physical row's evidence checksum, current source identity, assigned reviewer grant and the current reviewer/custody snapshot. A changed mapping, count, reviewer handoff, exception journal, grant, or source blocks old packets as stale.

Subsequent Owner proposals must name the last packet ID. Each is a new event; older packets are retained for audit but cannot be accepted or treated as the current independent review.

## Reviewer workflow — objections only

The isolated reviewer-only workspace shows **current proposals assigned to that reviewer account**, with source row ID, packet ID, requested investigation intent and response status.

It specifically **does not expose** provisional units, the Owner's private note, raw count claims, pricing, customers, original document bytes or any other reviewer’s cases.

Reviewer can record one of these unresolved findings, once per current packet:

- `requires_independent_recount`
- `original_document_unavailable`
- `product_variation_uncertain`
- `witness_identity_not_proven`
- `other_evidence_problem`

The response is an append-only `inventory.reconciliation_packet_reviewed` event with the authenticated account ID and timestamp. It **does not prove physical inspection or permit resolution**. The reviewer cannot use any stock movement, payment, staff, catalogue, customer or Owner approval endpoints.

## API and audit rules

Owner-only, live READ-ONLY pilot:

- `GET /api/stock-safety/reconciliation-packets`
- `POST /api/stock-safety/reconciliation-packets`

Reviewer-only, same read-only pilot:

- `GET /api/reviewer/reconciliation-packets`
- `POST /api/reviewer/reconciliation-packets/response`

The existing global reviewer deny-by-default middleware allows only those two new dedicated paths in addition to the previously approved reviewer routes. All POST requests also use existing 30/minute sensitive action rate limiting and session/role/origin checks.

Request bodies require exact valid UUID, SHA-256 evidence references, case/grant identity and strict Zod schemas; `approved:true`, `acceptInventory`, arbitrary quantities on a recount request or other unknown fields fail validation. Creation and response use SQLite `BEGIN IMMEDIATE`, immutable audit events, idempotent identical request replay, conflict on modified replay and stale evidence failure.

One account objection may be recorded per current packet. New Owner proposals supersede earlier packet metadata. Revoked grants and source/variant/readiness changes fail closed. No new SQLite schema is introduced.

## Safety invariants

Every packet and response is `auditOnly:true`, `provisionalOnly:true`, and retains:

- `humanIdentityVerified:false`
- `independentWitnessVerified:false`
- `originalDocumentVerified:false`
- `physicalCountVerified:false`
- `reconciliationApproved:false`
- `discrepancyClosed:false`
- `mappingApproved:false`
- `ownerApproved:false`
- `inventoryAccepted:false`
- `acceptanceCertificateIssued:false`
- `stockImportAuthorized:false`
- `checkoutAuthorized:false`
- `paymentsAuthorized:false`
- `releaseReady:false`

A matching SKU, a reported matching SHA-256 or matching staff counts still cannot be used as authorization. **There is no approval, physical stock adjustment, shared WooCommerce deduction, payment or checkout action in Phase 5.8.**

## Tests and release constraints

- `tests/inventory-reconciliation-packets.test.js`: synthetic owner/reviewer/other-role checks; Owner-only provisional units; strict schema; case/grant/source/readiness checks; request UUID idempotency; private reviewer payload redaction; one-time reviewer objections; stale or revoked grants; immutable audit and no approval flags.
- `tests/independent-reviewer-access.test.js`: restricted reviewer API, Owner-only GET and both roles’ no-approval response contracts with synthetic Woo GET-only data.
- Existing Phase 5.7 acceptance and Phase 5.6 exception tests remain active.
- Full CI runs lint, all Node tests, Docker, browser and Windows packaging. Review the exact final commit's results before making a green claim.

**Do not merge or deploy PR #1.** Real-world independent witnessed counts, authenticated physical documentary acceptance, formal variation mapping signoff, WooCommerce last-unit reservation concurrency, Paystack callback/refund safeguards and independently tested off-host recovery are still prerequisites for a distinct trading release.
