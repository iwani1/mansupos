# MansuPOS: cross-channel SKU matching (read-only pilot)

## Goal
Help the owner identify which items in the verified **historical physical-store
PDF/CSV stock export** have an exact SKU identity counterpart in the **published
WooCommerce product catalogue**. This is the first identity-mapping step toward
one Woo-backed inventory, **not** synchronization and **not** a checkout release.

Navigate to **Catalogue → Stock safety review → Compare product codes**.
Only owner/manager may call `GET /api/stock-safety/source-match`.
This API is available only when the live POS is in read-only mode.
The action reads and validates the pinned physical CSV/PDF manifest and refreshes
published WooCommerce products/variations using GET only. It does **not**
read Woo orders, create orders, decrement quantities, collect cash, or allocate
offline stock.

## Counting rules
- A physical row marked `review` is quarantined and cannot become a match.
  Missing physical SKUs cannot match. Physical SKUs that normalize to the same
  trimmed uppercase string are ambiguous.
- An exact, case-insensitive SKU match to one **simple product** or one
  **variable-product variation** is a *candidate identity*. Variable parent
  SKU is **never** treated as a variation SKU or an inventory pool.
- A SKU repeated across multiple Woo options is ambiguous, never a match.
  Variation SKUs that are absent are counted separately.
- The report counts unmatched SKUs on each side. Unpublished Woo items are not
  included, so an unmatched SKU is **not** proof the product does not exist.
- The response contains counts and up to 20 identifier-only examples, at most
  two per issue type. It never returns product names, customer data or prices.
- A stale/partial Woo snapshot or missing physical hash marks
  `evidenceVerified=false`. Even when this is true and all SKUs match,
  `sharedStockVerified` and `checkoutAuthorized` remain **false**.

## Owner review workflow
1. Review quarantined physical items and physically recount; the PDF/CSV
   quantities are historical, not available-for-sale stock.
2. Check Woo products and each size/colour variation for unique, stable SKUs.
   **Do not** automatically copy a parent SKU onto multiple variations.
3. Resolve duplicate, missing and cross-channel unmatched identifiers using
   the actual product/variation identity, not a fuzzy name-based match.
4. Decide which platform owns the shared stock (WooCommerce is the proposed
   authority). A matching code **does not** merge two stock pools.
5. For future selling, separately verify an atomic Woo reservation bridge,
   real Woo/Paystack plugin interactions, last-unit website/POS concurrency,
   expiry/late-payment refunds, recovery procedures, and written owner approval
   on a **separate trading service**. Do not unlock this read-only pilot.

## Regression coverage
`tests/cross-channel-sku-audit.test.js` verifies exact simple/variation
matching, duplicate ambiguity, quarantined rows, missing variations, bounded
examples, stale/invalid sources, owner/manager permissions, cashier/public
denials, Woo product-GET-only access, and zero sale/stock writes.

This work changes no database schema, POS ledger identity, Woo installation,
price or cash handling, and the PR stays draft until separately accepted.
