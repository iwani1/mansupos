# Phase 5.7 — Independently Verifiable Inventory Acceptance Readiness (Analysis Only)

**Status:** GitHub-only development on draft, unmerged PR #1. No Contabo or WooCommerce deployment, payment, checkout, stock import, automated deduction, inventory certification or account authorization changes.

## What this build adds

Phase 5.7 joins existing **read-only owner inventory dossier** (historical
physical source, Owner SKU/variation proposal and two staff count declarations)
with Phase 5.6 **exception evidence** (custody, reviewer account assignments,
Owner-reported reviewer claims, handoff challenge receipts and reported file
fingerprint comparisons). It displays **nine row-level evidence requirements**
and **six whole-system requirements** for a separately controlled acceptance
process.

Crucially, this is a **gap analysis**, not a process that can declare readiness.
It has no POST endpoint. It never stores an approval, resolves disputes, updates
WooCommerce, checks out a sale, records payment or issues a certificate.
No criterion can transition to verified/passed/approved from the pilot data.

## Owner screen and route

- Go to **Operations → Physical stock counts → Stock readiness: evidence required before launch**.
- Or use the Owner-only, GET-only endpoint:
  `GET /api/stock-safety/verification-readiness`
- Supported filters: `focus` (`all`, `count_disputes`, `identity_holds`,
  `document_problems`, `reviewer_handoff`, `other_missing`),
  `search` (source row or SKU), `page`, `pageSize` and
  optional `expectedRef`. A stale checksum returns HTTP 409.
- The response joins **all** source rows before pagination. It fails closed
  on unverified historical-source identity, duplicate/missing rows or
  mismatch between mapping, count and reviewer evidence. Observed case
  hashes do not expose private file bytes, quantities or prices.
- The UI intentionally has no Accept, Confirm, Resolve, Override,
  Certificate, Sync or Enable Checkout control.

## Row-level verification requirements

Each historical source row shows nine categories, with states limited to
`held`, `conflicting`, `missing`, `observed_unverified`,
`not_verified`, or `not_authorized`:

1. Historical SKU identity — an unchanged historical match is
   **observed**, never physical product proof.
2. Owner WooCommerce option/variation proposal — a proposed mapping,
   even with an exact SKU string match, is **not approved**.
3. Two staff count claims — matching declarations remain **unwitnessed**;
   unequal declarations remain **conflicting and OPEN**.
4. Private file manifest and custody — an Owner custody claim is not
   proof of original file provenance.
5. Restricted reviewer handoff — a signed-in account's possession of a
   one-time code is not proof of human independence.
6. Document fingerprint — even a reported matching SHA-256 does not
   verify original authenticity or paper signature.
7. Independent human witness and identity proof — **not verified**.
8. Independently signed, current physical count reconciliation —
   **not verified**, including in apparently matching staff-count cases.
9. Formal, separately authenticated Owner variation-mapping approval —
   **not authorized**.

A count disagreement has review priority even if the same case also has
missing originals or reported SHA-256 mismatches; the full list of
simultaneous exception flags is preserved.

## Global requirements that cannot pass in this pilot

- Independent physical witness identity, independence and signed attendance.
- Original signed current physical counts and discrepancy reconciliation.
- Style, colour, size and product/variation crosswalk verification with
  a separately authenticated approval procedure.
- A single Woo stock authority with atomic last-unit reservations and
  tested simultaneous web/in-store demand.
- Paystack webhook/payment callback retries, pending orders, duplicate
  payments and refund concurrency on a disposable test installation.
- Independently verified off-host backup restore, rollback, security
  review, supervised launch and acceptance.

Each global requirement remains `verified:false`. No payment gateway,
WooCommerce write key, live Woo quantity or real physical stock is used.

## Safety invariants and scope

The complete response always includes
`releaseReady:false`, `inventoryAccepted:false`,
`independentHumanIdentityVerified:false`,
`independentWitnessVerified:false`,
`currentPhysicalCountVerified:false`,
`mappingApproved:false`, `ownerApproved:false`,
`acceptanceCertificateIssued:false`,
`liveReservationVerified:false`,
`paymentConcurrencyVerified:false`,
`backupRestoreVerified:false`, `stockImportAuthorized:false`,
`checkoutAuthorized:false` and `paymentsAuthorized:false`.

The same hold is repeated on every row. A reported successful handoff,
matching fingerprints, matching staff counts or an Owner investigation
note cannot clear any of these flags.

## Testing and deployment rules

- `tests/inventory-verification-readiness.test.js` covers four mixed
  source cases, Owner-only restrictions, missing/held/conflicting and
  matching-but-unverified records, nine evidence requirements, six
  mandatory global checks, deterministic pagination/filtering, evidence
  hash changes and fail-closed row/source mismatches.
- `tests/independent-reviewer-access.test.js` checks the authenticated
  GET route in a synthetic full Express workflow after a reviewer account
  receives handoff metadata; tests verify reviewer/staff denial, missing
  session 401, stale snapshot 409 and that an unresolved count remains
  blocked even when a reviewer account is active.
- CI must separately pass lint, Node tests, Docker, browser workflows and
  Windows packaging on the exact final commit before considering
  development verification complete.

**Keep PR #1 draft and unmerged. Do not deploy this feature to Contabo or
enable production checkout, POS cash collection, payment gateway writes,
WooCommerce stock imports, automated stock deductions, or WooCommerce
orders.** Real-world independent count verification and architecture
acceptance remain outside the app and still need to happen before launch.
