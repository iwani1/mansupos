# ADR 0001 — WooCommerce owns stock

**Status:** Proposed — becomes Accepted when the owner signs below.
**Date:** 2026-11-17

## Context

The POS specification allows either of two inventory models, as long as one is chosen explicitly:

1. **POS-owned stock.** The POS keeps its own stock ledger, records every movement, pushes changes to WooCommerce through an outbox and learns about online orders from WooCommerce webhooks.
2. **WooCommerce-owned stock.** WooCommerce is the only system that holds and changes stock. The POS checks stock in WooCommerce, creates the order there, and WooCommerce lowers the stock.

Mansutrendz has one shop, one till and few online orders. The POS already works the second way: it reads fresh availability before checkout, creates the order in WooCommerce with a unique idempotency key, takes cash, and reconciles uncertain responses without creating a second order.

## Decision

**WooCommerce is the single owner of stock for every item sold through the POS.**

- Only WooCommerce writes stock levels. The POS never sets or adjusts stock itself.
- Stock adjustments, counts, damaged goods and returns to stock are done in WooCommerce admin.
- The POS keeps a sales ledger (sales, sale events, shifts, cash movements, audit), not a stock ledger.
- The retired POS-only in-store stock pool stays retired; its tables are kept only for history.

## Consequences

Accepted trade-offs:

| Consequence | What it means in practice |
|---|---|
| WooCommerce down means no POS sales | If the website or its API is down, the till cannot sell. Fall back to a paper sales book and enter the sales when WooCommerce is back (see Operations). |
| No POS stock ledger | Stock history lives in WooCommerce (order notes and product stock changes), not in a dedicated POS movement ledger. |
| No webhooks or outbox | Not needed: the POS never has stock changes to push. |
| Last-unit race is narrowed, not closed | The website and the till can both sell the last unit within a second or two. With current volumes this is rare; if it happens, refund or substitute and note it. |

What we gain: one source of truth, no sync code to get wrong, no double deduction, and far less to build and run.

## When to revisit

Reopen this decision, and consider moving to a POS-owned ledger with an outbox and webhooks (roughly 4–8 weeks of work), if any of these become true:

- a second till or second shop;
- online orders become frequent enough that last-unit clashes happen more than occasionally;
- the shop must keep selling while WooCommerce is unavailable;
- an auditor or accountant requires a dedicated stock-movement ledger.

Until then, do not reopen this question for individual features.

## Sign-off

Owner: ______________________ Date: ____________
