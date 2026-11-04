# Staging acceptance checklist

Record **Pass / Fail / Not tested**, date, tester, environment, plugin/app version, and evidence reference. Do not include secrets or customer personal information.

Automated baseline already passing in the repository: 30 backend/mocked WooCommerce/restore regression tests, the Chromium demo walkthrough, lost-prepare-response recovery after reload, session-expiry handling, reduced-motion preference checks, axe accessibility scans, lint, receipt PDF content check, production build, dependency audit, preflight, SQLite backup/restore integrity check, and clean Docker image build/smoke in GitHub Actions. The items below must still be executed against the approved staging clone and real hardware.

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
- [ ] Online storefront reflects the updated stock.
- [ ] Online test order updates stock seen by the POS after refresh.
- [ ] Simultaneous online/POS purchase of the last item does not silently oversell.
- [ ] Cancelled unpaid order and refunded paid order behave as documented.
- [ ] Backorder and untracked-stock behavior reviewed.

## Payments

- [ ] Cash sale records amount received and correct change.
- [ ] MoMo test uses a simulated external reference and explicit confirmation.
- [ ] Card test uses a simulated terminal reference and explicit confirmation.
- [ ] No real customer payment is processed.
- [ ] Order and report payment labels are correct.
- [ ] Missing external reference and insufficient cash are rejected.
- [ ] Full card numbers/PINs/CVVs are never entered or stored.
- [ ] Staff understand that recording is not processing or proof of settlement.

## Failure recovery

- [ ] Duplicate submit does not create a second order.
- [ ] Interrupted order creation moves to reconciliation, not automatic retry.
- [ ] Interrupted payment confirmation reconciles to the existing order.
- [ ] Unknown order state blocks a replacement sale until owner verification.
- [ ] Network loss disables checkout and does not queue a payment.

## Hardware

- [ ] Actual scanner model, keyboard mode, and Enter suffix tested.
- [ ] Actual printer model, paper width, alignment, readability, and cutting tested.
- [ ] 58 mm / 80 mm / A4 selection tested as applicable.
- [ ] Cash drawer explicitly marked unsupported unless separately implemented and tested.
- [ ] Actual standalone card terminal reference workflow verified with the acquirer.

## Reports and staff

- [ ] Daily totals, payment mix, top products, and selected-period CSV export demonstrated.
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
