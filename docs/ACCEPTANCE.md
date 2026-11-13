# Store acceptance checklist (staging preferred)

Record **Pass / Fail / Not tested**, date, tester, environment, plugin/app version, and evidence reference. Do not include secrets or customer personal information.

Automated baseline: backend/mocked WooCommerce/restore and deployment-safety regression tests include live-read-only pilot config/unit/Woo write guards, optional/unnamed Wholesale quotes, tax, historical-order compatibility and payment-recovery cases; the isolated Chromium demo walkthrough, lost-prepare-response recovery after reload, session-expiry handling, embedded-preview session fallback when Authorization/cookies are stripped, reduced-motion preference checks, counter/mobile layout and mocked shared-stock/variation/backorder/report checks, pilot checkout-lock UI, axe accessibility scans, lint, receipt PDF content check, production build, dependency audit, preflight, SQLite backup/restore integrity check, and Docker image build/smoke in CI. The items below require real store behavior and real hardware, preferably on an approved **separate staging clone**, before general POS trading. If the owner declines staging, follow [LIVE-CASH-ROLLOUT.md](LIVE-CASH-ROLLOUT.md) for a documented, owner-supervised genuine cash sale; record untested cases as **Not tested**, never as Pass. Connecting to the live catalogue in the read-only pilot does not pass these tests. Use the [read-only review worksheet](LIVE-READONLY-REVIEW.md) to record settings evidence before planning any supervised sale.

## Live catalogue pilot only (not permission to trade)

- [ ] `pos.mansutrendzgh.com` resolves to the intended VPS and has a valid HTTPS certificate; the old Next.js app still works and 3187 is loopback-only.
- [ ] New dedicated WooCommerce key has **Read** permission only; canonical `https://mansutrendzgh.com` or approved `www` origin is configured without a redirect. No keys or customer records are included in evidence.
- [ ] `/api/health` reports `mode: live`, `liveReadOnly: true`; owner-only Store connection test loads real products/stock. Diagnostics do **not** read customer orders. Local POS ledger and backups are separate.
- [ ] UI explicitly says live catalogue only; retail/Wholesale checkout, payment recording and cash movements are blocked; no test creates, updates or cancels a real Woo order.
- [ ] Owner acknowledges that no tax/total, stock concurrency, recovery, payment or hardware acceptance has been demonstrated; do not collect money or release goods through this POS. See [CONTABO-LIVE-PILOT.md](CONTABO-LIVE-PILOT.md).

## Environment and safety

- [ ] Full WordPress files/database backup verified and restoration tested.
- [ ] POS-ledger backup created and integrity checked.
- [ ] Guarded restore tested in an isolated environment; post-restore reconciliation procedure reviewed.
- [ ] On staging, it is separate from production and email/fulfilment/webhooks/payments are isolated. If staging was declined, document and accept **all** pending/paid live-order side effects before any controlled real sale; a backup cannot undo emails or fulfilment.
- [ ] WordPress/WooCommerce/PHP versions and relevant plugins recorded.
- [ ] GHS currency and tax-inclusive/exclusive behavior verified.
- [ ] Live write gate remains disabled during staging **and** until the separately reviewed trading deployment and controlled acceptance plan are approved; the catalogue pilot stays read-only.
- [ ] On a shared VPS, the POS has its own service/project, private ledger/volume, HTTPS hostname and localhost-only listener/host port; the existing application still works and its 80/443 bindings are unchanged. A restart after an abrupt exit succeeds, and a second POS using the same ledger is refused.
- [ ] A first owner is configured and changes the temporary password; the bootstrap secret is then removed from the server environment without losing owner sign-in.

## Catalogue and inventory

