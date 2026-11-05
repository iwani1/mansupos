# Staging acceptance checklist

Record **Pass / Fail / Not tested**, date, tester, environment, plugin/app version, and evidence reference. Do not include secrets or customer personal information.

Automated baseline already passing in the repository: 41 backend/mocked WooCommerce/restore regression tests, the isolated Chromium demo walkthrough, lost-prepare-response recovery after reload, session-expiry handling, embedded-preview session fallback when Authorization/cookies are stripped, reduced-motion preference checks, counter/mobile layout and mocked shared-stock/variation/backorder/report checks, axe accessibility scans, lint, receipt PDF content check, production build, dependency audit, preflight, SQLite backup/restore integrity check, and clean Docker image build/smoke in GitHub Actions. The items below must still be executed against the approved staging clone and real hardware.

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
