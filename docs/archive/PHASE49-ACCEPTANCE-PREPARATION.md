# Phase 4.9 — Inventory Acceptance Preparation (DRAFT ONLY)

**NO CONTABO DEPLOYMENT · NO STOCK IMPORT · NO TRADING APPROVAL**

This phase adds an owner-only, non-executing **acceptance-preparation
checklist** following Phase 4.8's evidence dossier. It is a gap register, not
a certificate or an independent source of physical stock truth.

## What the owner sees

Go to **Stock safety review → Compare product codes → Inventory acceptance
preparation — missing evidence**. A single report synthesizes the EXISTING
signed historical physical source, local Owner Woo product/variation proposals,
and the first/second employee count CLAIM status. It shows:

- Source identity: either held/ambiguous or historically observed, both still
  requiring separate identity validation.
- Owner-proposed Woo option: missing or **recorded, unverified**. A proposal
  is not a signed SKU/size/colour crosswalk.
- Two count declarations: absent/incomplete, disagreeing, or **matching but
  still unwitnessed**.
- Independent physical witness: ALWAYS not verified in this phase.
- Formal Owner product-mapping signoff: ALWAYS not authorized.
- Installed Woo shared-stock reservations and payment callback safety: ALWAYS
  not verified.

A global list separately calls out signed current stock counts/witness
identity, independently accepted variant crosswalk, installed Woo stock owner
and last-unit races, pending/late Paystack/payment effects and refunds, and
off-site backup recovery/trading acceptance. Staff declarations, matching
SKUs and owner mapping notes **never close** these gates.

Counts shown in the summary are **observed historic/local events only**:
historical source records, identity holds, unapproved owner proposals, and
matching employee declarations. Zero products are shown as independently
witnessed, formally mapped/approved or authorized for stock import.
No individual employee count units, staff actors, costs, customer information,
payment records or stock balances are exposed.

## Protected GET-only API

`GET /api/stock-safety/acceptance-preparation` is Owner-only, valid only in
`POS_MODE=live` with `POS_LIVE_READ_ONLY=true`.

Accepted query: `page` 1..10,000, `pageSize` 1..50,
`gate` an explicitly documented checklist gate or `all`, `search`
up to 64 characters, and optional 64-character lowercase `expectedRef`.
Unknown fields, invalid filters and oversized pages are rejected.

It uses a single authenticated Woo published-products-only GET snapshot
and existing append-only local POS audit evidence. It calculates a complete
server-side preparation report, returns only the requested bounded page,
and hashes the inherited dossier evidence + row-level gap states as
`preparationRef`. New owner mapping notes, staff counting events or changed
SKU/variation identities invalidate a snapshot. An old `expectedRef`
returns HTTP 409 `ACCEPTANCE_PREPARATION_CHANGED`. A harmless Woo cache
timestamp refresh with identical identities does not invalidate it.
`Cache-Control: no-store` applies.

All response gates remain:
`auditOnly:true`, `ownerApproved:false`,
`mappingApproved:false`, `independentWitnessVerified:false`,
`sharedStockVerified:false`, `stockImportAuthorized:false`,
`checkoutAuthorized:false` and
`acceptanceCertificateIssued:false`.
Per-row `approved`, `readyForInventoryImport` and `readyForCheckout`
are always false. No UI checkbox can set these to true.

No POST route, schema migration, Woo write, POS sales/payment event, receipt,
stock deduction or source modification is introduced in this phase.

## Verification and limitations

- `tests/inventory-acceptance-preparation.test.js`: summary counts,
  distinction between recorded/unverified evidence and actual acceptance,
  source failures, filters, snapshot changes, no confidential stock counts.
- `tests/inventory-evidence-dossier-app.test.js`: real isolated application
  authentication, Owner role, GET-only pilot, snapshot conflicts, unimplemented
  approval POST and zero Woo stock/payment/order writes.
- `tests/browser-live-pilot.mjs`: simulated owner acceptance dashboard,
  read-only paging and filters with no approval controls.

This is a prerequisite planning aid only; it does not itself prove a real
count, witness, authoritative Woo variation stock, integrated payments, or
live checkout. Continue development in GitHub PR #1 **DRAFT/UNMERGED** per
the owner's request. Live Contabo read-only POS `8d1117fc` stays unchanged.
