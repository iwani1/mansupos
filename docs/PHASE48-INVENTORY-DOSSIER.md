# Phase 4.8 — Owner Pre-launch Inventory Evidence Dossier

**STATUS: DEVELOPMENT ONLY — DRAFT PR #1, NO CONTABO DEPLOYMENT.**
Checkout, Woo stock writes, payments and stock import remain locked.

## Purpose and access

Inside **Stock Safety Review → Compare product codes → Inventory
investigation dossier**, the Owner can combine **existing source evidence**
in one read-only product review list:

- Historical physical stock row and SKU classification.
- Owner-proposed WooCommerce product / variation ID (proposal only).
- First and second employee count CLAIM states without disclosure of
  individual claimed quantities, counter identifiers, customer information
  or confidential prices.
- Owner follow-up status and whether a new count made an earlier investigation
  stale.
- Next recommended manual review step and outstanding evidence blockers.

The dossier assigns each row ONE primary review focus (identity hold,
mapping proposal missing, owner investigation, SKU difference, first/second
count missing, count disagreement, or agreeing-unwitnessed declarations).
Other unresolved gaps remain listed as evidence blockers. Every record
remains **not approved for trading**.

## GET-only API

`GET /api/stock-safety/inventory-dossier` requires an authenticated **Owner**
and live read-only pilot mode. Cashier, Manager and anonymous clients
cannot access it. Query accepts only: `page` 1–10,000, `pageSize` 1–50,
`focus` from the documented review categories, `search` up to 64
characters, and optional 64-hex `expectedRef`.

The request samples the signed physical source and ONE published Woo product
catalogue GET observation; it reads owner mapping proposal history and
staff count-claim history from the existing local SQLite audit journal.
An internal trusted collector collects all rows from each existing review
service once; the public API emits only the requested page. It checks
row count and exact report-row/SKU correspondence across evidence streams.
Duplicate or mismatched row identity fails closed (HTTP 409).

A `dossierRef` SHA256 binds the physical source, mapped Woo option
identity, current count identity, latest owner mapping notes, count
claim stages and follow-up event IDs. Refreshing Woo product GETs without
a change of product identity does not invalidate that reference.
A changed source/product, staff count stage, or owner review note changes
it; next-page requests with old `expectedRef` fail HTTP 409 and must
restart at page one. The API adds `Cache-Control: no-store`.

Owner may locally download only the CURRENT visible page in a browser-generated
CSV named `MansuPOS-inventory-evidence-page-N-NOT-APPROVED.csv`.
It contains report row, SKU, current review focus, proposed Woo ID (if any),
count stage, issue flags, and dossier checksum. It does **not** contain
individual counted quantities, names, customers, credentials or financial
amounts. Formula-like SKU values are neutralized before spreadsheet import.
The download is disabled when source validation fails, and remains
a PRIVATE INVESTIGATION FILE, not a stock-import format.

## Explicitly unverified / not authorized

Every response has the non-negotiable flags:
`auditOnly:true`,
`ownerApproved:false`,
`independentWitnessVerified:false`,
`mappingApproved:false`,
`sharedStockVerified:false`,
`stockImportAuthorized:false`, and
`checkoutAuthorized:false`.

The dossier never verifies correct garment style/colour/size,
authenticated human witnessing, approved identity crosswalk, physically
available stock, Woo reservation/Paystack callbacks, pending orders,
offsite recovery or production acceptance. Even if the dossier returns
zero unresolved *review* issues, it must not be used to accept payments,
deduct Woo stock, dispatch goods, unlock checkout, or publish an inventory
migration.

Future necessary gates remain: two independently supervised physical counts,
owner-reviewed variation identity signoff under separate approval,
installed Woo/Paystack callback and last-unit concurrency verification,
offsite backup/recovery testing and independently approved trading rollout.

## Verification

- `tests/inventory-evidence-dossier.test.js`: pure+SQLite synthesis, source
  partition, owner proposal/count changes, snapshot consistency, filters,
  confidential amount exclusion and CSV formula neutralization.
- `tests/inventory-evidence-dossier-app.test.js`: authenticated full Express
  API with synthetic Woo GET-only connector, no sale/stock writes, role
  enforcement and HTTP 409 on stale dossier pages.
- `tests/browser-live-pilot.mjs`: synthetic owner dashboard, paged filtering,
  private NOT-APPROVED CSV download, GET-only observation and absence of
  checkout approval controls.

Keep the development pull request in **DRAFT, UNMERGED**. Per owner request,
continue building features in GitHub before requesting any deployment.
Existing live Contabo read-only POS remains at user-confirmed `8d1117fc`.
