# Phase 5.0 — Supervised Physical Count Evidence Register

**Status: GitHub DRAFT only. NO Contabo deployment and NO live-stock authorization.**

## Purpose

The Owner may add a locally recorded **supervision declaration** linked to the
first and second count claim event IDs for a historical source row. Each
record includes the Owner's authenticated POS account identifier, timestamp,
an action and short note, plus an optional **private paper-file reference
code** (4–48 alphanumeric/underscore/hyphen characters).

The record is NOT a signed paper count sheet, a photo upload, a verified
independent human witness, stock approval, or permission to accept payment.
The evidence document itself remains outside the application and is neither
uploaded nor cryptographically inspected. Store paper evidence securely and
avoid customer or employee personal details in the note/reference.

## Owner workflow

In **Operations → Physical stock counts**, the Owner sees the original staff
count review and a new **Supervisor count evidence — declarations only**
section. The register:

1. Shows historic source row and SKU, two count claim audit IDs, the two
   counter-account IDs, count/discrepancy status and latest supervisor note.
2. Requires two recorded count claims tied to two DISTINCT signed-in staff
   accounts. The Owner may not be either counter for the supervised record.
3. Allows the Owner to record exactly one of:
   `observed_count_procedure`, `request_signed_evidence`, or
   `flag_discrepancy`. A discrepancy flag requires unequal recorded counts.
   A claim that the procedure was observed cannot be used to represent
   two unequal declarations as matching stock.
4. Keeps **count_discrepancy_open** even after a supervisor's observation
   note is recorded. A case with matching declarations and an owner note
   remains **supervision_note_unverified**.
5. Allows a new follow-up only after refreshing the owner review, ensuring
   the next note is tied to the exact latest audit event and evidence snapshot.
6. Shows rows where a first/second claim is missing but disables recording.

The Owner dashboard hides individual count quantities (the separate Owner
count-claims review still displays those). Managers/Cashiers and unauthenticated
users cannot access supervision records or submit notes.

## Server and persistence

- `GET /api/stock-safety/count-supervision` — Owner only, bounded search
  /status filters and 1–50 rows per page, `Cache-Control:no-store`.
- `POST /api/stock-safety/count-supervision` — Owner only, strict Zod
  validation, sensitive rate limit, only in `POS_MODE=live` with
  `POS_LIVE_READ_ONLY=true`.
- Records one `inventory.count_supervision_note` event in the existing
  SQLite **append-only audit** table (no schema change), inside
  `BEGIN IMMEDIATE`. Payload includes signed source hash, count identity
  snapshot, two claim IDs, note/action, evidence reference code, and UUID.
- Requests check signed historical source and Woo published-product
  catalogue evidence and compare both count IDs, distinct account IDs and
  status. An idempotent exact UUID retry returns the existing event;
  conflicting reuse fails HTTP 409. An older review/replaced note fails
  HTTP 409; earlier events are immutable.
- `snapshotRef` for the Owner GET includes the signed source identity,
  current staff count stage/IDs and latest supervisor note IDs. New events
  invalidate paging, while a Woo refresh with identical product identities
  does not. A changed physical source or Woo identity hides old notes from
  the *current* case without deleting the historical audit events.
- The `documentCode` is only a privately assigned label for an externally
  secured file. There is **no upload/download of document bytes**, signature
  validation, identity document processing or independent witnessing.
  Never treat a supplied code as proof that a document exists.

Every list and POST response explicitly retains
`independentWitnessVerified:false`, `ownerApproved:false`,
`stockImportAuthorized:false` and `checkoutAuthorized:false`.
The read route additionally sets `physicallyWitnessed:false`,
`mappingApproved:false` and `sharedStockVerified:false`.

## Safety and subsequent acceptance

Separate human-supervised paper verification, owner style/colour/size crosswalk
review, installed Woo reservation/Paystack race tests, offsite ledger recovery
and authorized production rollout all remain REQUIRED. An Owner account
statement is not independent evidence, and any discrepancy must stay open.

Tests cover missing counts, two distinct signed-in actors, discrepancy gates,
recording without financial effects, old-snapshot 409, duplicate UUIDs,
source changes, Owner-only API, client flow and no Woo order/stock writes.
All tests are synthetic and do not inspect live garments.

PR #1 stays DRAFT/UNMERGED; Contabo live pilot `8d1117fc` remains untouched.
