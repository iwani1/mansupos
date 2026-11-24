# Phase 3.8 and Phase 4 — Unified WooCommerce inventory readiness

**Status: DRAFT only. No checkout, cash, Woo order/stock mutation, refund, import, merge or Contabo deployment.**

## Technical verification: CI versus the real installed website

The new tests in tests/phase38-shared-inventory-release-locks.test.js assert that the current production live read-only POS pilot does not accept live order-write, wholesale, legacy local-stock cash or online-bridge checkout approvals. The draft WooCommerce bridge still advertises lateGatewayGuardVerified as false. Phase 2 stock audit continues to represent several parent-managed variations as ONE Woo stock pool, not multiple separate quantities.

GitHub unit, lint, Docker, browser and disposable WooCommerce tests provide evidence about draft and isolated fixture behaviour ONLY. They do not establish which WooCommerce and Paystack versions/plugins are actually installed, the real site's HPOS mode, merchant gateway reference/callback mechanics, bank settlement, current Woo last-unit concurrency, return/refund handling or the physical stock owner. Do not mark the real installation verified based on CI alone. Verify these matters independently, using separately authorized credentials, before considering activation. Keep the existing Woo catalogue-only pilot credentials unchanged.

## Historic physical records — NOT live available stock

The source-hash-validated November physical report has **1,571 rows**. There were 1,206 with positive historical quantities, 324 with zero, and 41 quarantined for unresolved identity/count/units/price. These 1,530 previously eligible goods are not automatically sellable from PDF stock. The old reviewed Woo export had 115 parents (114 variable and 1 simple), 366 variations and no exact source SKU matches. The Owner previously stated all 115 parents are distinct from physical stock; a fresh Woo export and item-level review are still necessary to confirm that before creating anything. Lack of matches is not physical identity proof.

The intended end state is ONE shared Woo-managed product, retail-price and inventory authority for website and shop. Per-sale wholesale negotiated prices must never change the website retail price. The legacy POS-only local stock/cash path must stay locked.

## New offline Phase 4 tools

Source: server/shared-woo-cutover-readiness.js
CLI: scripts/assess-shared-woo-cutover.mjs
Tests: tests/shared-woo-cutover-readiness.test.js and tests/shared-woo-cutover-cli.test.js

Run locally with a fresh authorized Woo product CSV export:

    node scripts/assess-shared-woo-cutover.mjs /private/woo-products.csv

Optionally include a PRIVATE owner preparation draft JSON:

    node scripts/assess-shared-woo-cutover.mjs /private/woo-products.csv /private/cutover-evidence.json

The JSON must contain exactly schemaVersion (1), physicalManifestSha256, wooExportSha256, linkDrafts and cycleCounts. Links are either {sourceSku, target:"new_woo_required"} or {sourceSku, target:"existing_woo", wooProductId, wooVariationId, reviewEvidenceId}. An existing simple Woo product has wooVariationId null; an existing variation must match the specified variable parent's actual variation. The reviewEvidenceId is only an opaque UUID token and does NOT prove Owner approval. Counts have {sourceSku, units, countedAt, counterId, witnessId}, with two distinct UUID roles. They are claims, not independently authenticated count sheets. The private draft file must be owner-only (mode 0600 on Linux/macOS) and may not be a symlink.

The CLI reads files only, validates SHA-256 bindings, and emits only aggregate issue counts and bounded row-index examples. It neither produces an import-ready CSV nor stores private Woo names, SKUs, prices, metadata, physical per-item quantities or approval IDs in the report. It rejects malformed/duplicated links and count drafts, invalid Woo ID and parent/variation mappings, unknown source identities, wrong source hashes and unexpectedly added private fields. Quarantined source rows stay blocked; missing, stale or conflicting counts are flagged for independent investigation. The current 24-hour recency heuristic is a review suggestion, not an Owner-approved operational SLA. Any Woo SKU collision requires identity review, not name or price matching.

All results permanently state that real Woo stock ownership, physical count authenticity, Owner identity approval, catalogue freshness, last-unit concurrency, retail-tax approval, cashier custody and late gateway guard are UNVERIFIED. Product creation, import, stock adjustment, cash checkout and refund authorization remain FALSE even if the offline report has zero identified issue codes.

## Phase 4.1 — Offline variation stock-owner ambiguity gate

The assessment now flags orphaned Woo variations, requires installed-site owner review for every existing variation link, and flags multiple mapped variations of one parent as a **possible single shared managed-stock pool**. This is not a quantity to sum, an assertion of shared stock, or a release approval. See [Phase 4.1 stock-owner review](PHASE41-WOO-STOCK-OWNER-REVIEW.md).

## Phase 4.2 — Offline discrepancy and owner-review drafts

The aggregate report also groups outstanding problems into P0/P1 review queues. An optional third private, source/recount/export hash-bound JSON records only provisional review statuses for previously detected issues; there is no approved state, no second ledger, no per-item data in output, and no Woo write path. See [Phase 4.2 review workflow](PHASE42-OWNER-INVENTORY-REVIEW.md).

## Phase 4.3 — Second independent recount claim review

The same offline command accepts an optional FOURTH private source-bound file, after the existing private crosswalk/count draft and owner review draft. It compares a separately entered second count to the original first count, detects missing/stale/different counts and reused synthetic counter roles, and emits only aggregate results. No second live stock authority or import/export file is created. Even an apparent match does not verify staff identity, actual counted stock or checkout safety. See [Phase 4.3 recount claims](PHASE43-SECOND-RECOUNT-CLAIMS.md).

## Manual reconciliation work before any cutover

1. Recount all actual physical units by SKU, size and colour, with independent witness; resolve all 41 held records.
2. Obtain a fresh private Woo export. For every source SKU identify an actually existing simple/variation or a genuinely new Woo identity; verify the historic 115 existing parents are distinct, and treat duplicate or blank size codes as holds.
3. Identify the actual Woo parent/variation stock OWNER before aggregation. Never sum child displays when several sizes share one parent-managed pool.
4. Reconcile real pending/paid website orders, returns, dispatched goods, damaged items and reservations against the independently witnessed physical count.
5. Obtain Owner approval of real retail website product content and GHS tax-inclusive price. Wholesale is one-sale negotiated pricing only.
6. Independently test the installed site's Woo stock-owner, Woo/Paystack late callback, concurrent last-unit order, refund and return safeguards in an explicitly approved safe environment; do not use a live customer payment for testing.
7. Only after separate Owner/security acceptance should a distinct reviewed product/variation crosswalk, staging import proposal, stock adjustments and actual website/store shared-stock activation be considered.

**Release status:** PR #1 remains draft/unmerged; no new live Woo, POS, Paystack, inventory, finance, checkout or Contabo change. lateGatewayGuardVerified remains FALSE.
