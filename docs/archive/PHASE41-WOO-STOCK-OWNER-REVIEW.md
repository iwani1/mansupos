# Phase 4.1 — Parent-managed Woo variation stock ownership review

**DRAFT / read-only. No live catalogue update, product creation, quantity import, order, refund, payment, deployment or merge.**

Distinct Woo variation IDs do **not** imply independent stock quantities. The installed site may manage two sizes or colours under one parent-owned stock pool. The offline CSV cannot prove that source, even when the exported stock fields or IDs look distinct.

## Aggregate-only review codes

- variation_stock_owner_requires_live_verification: every existing Woo variation proposed in the source-bound crosswalk. Review the real installed Woo stock owner, backorders, reservation and last-unit behaviour.
- possible_shared_parent_managed_stock_pool: once for each additional source row mapped to another variation of the SAME parent. This is a possibility, **not** confirmation that Woo manages this group at the parent.
- orphan_or_invalid_woo_variation_parent: a variation in the offline export has an invalid, missing or non-variable parent, including when that row is not yet mapped.

Reports contain only aggregate blocker counts and bounded source-row indexes; never SKU, names, Woo IDs, private review tokens, prices or per-item quantities. Existing source/export SHA bindings, duplicate identity, held-record and two-person-count-claim checks remain in place. No audit result is a real witnessed count or authenticated Owner approval. No import file is produced.

## Remaining operational checks

1. Obtain an authorized fresh full private Woo product-and-variation export; reconcile its completeness against the real installed site's catalogue.
2. Verify the installed stock OWNER for each parent and variation (including backorders) and reconcile actual physically witnessed sizes/colours without summing an already parent-managed quantity.
3. Reconcile pending online orders, dispatches, returns and reservations with counted stock.
4. Under separate explicit permission, verify last-unit concurrency, Woo/Paystack callbacks, refunds, HPOS, tax and retail pricing in an isolated/staging environment without real customer payments.
5. Require independently verified owner/security approval before any separate stock-write/import proposal.

The production live pilot remains catalogue read-only; all financial, checkout and Woo stock-write gates remain disabled, and lateGatewayGuardVerified remains false. PR #1 stays draft and unmerged.
