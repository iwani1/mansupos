# Phase 4.4 — Physical recount task preparation (DRAFT, NO DEPLOYMENT)

Status: **code-only review planning** in the existing draft pull request.
**Do not install this branch on Contabo, merge or enable POS/Woo checkout.**

## Purpose and access

Inside **Stock safety review → Compare product codes → Physical stock-count
preparation**, an authenticated Owner or Manager can build a review plan for
every row in the already pinned historical 1,571-row physical stock source.
This is a preparation worksheet, **not** an inventory count, new stock balance,
stock import, approved Woo identity mapping, order, payment or checkout.

The new endpoint `GET /api/stock-safety/recount-plan` requires live
**read-only** mode and Owner/Manager role; public and cashier sessions are
denied. Data comes from the existing signed PDF/CSV physical snapshot and the
authenticated published Woo *product* catalogue GET/cache only. It never
queries Woo orders or writes products, stock, POS ledger sales, payments,
cash/receipt records, approval entries or the source files.

Allowed strict query fields: `page` (1–10,000), `pageSize` (1–50),
`priority` (`all`, `P0`, `P1`, `P2`), `action` (known review action or `all`),
`search` (up to 64 characters, exact identifiers only), and optional
`expectedRef` (64 lower-case hex). The server returns HTTP 409
`RECOUNT_PLAN_CHANGED` if the physical source or Woo observation changes
between pages. This prevents presenting different scans as one count plan.

## Task classification

Every physical row remains an open *review task* with a priority, even when
its SKU appears in the website catalogue:

| Priority | Historical identity classification | Next manual evidence |
|---|---|---|
| P0 | Held/quarantined | Investigate and resolve the hold separately; **never release automatically** |
| P0 | Missing physical SKU | Identify and physically label the correct garment/variant |
| P0 | Duplicate physical SKU | Resolve each source identity without reusing another variant's code |
| P0 | Ambiguous Woo identity | Verify distinct Woo product/variation identities with the Owner |
| P1 | Only variable-parent SKU matches | Identify the actual size and colour variation; **parent code is not enough** |
| P1 | Missing from published Woo | Review whether to create/link a product; **no automatic creation** |
| P2 | One provisional exact SKU match | Independently verify style, colour, size, Woo stock owner and current physical count |

All priorities still require witnessed fresh counts, reconciliation to
pending/paid website orders, Woo stock ownership verification and separate
Owner approval before any stock import or checkout. A P2 result is
**not approved**, not fresh, and not ready for sale.

## Blank worksheet

The **Download blank worksheet (this page)** button generates a local
`MansuPOS-blank-recount-page-N-NOT-APPROVED.csv` file in the browser.
It includes **only** the currently displayed 25-or-fewer source row IDs,
historical SKUs, suggested priority/actions and source/checksum references.
Count 1, second count, independent counter/witness and Owner decision
columns are deliberately blank. No historical quantities, customer names,
per-item prices or POS passwords are included. Formula-like CSV values
are escaped before download.

- The download is disabled unless the existing source/evidence check passes.
- Counts that employees write into downloaded files **are not stored or
  verified by MansuPOS** and cannot be uploaded to the application by this
  feature. A CSV cell saying `approved` is not authorization.
- Downloaded worksheets are potentially sensitive operational records: keep
  copies private and **do not upload them to public GitHub or share them in
  ordinary chats**. If the source or Woo observation changes, regenerate
  and label a new worksheet; do not silently merge different sets.
- Real independent physical count validation is covered separately by the
  existing local Phase 4 cutover evidence and Phase 4.3 second-recount
  claim assessment. Those local commands do not import stock or authenticate
  actual counter identities.

The API always sets
`auditOnly:true`, `checkoutAuthorized:false`,
`sharedStockVerified:false`, `mappingApproved:false`,
`stockImportAuthorized:false`, `freshPhysicalCountVerified:false`
and `independentWitnessVerified:false`. No setting of those booleans
from this report can make a sellable inventory balance.

## Remaining independent acceptance

Actual staff count sheets, secure staff identity/witness verification,
properly reviewed source-to-Woo product/variation crosswalk,
installed-site Woo/Paystack hook inspection, pending/paid/late-callback
reservation/concurrency testing, trading-ledger off-site backup/restore
and independently documented Owner approval **all remain outstanding**.
The deployed Contabo read-only POS and the live WooCommerce website must
stay unchanged while this code is reviewed.

Tests: `tests/physical-recount-plan.test.js` verifies every source row,
filtering/paging, changes between snapshots, CSV blank fields and formula
neutralization, authentication/roles, only Woo product GET calls and zero
sale writes. A synthetic production-browser test checks task paging,
P0 filter and the **NOT-APPROVED** browser download. None are live stock tests.
