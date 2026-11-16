# MansuPOS — Four Remaining Tracks Built as Development Safeguards, NOT a Live Release

**Branch:** `phase2/stock-safety-audit-20261114` | **PR #1: DRAFT / UNMERGED**.
No Contabo deployment; no installed-store changes. **Do not enable Woo stock
imports, automated deductions, payments, in-store checkout or trading.**

The user requested all four remaining tracks together. The delivered code
adds a synthetic reservation safety model, synthetic payment/refund lifecycle,
read-only cross-track acceptance dashboard, offline CI preflight and tests.
These are **development artifacts**, not proof that the full live integration
is built, tested, accepted or deployed.

## Track 1 — Physical inventory, independent evidence and mapping

Existing Phase 5.1–5.9 services already preserve historical counts, staff
declarations, private custody fingerprints, Owner-reported external review,
reviewer-account observations, unresolved discrepancies, provisional Owner
unit proposals and a metadata-only external audit manifest. The new
four-track dashboard binds this audit evidence and reports outstanding
requirements; it **does not accept a physical count**.

For actual acceptance, an independent human must verify outside MansuPOS:

1. **Scope**: lock a complete source manifest with SKU, product name, style,
   colour and size; identify duplicated/held/no-SKU garments separately.
2. **Witness**: verify the reviewer's real-world identity and independence
   through a separate trusted process. Do not assume POS login proves it.
3. **Blind recount**: two independently supervised people count identical
   product/variation units without seeing each other's responses.
4. **Disagreement**: independently recount every discrepancy and preserve
   original signed tally sheets; do not overwrite initial declarations.
5. **Custody**: compare original signed sheet to the retained SHA-256 and
   inspect provenance outside POS. A matching hash is NOT an authentic
   signature or proof of original creation.
6. **Crosswalk**: independently verify physical style/colour/size identity,
   correct Woo parent/variation IDs, stock ownership (parent vs variation),
   manage-stock and backorder policies. Separate Owner signoff is necessary.
7. **Acceptance record**: record independent auditor report, dated signoffs,
   source checksum, rejected/held exceptions and an approved list of eligible
   units outside the current POS approval APIs. No exceptions may silently
   become sellable.

**Completion condition:** independently witnessed current counts and a
separately approved crosswalk, with evidence traceability and all count
disagreements resolved. The software still reports `acceptedRows:0`.

## Track 2 — Store ↔ website reservation/synchronization safety

`server/synthetic-stock-safety.js` exercises in-memory, deliberately
nonproduction stock-owner pools for shared parent/variation quantities,
last-unit contention, duplicate reservation keys, changed retry payloads,
uncertain cancellation, late paid events and one-time verified release.

The repository also has a **separate disposable WordPress/WooCommerce +
Paystack conformance workflow** using synthetic data and the existing Woo
bridge plugin. Neither this workflow nor the in-memory model changes the
real website or proves the installed live configuration.

**Actual release acceptance still requires** on the exact intended Woo
version, theme, plugin versions and infrastructure:

- Confirm **one** authority for on-hand/available quantities. A sale in
  MansuPOS and an online Woo checkout must reserve from the same atomic
  stock-owner pool, including variants that share parent stock.
- Simulate 2+ concurrent buyers for the last unit, across separate
  PHP workers/processes and store/web channels. Confirm exactly one
  reservation, no negative stock and no double decrement.
- Verify pending payment, timeout, retries, canceled orders, late success,
  partial refunds, customer returns and stock adjustments; ambiguous
  outcomes must be held for human review instead of restocked.
- Test durable idempotency across webhooks and restarts. A repeat request
  must return the same original state, never allocate a second hold.
- Confirm backups, rollback and a recovery plan for abandoned reservations.

**Do not use an Owner's provisional count as a Woo stock import.** There
is no automatic production-sync authorization in this branch.

## Track 3 — Checkout, Paystack, refunds and cash

