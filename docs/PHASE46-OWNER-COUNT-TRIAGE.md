# Phase 4.6 — Owner Investigation Notes for Physical Count Claims

**GitHub draft only. No deployment, no WooCommerce mutation, no owner stock signoff.**

This feature extends the Phase 4.5 local physical-count claim journal. An
Owner can document **follow-up tasks** after inspecting staff count claims.
The choices are deliberately limited to `request_recount`,
`investigate_product_identity`, `collect_witness_evidence` and
`other_follow_up`. None is a verification, closure or stock-approval decision.

## User experience

Navigate to **Operations → Physical stock counts** with an Owner account.
For each source row the owner can see the first/second employee declarations,
record one required follow-up action, and enter a short investigation note
(5–180 characters; no customer details). Earlier notes remain in the local
append-only POS audit journal. The latest note appears beside the row.
If a first or second count arrives or changes after the note, the row displays
**Counts changed — recheck needed** instead of silently preserving the note as
current. A source/product-identity change makes older notes unavailable as
current cases; the audit history itself is retained.

A Manager/Cashier account can still make a blind count claim for eligible
source rows, but **cannot read owner notes, view another employee's claimed
quantity or record owner investigation notes**.

## API, validation and storage

- `GET /api/stock-safety/count-claims-review` (Owner only): retains the
  25-row paged read-only review; adds claim event IDs and an optional latest
  follow-up note per row with its `needsRecheck` indicator.
- `POST /api/stock-safety/count-owner-triage` (Owner only): append-only
  `inventory.count_owner_triage` audit event under the existing v9 POS
  SQLite schema. This is an operational metadata write, NOT a stock write.
  Both endpoints require `POS_MODE=live` and `POS_LIVE_READ_ONLY=true`.
- Strict request schema: historical report row, exact source/Woo identity
  snapshot SHA256, observed first and second audit event IDs (nullable),
  latest follow-up event ID (nullable), one of four non-approving action codes,
  a one-line note of 5–180 characters, and a request UUID.
- Under a single `BEGIN IMMEDIATE` SQLite transaction, compare the expected
  count IDs and latest owner-note ID before append. Stale forms fail HTTP 409,
  a lost-response retry with the exact same UUID/payload is idempotent, and
  UUID reuse for a different submission fails HTTP 409. It does not alter
  existing staff claims or any product, price, stock or order records.
- Source validity / Woo catalogue freshness are hard conditions on new notes.
  Normal refreshes of unchanged product identities do not invalidate the
  count snapshot. A change to source or Woo product/variation identity does.

## Explicitly unverified

An owner follow-up is **not** independent physical witnessing or stock
acceptance. Two agreeing staff declarations remain
`matching_claims_unverified`. Nothing in the response or UI sets
`ownerApproved`, `independentWitnessVerified`,
`stockImportAuthorized` or `checkoutAuthorized` to true. No "approve",
"accept inventory", "resolve hold", "post stock adjustment" or payment endpoint
is created. There are no changes to public WooCommerce, its plugins, stock,
orders, Paystack, or the already running Contabo POS.

This is local POS audit history; it is neither a remote cryptographic proof
nor evidence that real people completed independent physical counts.
Appropriate supervised witnessing, SKU/variation mapping signoff,
current physical count validation, separate Woo reservation acceptance and
recovery exercises remain required before any trading rollout.

## Regression coverage

- `tests/physical-count-triage.test.js`: append-only history, different
  counters, optimistic concurrency, stale count ID and note ID conflicts,
  idempotency, source/identity changes, invalid decisions and role enforcement.
- `tests/physical-count-claims-app.test.js`: full isolated Express API with
  a synthetic Woo products-only connector, protected Owner endpoint,
  forbidden staff/public POSTs, and unchanged sales/stock ledgers.
- `tests/browser-live-pilot.mjs`: Owner adds a simulated follow-up to a
  count discrepancy, bound to the exact claim IDs; confirms that the
  browser never exposes a stock-approval action.

Keep PR #1 **draft/unmerged** until separately reviewed. The current live
release `8d1117fc` remains unchanged and read-only on Contabo.
