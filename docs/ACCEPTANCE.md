# Staging acceptance checklist

Record **Pass / Fail / Not tested**, date, tester, environment, plugin/app version, and evidence reference. Do not include secrets or customer personal information.

Automated baseline already passing in the repository: 56 backend/mocked WooCommerce/restore regression tests, including paid-trade quote, tax and payment-recovery cases; the isolated Chromium demo walkthrough, lost-prepare-response recovery after reload, session-expiry handling, embedded-preview session fallback when Authorization/cookies are stripped, reduced-motion preference checks, counter/mobile layout and mocked shared-stock/variation/backorder/report checks, axe accessibility scans, lint, receipt PDF content check, production build, dependency audit, preflight, SQLite backup/restore integrity check, and clean Docker image build/smoke in GitHub Actions. The items below must still be executed against the approved staging clone and real hardware.

## Environment and safety

- [ ] Full WordPress files/database backup verified and restoration tested.
- [ ] POS-ledger backup created and integrity checked.
- [ ] Guarded restore tested in an isolated environment; post-restore reconciliation procedure reviewed.
- [ ] Staging is separate from production; email, fulfilment, webhooks, and live payment side effects are controlled.
- [ ] WordPress/WooCommerce/PHP versions and relevant plugins recorded.
- [ ] GHS currency and tax-inclusive/exclusive behavior verified.
- [ ] Live write gate remains disabled during staging.

## Catalogue and inventory

- [ ] Simple product search and add-to-cart.
- [ ] Variable product size/attribute selection.
- [ ] Existing SKU scan selects the correct product.
- [ ] Variation SKU scan selects the correct variation.
- [ ] Missing/duplicate SKU report reviewed; no unapproved SKU changes.
- [ ] POS test sale creates exactly one WooCommerce order.
- [ ] Correct variation stock decreases by the sold quantity.
- [ ] Parent-managed options share one stock pool; independently managed options use their own stock. Combined cart quantities are tested against the real staging responses.
- [ ] Online storefront reflects the updated stock.
- [ ] Online test order updates stock seen by the POS after refresh.
- [ ] A safeguard shared by online and POS sales, or an owner-approved operational control, prevents simultaneous last-item overselling. Exercise concurrent purchases on staging; the POS read-check and order update are not atomic.
- [ ] Cancelled unpaid order and refunded paid order behave as documented.
- [ ] Backorder (`yes` and `notify`) and untracked-stock behavior reviewed; customers are notified where required.

## Payments

- [ ] Cash sale records amount received and correct change.
- [ ] MoMo test uses a simulated external reference and explicit confirmation.
- [ ] Card test uses a simulated terminal reference and explicit confirmation.
- [ ] No real customer payment is processed.
- [ ] Order and report payment labels are correct.
- [ ] Missing external reference and insufficient cash are rejected.
- [ ] Full card numbers/PINs/CVVs are never entered or stored.
- [ ] Staff understand that recording is not processing or proof of settlement.

## Paid trade checkout — separate staging acceptance (not dispatch on credit)

- [ ] Owner explicitly authorized **isolated staging trade tests**; `POS_STAGING_TRADE_APPROVED=true` is enabled only on that clone for the tests. Live trade remains off.
- [ ] An owner and a manager can create/select a named buyer and approve negotiated tax-inclusive **final unit prices**, independently for each product/option and order. A cashier cannot create a buyer or enter/approve a trade price.
- [ ] One item, several different items, and a quantity greater than one all use the individually agreed unit prices with **no quantity breaks, minimums, or pack rules**; an invalid/missing price or approval blocks checkout.
- [ ] The register, prepared quote, Sales history, and printed 58/80 mm receipt show the named buyer, approver and agreed final amount. Catalogue prices remain unchanged and visible as a reference; no customer-facing total adds tax to the agreement.
- [ ] On the **actual staging WooCommerce version/settings**, inspect the REST order line `subtotal`/`total` (pre-tax), `total_tax`, `tax_lines`, order total and billing/buyer/approval metadata. Confirm each line gross equals its agreed unit amount × quantity, including tax where applicable. Confirm WooCommerce has no added fees, coupons or shipping.
- [ ] Verify the **in-store collection** tax location Woo applies when the trade buyer has a name but no shipping/billing address in this workflow. Test taxable, exempt/zero-rate, and mixed-class goods plus cent-rounding cases; if a different delivery location changes tax, do not use this workflow for that delivery. When Woo cannot reproduce an exact all-in amount, the pending order stays under review and no payment is recorded.
- [ ] Confirm an edited Woo buyer, price, quantity, line tax, payment status or quote metadata is detected **before** payment; an interrupted order-create/reprice/payment response never creates another Woo order or a second external collection.
- [ ] Full cash or externally verified MoMo/card payment is confirmed and recorded, with the merchant/terminal reference as applicable, **before goods leave**. Leaving an order unpaid saves it for review but never authorizes dispatch.
- [ ] The five special dispatch-first/pay-in-one-to-two-weeks customers are **not** enabled by this feature. Their credit workflow requires a future design and separate authorization.
- [ ] Only after documented staging trade acceptance and written owner approval, decide whether to enable `POS_LIVE_TRADE_APPROVED=true` alongside the recorded staging gate and existing live safeguards. No live trade test uses real customer money.

## Failure recovery

- [ ] Duplicate submit does not create a second order.
- [ ] Interrupted order creation moves to reconciliation, not automatic retry.
- [ ] Interrupted payment confirmation reconciles to the existing order.
- [ ] Unknown order state blocks a replacement sale until owner verification.
- [ ] Network loss disables checkout and does not queue a payment.

## Hardware

Observed hardware profile: [HARDWARE.md](HARDWARE.md). Identification from photos is not a physical pass.

- [ ] Actual scanner model, keyboard mode, and Enter suffix tested.
- [ ] Xprinter XP-80T driver, 80 mm paper width, alignment, readability, and cutting tested.
- [ ] 58 mm / 80 mm / A4 selection tested as applicable.
- [ ] Cash drawer explicitly marked unsupported unless driver-triggered drawer kick is separately tested and accepted.
- [ ] Customer display explicitly marked unsupported unless separately implemented and tested.
- [ ] Actual standalone card terminal reference workflow verified with the acquirer.

## Reports and staff

- [ ] Daily totals, payment mix, top products, and selected-period CSV export demonstrated.
- [ ] Paid retail and paid trade totals/counts are distinguishable; CSV identifies each trade buyer, approver and agreed final total without exposing spreadsheet formulas. Unpaid or under-review trade quotes are excluded from paid reports but visible in Sales history.
- [ ] Refund reconciliation updates net totals.
- [ ] Reports clearly distinguish POS records from all online-store sales.
- [ ] Named cashier account cannot access staff, connection settings, or other cashiers’ sales.
- [ ] Manager report access and owner-only management verified.
- [ ] Password change, forced temporary-password change, account lockout, and account deactivation tested.
- [ ] Shift open, cash in/out, pending-sale close block, counted close, and variance tested.
- [ ] Audit log and connection diagnostics reviewed.
- [ ] No shared administrator account is used at the counter.

## Handover and approval

- [ ] Receipt business details verified by owner; no invented address/tax number.
- [ ] Opening POS, searching/scanning, recording payment, printing, and day-end reporting demonstrated.
- [ ] Backup location/date and rollback/reconciliation procedure documented.
- [ ] Limitations and any optional costs disclosed.
- [ ] Owner signs the implementation plan and approves live deployment in writing.
