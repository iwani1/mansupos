# Phase 5.6 — Owner Inventory Evidence Exceptions and Investigation Journal

**Development-only. Draft PR #1 remains unmerged. No Contabo, WooCommerce, Paystack, checkout, physical stock adjustment, or inventory synchronization changes.**

## Purpose

The former Phase 5.1–5.5 workflow records physical count declarations,
a private document fingerprint, Owner-reported custody/reviewer contact,
separate reviewer account acknowledgements, and a restricted out-of-band
handoff challenge. **None** independently validates physical counts, the
original paper document, human reviewer identity, garment variation
mappings or shared WooCommerce stock.

Phase 5.6 brings these existing assertions together in a single **Owner-only
unresolved exception queue**, including cases without a ready handoff.
Its actions are **investigation notes only**: no verified/accepted/approved/
resolved switch exists in the API, UI or journal.

## Owner workspace

From **Operations → Physical stock counts → Unresolved inventory evidence**:

- Filter by staff count disagreement, reviewer or file issue, required
  handoff, incomplete custody/source or other unverified evidence.
- Search by SKU or original historical source row, with server-side
  pagination and a full snapshot reference for stale-page checks.
- Review the primary hold classification plus **all** applicable evidence
  flags (a count disagreement takes priority over a file mismatch).
- See why a reviewer report is not independently verified: missing
  account assignment, revocation/staleness, no handoff, unavailable
  file, reported SHA-256 mismatch, reported issue, or the fact that a
  matching SHA-256 is not proof of original provenance.
- Record one of six **next investigation steps** as an append-only
  Owner note tied to the exact case and evidence snapshot:
  - `request_independent_recount`
  - `inspect_original_outside_pos`
  - `investigate_sku_variation`
  - `request_replacement_evidence`
  - `verify_reviewer_identity_offline`
  - `escalate_for_independent_audit`

These entries **never change the physical count declarations**, reclassify
the stock as accepted, close a discrepancy, certify a reviewer, or clear a
source hold. Existing previous notes remain in local history; if newer
source/custody/reviewer evidence appears, older notes are not presented
as current investigation evidence.

## API surface

Both routes are **Owner-only** and restricted to the read-only live pilot.
The GET accepts validated `page`, `pageSize`, `status`, `search` and
optional `expectedRef`, which returns HTTP 409 if the snapshot changed:

- `GET /api/stock-safety/evidence-exceptions`
- `POST /api/stock-safety/evidence-exceptions/followup`

POST receives `reportRow`, the exact current `expectedRef`,
`expectedCaseRef`, the latest follow-up event ID (or null), an enum
`action`, a 12–180 character factual note, and a UUID `requestId`.
Unknown fields (including `approveInventory` or `resolved`) are rejected.
All updates use SQLite `BEGIN IMMEDIATE` and an append-only audit event
`inventory.evidence_exception_followup`.

A repeated identical UUID is idempotent; reused UUID with changed content
returns 409. Fresh requests with old snapshots or old case evidence return
409 and must be reviewed again. Existing rate limits stay in force.
No new SQLite schema or Woo REST write operation is introduced.

## Explicit safety invariants

`caseClosed:false`, `inventoryAccepted:false`,
`independentReviewConfirmed:false`,
`reviewerIdentityVerified:false`,
`physicalCountVerified:false`, `signatureVerified:false`,
`mappingApproved:false`, `ownerApproved:false`,
`sharedStockVerified:false`, `stockImportAuthorized:false`,
`checkoutAuthorized:false`, and `paymentsAuthorized:false`.

The queue is an **Owner planning and audit tool**, not a guarantee of
physical inventory accuracy, stock availability or an independently
authenticated audit. It cannot be used as a launch gate by itself.

## Verification

- `tests/inventory-evidence-exceptions.test.js` uses synthetic SQLite
  and reviewer evidence to test four case categories, competing issues,
  unverified matching fingerprints, strict role protection, pagination,
  filtered listing, stale snapshot rejection, immutable audit journal,
  UUID replay, altered payload rejection and historical note invalidation
  after later reviewer evidence changes.
- `tests/independent-reviewer-access.test.js` adds HTTP-level Owner
  queue access and reviewer/staff denial, stale expectedRef, and a
  count discrepancy that must remain open.
- Full CI runs lint, automated tests, Docker build, Windows packaging
  and browser integration. Do not claim the latest commit is fully
  verified until the exact commit's CI reports complete success.

**No Contabo action is required.** Keep the draft development branch
unmerged, and keep real-world sales, payments, Woo stock import and
cross-channel stock adjustments disabled pending independent acceptance.
