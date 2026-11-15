# Phase 4.7 — Owner Product Mapping Evidence (DRAFT, NOT DEPLOYED)

This extends the existing read-only historical physical stock mapping workbench
with **Owner-only, append-only proposed product/variation identities**. A
proposal is an *investigation record*, **NOT** an approved mapping, live
product, verified stock number, or permission to sell.

## User workflow

After opening **Catalogue → Stock safety review → Compare product codes**,
the Owner can open **Product mapping evidence — proposals only**. For each
historical physical source row, choose:
- **Record a proposed Woo product or size/colour option.** Enter a *published*
  WooCommerce simple-product ID, or the product + variation ID for a variable
  product. The server checks the exact option exists and is uniquely identified
  in the authenticated published Woo catalogue. It rejects a parent-only ID,
  nonexistent IDs and identities already claimed by a different physical row.
  This is a proposal; a mismatched SKU is explicitly flagged for investigation.
- **Request an identity or SKU investigation.** Describes the next action,
  without suggesting an ungrounded Woo product link.
- **Keep this product on review/hold.** Records a hold note and does not release
  stock. Held/quarantined, missing physical SKU, duplicate physical source SKU
  and ambiguous Woo identity cannot receive proposed links without separate
  source remediation.

Every note requires a short owner explanation. Proposed options, even with
exactly matching SKUs, are never labelled approved or allocated to a stock
pool. Owner can inspect the latest note and see a count of unresolved,
proposed and held items.

## Technical safety boundary

- `GET /api/stock-safety/owner-mapping-evidence` — Owner only; page size 25,
  max 50, strict search/status filtering and source/option identity snapshot
  token. Only authenticated, read-only live catalogue access.
- `POST /api/stock-safety/owner-mapping-evidence` — Owner only; restricted
  `POS_MODE=live` and `POS_LIVE_READ_ONLY=true`. Refreshes Woo published
  catalogue with GET only, verifies the signed physical source, and writes only
  an `inventory.owner_mapping_review` event in the EXISTING local append-only
  POS audit journal. No schema change, Woo stock mutation, POS sale, payment or
  checkout.
- Payload includes one source report row, exact identity snapshot SHA256,
  expected latest owner-review event ID, one of three **non-approving** actions,
  nullable proposed Woo product/variation IDs, a one-line 8–240-character
  investigation note and a request UUID. Unknown fields and approval actions
  are rejected.
- SQLite `BEGIN IMMEDIATE` transaction makes the latest-note and duplicate
  option check atomic with event insertion. Exact retries with the same
  request UUID/payload return the previous event; changed submissions using
  the same UUID receive HTTP 409. A stale review, identity change or
  duplicate proposed Woo option receives HTTP 409.
- The snapshot hash covers the physical source, each source row's identity
  classification and the full published Woo option ID/SKU list, **not** the
  fetch timestamp. A benign Woo GET refresh does not invalidate notes. Actual
  physical or Woo identity changes invalidate current proposals while
  retaining older events in the audit trail.
- All responses include `mappingApproved:false`,
  `stockImportAuthorized:false` and `checkoutAuthorized:false`.
  No endpoint can change those properties or authorize trading.

## Limitations and future acceptance

The historical physical record may have an incomplete or incorrect SKU.
Matching an ID/SKU in Woo does not prove the actual garment style, colour,
size, variant, physically counted quantity, independent witness or Woo
stock ownership. Woo's *published product GET* is not a verified view of
pending website orders, gateway cash settlement or last-unit concurrency.
Two owner proposals may be correct or wrong: this stage does not create
approved crosswalk records, import stock or reconcile quantities.

Future work still requires fresh independent physical evidence, signed
style/colour/size crosswalk, scrutiny of installed Woo/Paystack plugins,
atomic reservation safeguards and off-site recovery, followed by a separately
approved production-trading release.

## Tests

`tests/owner-mapping-evidence.test.js` checks proposal uniqueness, invalid
parent/variation IDs, held rows, owner role, stable snapshot, replay conflicts
and no approval. `tests/owner-mapping-evidence-app.test.js` tests real auth
and the Express API with isolated temporary database and **synthetic Woo GETs**.
`tests/browser-live-pilot.mjs` tests an Owner recording a synthetic proposal.
No production Woo checkout, Contabo services, real live inventory or payments
are accessed by these tests.

Keep GitHub PR #1 **DRAFT and UNMERGED**. Per the Owner's instruction,
continue development in GitHub only before any Contabo deployment. The
already running read-only pilot release remains `8d1117fc` and is unchanged.