- [ ] Simple product search and add-to-cart.
- [ ] Variable product size/attribute selection.
- [ ] Existing SKU scan selects the correct product.
- [ ] Variation SKU scan selects the correct variation.
- [ ] Missing/duplicate SKU report reviewed; no unapproved SKU changes.
- [ ] A staging test sale (or a separately approved **genuine** cash sale without staging) creates exactly one WooCommerce order.
- [ ] Correct variation stock decreases by the sold quantity.
- [ ] Record each chosen product/variation's actual Manage stock, quantity and Allow backorders settings. Global Manage stock ON and backorder *notifications* ON do not establish per-option settings or authorize backorders.
- [ ] Record Woo/plugin versions and any order-stock filters. Determine whether a REST-created `mansu-pos` pending order actually reserves units and whether this store auto-cancels it; a 60-minute checkout Hold stock setting alone is not evidence. Verify real effects only on a separately approved clone or during an owner-supervised **genuine** cash sale, never with an unapproved live test order. If it does not expire, establish owner monitoring and safe resolution before another sale.
- [ ] Parent-managed options share one stock pool; independently managed options use their own stock. Combined cart quantities are tested against the real staging responses.
- [ ] Online storefront reflects the updated stock.
- [ ] On staging, an online test order updates stock seen by the POS after refresh; without staging, observe a genuine online order without manufacturing a test purchase.
- [ ] A safeguard shared by online and POS sales, or an owner-approved operational control, prevents simultaneous last-item overselling. Exercise concurrent purchases **only on staging**; without it, document and enforce an operational last-item limit. The POS read-check and order update are not atomic.
- [ ] Cancelled unpaid order and refunded paid order behave as documented.
- [ ] Backorder (`yes` and `notify`) and untracked-stock behavior reviewed; customers are notified where required.

## Archived POS-only In-store collection — NOT the new shared-stock rollout

**Do not execute these historical POS-only acceptance steps for the current business target.** The owner now wants physical goods to share Woo product IDs and stock with online retail; the POS-only In-store cash/count gate is retired outside isolated tests. See [SHARED-WOO-STOCK.md](SHARED-WOO-STOCK.md) for the Woo-backed physical-goods cutover. The archival checklist below does not authorize an import or switching on a deployed service.

- [ ] Review the original PDF/CSV and snapshot hashes: 1,571 report rows, 1,570 matched unique SKUs and one SKU-less row 508. Confirm 28 negative, nine blank/malformed UOM, three fractional-cent prices and the unidentified row are **quarantined**; the other 1,530 eligible goods alone could be imported. Obtain owner-approved two-decimal payable amounts before ever selling SKUs 1469–1471. Do not treat negative stock as zero or round `194.1177` silently.
- [ ] Explicitly confirm physical stock belongs only to this POS, with no other till or online sales of those units; document first-sale counts and an owner-controlled restock/stock-count procedure. Verify the source SHA-256 pin and one-time import into a **separate trading ledger**, never the pilot. Restart without reseeding after a sale or physical count.
- [ ] Record a **distinct** written in-store cash acceptance, receipt/tax compliance, owner-approved business details, off-site private-ledger backup/restore and safe cutover/reversal plan. The pilot and the existing uninstalled trading template both force this gate OFF; changing only an env file must not enable it.
- [ ] On an isolated fixture, missing shift, changed price/total, insufficient cash, zero/negative/quarantined/unknown SKU, attempted browser price/tax/method/Woo override and two cashiers for the last unit are blocked server-side with **no** sale/stock movement.
- [ ] In a supervised **genuine** cash sale after separate approval, count the cash and verify printed 58/80 mm receipt: final all-in GHS lines/total, tender/change, **no itemized tax or zero-tax claim**. One paid local receipt, stock deduction, movement and audit event commit together; online Woo orders, stock and Paystack remain unchanged. Test lost-response recovery by looking up/retrying the **same** key, without retaking cash.
- [ ] Confirm only the owner can correct an already eligible SKU's physical count with reason and expected previous balance, and a recount cannot unlock a quarantined item. Cashiers see only their own in-store receipts; owner/manager CSV/report is separate from Woo Retail/Wholesale. Shared shift expected cash includes both pools once, with the in-store portion visible.
- [ ] Agree how to handle returns/refunds and any legally required tax invoice **before** trading; the in-store collection currently has no return/void/refund operation. Do not issue a Woo refund for a POS-only receipt or restore an old ledger over newer sales.

## Payments

- [ ] Cash sale records amount received and correct change.
- [ ] On **staging only**, MoMo test uses a simulated external reference and explicit confirmation; live POS is cash-only until separately reviewed.
- [ ] On **staging only**, card test uses a simulated terminal reference and explicit confirmation; live POS is cash-only until separately reviewed.
- [ ] On staging, no real customer payment is processed. Without staging, the supervised live cash sale is **genuine**, with counted funds, owner approval and a normal receipt; never take payment merely for a test.
- [ ] Order and report payment labels are correct.
- [ ] Missing external reference and insufficient cash are rejected.
- [ ] Full card numbers/PINs/CVVs are never entered or stored.
- [ ] Staff understand that recording is not processing or proof of settlement.

