# Architecture and integration boundaries

## Stack

- React + Vite frontend.
- Node.js 22 / Express backend.
- SQLite (`node:sqlite`) for sessions, staff, local sale ledger, audit events, shifts/cash movements, demo stock, catalogue cache, and schema migrations.
- WooCommerce REST API v3 for authenticated catalogue reads and order creation/updates.
- No WordPress plugin or theme modification is required.

## Source of truth

WooCommerce owns the live product catalogue, prices, taxes, stock, and orders. The POS keeps a read cache for display, but checkout fetches fresh product/variation availability. Variations reporting parent-managed stock share a single quantity in cart validation; independently managed variations remain separate. Unknown stock ownership or a missing required quantity fails closed. Both WooCommerce backorder policies are recognized; the register prompts staff to notify the customer for `notify` (it does not send a notification). The browser never receives WooCommerce credentials and never chooses the authoritative live total.

Demo mode is separate. It uses a small public-product snapshot, illustrative local images, sample stock, and a local demo ledger. It never calls the WooCommerce write adapter.

## Checkout sequence

1. Browser submits product IDs, variation IDs, quantities, a note, and a UUID idempotency key.
2. Server authenticates the staff session and checks the environment write gate.
3. Server fetches fresh WooCommerce product/variation data and validates availability.
4. Server creates a **pending** WooCommerce order with line item IDs/quantities, not browser prices.
5. WooCommerce returns the authoritative total and tax. The POS displays that amount.
6. Cash is counted, or MoMo/Card collection is verified externally.
7. Staff explicitly confirms the payment record and supplies a reference where required.
8. Server re-fetches availability, then updates the existing WooCommerce order with `set_paid: true`, the configured fulfilment status, and a manual POS payment-method label.
9. WooCommerce performs its normal paid-order stock reduction. The POS does not overwrite stock quantities.
10. The local ledger stores the confirmed order and receipt details.

`payment_method` values are `pos_cash`, `pos_momo`, and `pos_card`. These are recording labels, not payment-gateway integrations. Confirm WooCommerce report compatibility during staging acceptance.

## Failure handling

- A local unique idempotency key prevents repeated preparation of the same cart from creating another order.
- The key is also stored as WooCommerce order meta `_mansu_pos_key`.
- An uncertain create response moves the sale to `needs_reconciliation`; the app does not automatically retry order creation.
- Reconciliation first checks the known order ID, otherwise searches recent orders for the exact meta key.
- Payment intent is persisted before the remote confirmation request. A lost response can be reconciled against the existing order.
- If no matching order is found, the sale remains blocked for owner verification. The recent-order search is bounded and is not proof of absence across all history.
- Paid-order refunds are handled in WooCommerce and reconciled into net reports.
- A periodic read-only reconciliation sweep checks pending/interrupted sales and older paid sales for remote changes. It never creates orders or records payments automatically.
- Shifts gate checkout in staging/live by default. Cash movements and counted closes produce expected-cash and variance records.

This design reduces duplicate-order risk but cannot replace staging tests or owner reconciliation procedures. **The availability read and paid-order update are separate operations; the POS does not provide an atomic stock reservation across online and POS channels.** Concurrent sales can race between those operations. Before live trading, establish and verify a WooCommerce-side safeguard shared by both channels or an owner-approved operational control that prevents last-item overselling. Test it on staging; a passing sequential stock check is not proof of concurrency safety.

## Security

- WooCommerce credentials stay in server environment variables.
- Passwords use salted scrypt hashes, a password policy, forced temporary-password change, and temporary account lockout after repeated failures. Sessions use random tokens, store only token hashes, expire after eight hours, and idle out after a configurable period.
- Session cookies are HTTP-only and SameSite=Strict; the browser also keeps a bearer token in memory so embedded previews do not depend on third-party cookies. Tokens are not written to localStorage.
- Mutating requests require JSON and same-origin checks. Login is rate-limited.
- Owner/manager/cashier permissions are enforced by the API, not just hidden in the UI.
- Cashiers can view only their own sales. Staff/connection management is owner-only. Reports are owner/manager-only.
- API errors are sanitized before returning to the browser.
- CSV cells are escaped to reduce spreadsheet-formula injection.
- The production frontend uses a restrictive Content Security Policy and locally bundled fonts.

## Deliberate exclusions

No direct MoMo/card processing, offline checkout, automatic SKU generation, bulk stock edits, cash-drawer triggering, refund issuance, customer-data import, or multi-instance synchronization is implemented. These require separate approval/design and testing.
