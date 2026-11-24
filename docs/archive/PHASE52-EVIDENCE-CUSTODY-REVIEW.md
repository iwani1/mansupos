# Phase 5.2 — Private Evidence Custody and Independent Review Preparation

**STATUS: DEVELOPMENT ONLY — DRAFT GitHub PR #1. NOT deployed.**
**NO actual file delivery, verified custody, independent witness, stock approval, or trading.**

## Scope

Adds an owner-only **Custody & independent review — declarations only**
register under **Operations → Physical stock counts**. After a current local
SHA-256 file manifest is recorded for a historical physical source row
(Phase 5.1), the Owner can append a sequence of *metadata-only declarations*:

1. `sealed_in_private_custody` — a claim that the original file/paper has
   been secured. Record a privately assigned, anonymous storage reference
   such as `SEALED_CASE_001`; do not use a filesystem path, URL, customer
   name, employee name or physical address in this code.
2. `custody_access_logged` — a subsequent claim describing an access or
   handling event; a prior seal declaration is required.
3. `independent_review_requested` — a request that an independent person
   examine the original count sheet and any signatures. A prior seal
   declaration is required. Choose a **proposed** channel: in-person,
   separately secured external transfer or sealed paper. This app does NOT
   send the document or acknowledge delivery, reviewer identity, receipt,
   witness signature or the review result.

All entries require an Owner note of 8–180 characters. **Never include names,
bank information, addresses, credentials or personal information.** The POS
does not collect the original PDF/photo, file names, signature images,
identity documents or employee count quantities through this feature.

The latest owner custody event is visible alongside the historic product
SKU, current document fingerprint, its source row, and outstanding count
discrepancies. The status `review_requested_unconfirmed` means only
that the owner requested a review; it is not proof of handoff or reviewer
acceptance. Products with mismatched staff counts remain
`count_discrepancy_open` even after a review request.

## Technical and security boundaries

- Owner-only `GET /api/stock-safety/evidence-custody` and
  `POST /api/stock-safety/evidence-custody`. Both require read-only live
  pilot mode. GET accepts strictly bounded search, status, paging (max 50
  rows), optional source-bound `expectedRef`; it uses
  `Cache-Control: no-store`.
- The server reads ONE Woo published-product GET snapshot, existing signed
  historical physical source, first/second count declarations, supervision
  events and latest private document manifests through existing services.
  This work does not read Woo orders or touch website stock.
- Every POST requires exact first/second count event IDs, latest document
  manifest ID, SHA-256 hash, exact current custody snapshot, previous custody
  event ID (nullable), action, anonymous custody reference, proposed review
  channel, short note and a UUID. Strict Zod validation rejects unknown
  fields, approval requests, document contents, paths and unsupported actions.
- Under SQLite `BEGIN IMMEDIATE`, validate the source + manifesto identity,
  current count IDs, file fingerprint, previous custody event and snapshot
  before appending `inventory.private_evidence_custody` to the existing
  append-only POS audit table. Lost-response identical UUID retries return
  the original event; changed reuse and stale forms fail HTTP 409.
  No database migration, separate stock ledger or overwrite operation.
- A current manifest **and a prior seal declaration for that manifest**
  are required before an access or external review request. New manifest
  identities, changed source, changing count claims or newer custody
  declarations invalidate the current review. Prior audit events are
  retained, but not silently reused as verified current evidence.
- The digest used to bind pages spans all current source rows, manifest IDs,
  count claim IDs and latest custody event IDs. Changing any of these
  makes subsequent pages with an older `expectedRef` return HTTP 409.
  No hard proof of external custody, original integrity or reviewer
  acknowledgement is established by this hash or local journal.
- Public access, Managers and Cashiers cannot view or append custody events.
  Only the Owner may read and write this metadata.

**Every server response** reports
`documentBytesStored:false`,
`independentReviewConfirmed:false`,
`independentWitnessVerified:false`,
`ownerApproved:false`,
`stockImportAuthorized:false`, and
`checkoutAuthorized:false`.
GET additionally reports `documentSignatureVerified:false`,
`mappingApproved:false`, and `sharedStockVerified:false`.
No approve, authenticate witness, close discrepancy, import stock,
payment, receipt or checkout endpoint is created.

## Work still required before stock acceptance

The Owner must separately organize controlled original-file storage,
out-of-band identity/role verification for an independent person, signed
witnessed physical recounts, confirmation that original files match their
recorded SHA-256, independent signed style/colour/size variation mapping,
off-host recovery exercise, Woo stock-reservation/Paystack concurrency
verification and an explicitly approved production cutover. A custody
declaration cannot replace these procedures. The current historic source
is not a live physical stock count.

## Regression

- `tests/evidence-custody-review.test.js`: independent case identity,
  seal prerequisite, follow-up request, strict schema/owner role,
  idempotency, stale snapshot, changed original fingerprints, mismatch
  isolation, bounded read-only review and no stock acceptance.
- `tests/physical-count-claims-app.test.js`: isolated Express endpoint
  role/GET+metadata POST, no Woo writes, no unapproved actions, revision
  conflicts, discrepancy still open and zero POS sales writes.
- `tests/browser-live-pilot.mjs`: synthetic owner UI records a seal
  declaration followed by a review request, attached to the current
  file digest and first/second count IDs, without authorizing stock.

All tests use synthetic evidence; no real file is fetched or sent.
Continue **GitHub-only development** as requested, keep PR #1
**DRAFT/UNMERGED**, and leave the Contabo read-only pilot `8d1117fc`
unchanged.