`server/synthetic-payment-safety.js` exercises a synthetic payment order,
authenticity-flag checks, repeated callbacks, altered replay payloads,
partial and full refunds, late payment after cancellation, unverified
callbacks, cash/shift preconditions and uncertain state handling.

The simulator does **not** call Paystack, validate real HMAC signatures,
prove a bank settlement, receive physical cash or create Woo orders.

Live acceptance needs:

- Installed-site order identity, signed Paystack callbacks and webhook
  replay/hijack checks, including failed/late/reordered callbacks.
- A documented mapping from pending ↔ paid ↔ refunded with separate
  external settlement proof and refund payouts.
- Explicit staff cash drawer/shift handover controls and owner
  reconciliation for discrepancies and offline episodes.
- End-to-end duplicate requests, restart between reserve and charge,
  unknown timeouts, payment-retry flows, and safe human exception paths.
- A dedicated, properly accepted Woo order/reservation bridge. Legacy
  unreserved REST checkout MUST remain blocked.

**No payment or cash acceptance is authorized by synthetic success.**

## Track 4 — Security, backup, training and release

`server/full-launch-readiness.js` joins the existing Owner audit evidence
to the two synthetic scenario reports and lists eight unresolved acceptance
requirements across all four tracks.

The Owner-only GET endpoint is
`GET /api/stock-safety/full-launch-readiness` (read-only live pilot only).
The screen is under **Operations → Physical stock counts → Store + website
launch readiness**. All external verification, approval and deployment flags
are hard-coded `false`; there is NO release POST or override.

The offline preflight is:

```bash
node scripts/four-track-preflight.mjs
node scripts/four-track-preflight.mjs --require-production-ready
```

The first command should exit 0 if synthetic checks and read-only
configuration are safe. The second **MUST exit non-zero**, because live
physical acceptance, installed Woo/Paystack, recovery and deployment
signoffs have not been performed. CI explicitly asserts both behaviors.

Before any future deployment decision:

1. Final GitHub CI must pass on the **exact final reviewed commit**:
   Node tests, lint, actual disposable Woo conformance, browser/a11y,
   Docker build and Windows installer.
2. Independent security/privacy assessment, least-privilege POS roles,
   secret rotation, no stock or payment data exposure, and verified audit
   integrity.
3. Supervised off-host backup, full restore, database integrity tests,
   recovery rehearsal, controlled rollback and proof that no pending order
   or stock hold is duplicated on restart.
4. Staff training and signed acceptance (Owner, sales representative and
   fulfilment officer), with process for unresolved orders and physical
   stock quarantine.
5. Explicit, separate Owner permission and a documented production
   acceptance plan. Use isolated services and staged, supervised rollout.
6. Never merge or deploy on the basis of this development build alone.

## Safety contracts

All four-track responses and the UI report:

`productionReady:false`,
`independentPhysicalProofVerified:false`,
`installedWooReservationsVerified:false`,
`realPaystackCallbacksVerified:false`,
`offHostBackupRestoreVerified:false`,
`authorizedLiveDeployment:false`,
`stockImportAuthorized:false`,
`checkoutAuthorized:false`, and
`paymentsAuthorized:false`.

There are **no new live write endpoints, production Woo API calls, Paystack
calls or Contabo updates** in these four development additions. The tests
and synthetic models are not a substitute for independent operational
acceptance. Future release approvals must be separate from this code
and independently evidenced.

## Source files and automated tests

- `server/synthetic-stock-safety.js`
- `server/synthetic-payment-safety.js`
- `server/full-launch-readiness.js`
- `src/FullLaunchReadinessPanel.jsx`
- `scripts/four-track-preflight.mjs`
- `tests/four-track-synthetic-safety.test.js`
- `tests/four-track-release-gates.test.js`
- Existing `tests/independent-reviewer-access.test.js`: Owner endpoint,
  reviewer/staff denial and final lock flags.
- `.github/workflows/ci.yml`: exact synthetic preflight plus mandatory
  production-readiness refusal.

**The launch is not complete until real-world proof, installed-site
acceptance and separately authorized deployment occur.**
