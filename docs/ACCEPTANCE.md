# Staging acceptance checklist

Record **Pass / Fail / Not tested**, date, tester, environment, plugin/app version, and evidence reference. Do not include secrets or customer personal information.

Automated baseline already passing locally: 67 backend/mocked WooCommerce/restore and deployment-safety regression tests, including optional/unnamed Wholesale quote, tax, historical-order compatibility and payment-recovery cases; the isolated Chromium demo walkthrough, lost-prepare-response recovery after reload, session-expiry handling, embedded-preview session fallback when Authorization/cookies are stripped, reduced-motion preference checks, counter/mobile layout and mocked shared-stock/variation/backorder/report checks, axe accessibility scans, lint, receipt PDF content check, production build, dependency audit, preflight, SQLite backup/restore integrity check, and clean Docker image build/smoke in GitHub Actions. The items below must still be executed against the approved staging clone and real hardware.

## Environment and safety

- [ ] Full WordPress files/database backup verified and restoration tested.
- [ ] POS-ledger backup created and integrity checked.
- [ ] Guarded restore tested in an isolated environment; post-restore reconciliation procedure reviewed.
- [ ] Staging is separate from production; email, fulfilment, webhooks, and live payment side effects are controlled.
- [ ] WordPress/WooCommerce/PHP versions and relevant plugins recorded.
- [ ] GHS currency and tax-inclusive/exclusive behavior verified.
- [ ] Live write gate remains disabled during staging.
- [ ] On a shared VPS, the POS has its own service/project, private ledger/volume, HTTPS hostname and localhost-only listener/host port; the existing application still works and its 80/443 bindings are unchanged. A restart after an abrupt exit succeeds, and a second POS using the same ledger is refused.
- [ ] A first owner is configured and changes the temporary password; the bootstrap secret is then removed from the server environment without losing owner sign-in.

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

## Wholesale checkout — separate staging acceptance (not dispatch on credit)

- [ ] Owner explicitly authorized **isolated staging wholesale tests**; `POS_STAGING_WHOLESALE_APPROVED=true` is enabled only on that clone for the tests. Live wholesale remains off.
- [ ] **Wholesale** is a separate owner/manager navigation page; no negotiated-price controls are in the retail register. Goods are available immediately without choosing or creating a buyer. Type an optional name or leave it blank. A cashier cannot open the wholesale workspace or enter/approve a negotiated price; the API also rejects these actions.
- [ ] Add one item, several different items, and a quantity greater than one, with independently agreed tax-inclusive **final unit prices**. No quantity breaks, minimums, or pack rules; a missing/invalid price blocks review. A one-character/invalid buyer name blocks review, but a blank name does not.
- [ ] **Review quote** shows the optional name (or “Not provided”), approver, each quantity/line price and final all-in amount. Explicit owner/manager approval is required before order creation; editing prices or the name clears approval without discarding goods.
- [ ] For both named and unnamed Wholesale sales, the prepared quote, Sales history and printed 58/80 mm receipt show the approver and agreed final amount; a supplied name is shown, but an unnamed receipt has no empty buyer field. Catalogue prices remain unchanged and visible as a reference; no customer-facing total adds tax to the agreement.
- [ ] On the **actual staging WooCommerce version/settings**, inspect the REST order line `subtotal`/`total` (pre-tax), `total_tax`, `tax_lines`, order total and approval metadata. For named orders, verify the entered name in billing/order metadata; for unnamed orders, verify Woo leaves those buyer fields blank rather than supplying a default name. Confirm each line gross equals its agreed unit amount × quantity, including tax where applicable. Confirm WooCommerce has no added fees, coupons or shipping.
- [ ] Verify the **in-store collection** tax location Woo applies both with an optional name and with no name; neither path supplies a shipping/delivery address in this workflow. Test taxable, exempt/zero-rate, and mixed-class goods plus cent-rounding cases; if a different delivery location changes tax, do not use this workflow for that delivery. When Woo cannot reproduce an exact all-in amount, the pending order stays under review and no payment is recorded.
- [ ] Confirm an edited Woo name (including one added to an unnamed order), price, quantity, line tax, payment status or quote metadata is detected **before** payment; an interrupted order-create/reprice/payment response never creates another Woo order or a second external collection.
- [ ] Full cash or externally verified MoMo/card payment is confirmed and recorded, with the merchant/terminal reference as applicable, **before goods leave**. Leaving an order unpaid saves it for review but never authorizes dispatch.
- [ ] The five special dispatch-first/pay-in-one-to-two-weeks customers are **not** enabled by this feature. Their credit workflow requires a future design and separate authorization.
- [ ] Only after documented staging wholesale acceptance and written owner approval, decide whether to enable `POS_LIVE_WHOLESALE_APPROVED=true` alongside the recorded staging gate and existing live safeguards. No live wholesale test uses real customer money.

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
- [ ] Paid retail and wholesale totals/counts are distinguishable; CSV shows a supplied wholesale buyer name (empty for unnamed sales), the approver and agreed final total without exposing spreadsheet formulas. Unpaid or under-review wholesale quotes are excluded from paid reports but visible in Sales history.
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