## Wholesale checkout — separate acceptance (not dispatch on credit)

- [ ] For branch 1.2.3, owner-only private defaults are stored in the separate POS ledger: view/edit/remove from Inventory, mark changed/missing Woo identities for review, confirm staff/cashiers cannot access the private price API and no retail catalogue, public Woo price or order is modified. Owner/manager can review a suggested per-option default and can still negotiate a different final price for that sale; edits require fresh approval. Do not interpret a saved default as authority to turn on Checkout. See [PRIVATE-WHOLESALE-PRICES.md](PRIVATE-WHOLESALE-PRICES.md).

- [ ] On staging, owner explicitly authorized isolated Wholesale tests (`POS_STAGING_WHOLESALE_APPROVED=true` only on that clone). If staging is declined, the owner documents a controlled **real** Wholesale cash-sale plan after Retail checks; the distinct live approval and acceptance-plan reference are needed before any live Wholesale write. A flag is not evidence that testing passed.
- [ ] **Wholesale** is a separate owner/manager navigation page; no negotiated-price controls are in the retail register. Goods are available immediately without choosing or creating a buyer. Type an optional name or leave it blank. A cashier cannot open the wholesale workspace or enter/approve a negotiated price; the API also rejects these actions.
- [ ] Add one item, several different items, and a quantity greater than one, with independently agreed tax-inclusive **final unit prices**. No quantity breaks, minimums, or pack rules; a missing/invalid price blocks review. A one-character/invalid buyer name blocks review, but a blank name does not.
- [ ] **Review quote** shows the optional name (or “Not provided”), approver, each quantity/line price and final all-in amount. Explicit owner/manager approval is required before order creation; editing prices or the name clears approval without discarding goods.
- [ ] For both named and unnamed Wholesale sales, the prepared quote, Sales history and printed 58/80 mm receipt show the approver and agreed final amount; a supplied name is shown, but an unnamed receipt has no empty buyer field. Catalogue prices remain unchanged and visible as a reference; no customer-facing total adds tax to the agreement.
- [ ] On the **actual WooCommerce version/settings** (staging preferred; otherwise owner-supervised genuine sale), inspect the REST order line `subtotal`/`total` (pre-tax), `total_tax`, `tax_lines`, order total and approval metadata. For named orders, verify the entered name in billing/order metadata; for unnamed orders, verify Woo leaves those buyer fields blank rather than supplying a default name. Confirm each line gross equals its agreed unit amount × quantity, including tax where applicable. Confirm WooCommerce has no added fees, coupons or shipping.
- [ ] Verify the **in-store collection** tax location Woo applies both with an optional name and with no name; neither path supplies a shipping/delivery address in this workflow. Test taxable, exempt/zero-rate, and mixed-class goods plus cent-rounding cases; if a different delivery location changes tax, do not use this workflow for that delivery. When Woo cannot reproduce an exact all-in amount, the pending order stays under review and no payment is recorded.
- [ ] On an isolated clone or mocked harness (never deliberately corrupting a real order), confirm an edited Woo name (including one added to an unnamed order), price, quantity, line tax, payment status or quote metadata is detected **before** payment; an interrupted order-create/reprice/payment response never creates another Woo order or a second external collection.
- [ ] Full cash payment (live), or cash / externally verified MoMo/card payment (staging only), is confirmed and recorded **before goods leave**. Leaving an order unpaid saves it for review but never authorizes dispatch.
- [ ] The five special dispatch-first/pay-in-one-to-two-weeks customers are **not** enabled by this feature. Their credit workflow requires a future design and separate authorization.
- [ ] Only with a distinct written owner decision, the existing live write safeguards and a documented controlled live Wholesale acceptance plan/record (`POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE`) consider enabling `POS_LIVE_WHOLESALE_APPROVED=true`. Do **not** copy a staging approval flag into live. Before general staff trading, verify the observed real tax/total, stock and side effects; never use a customer's payment merely as a test.

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
