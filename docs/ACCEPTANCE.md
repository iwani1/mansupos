# Store acceptance checklist (isolated local tests; live selling locked)

Record **Pass / Fail / Not tested**, date, tester, environment, plugin/app version, and evidence reference. Do not include secrets or customer personal information.

Automated baseline: backend/mocked WooCommerce/restore and deployment-safety regression tests include live-read-only pilot config/unit/Woo write guards, optional/unnamed Wholesale quotes, tax, historical-order compatibility and payment-recovery cases; the isolated Chromium demo walkthrough, lost-prepare-response recovery after reload, session-expiry handling, embedded-preview session fallback when Authorization/cookies are stripped, reduced-motion preference checks, counter/mobile layout and mocked shared-stock/variation/backorder/report checks, pilot checkout-lock UI, axe accessibility scans, lint, receipt PDF content check, production build, dependency audit, preflight, SQLite backup/restore integrity check, and Docker image build/smoke in CI. The owner rejected a separate staging server/clone. Use isolated local databases, simulated Woo and, only if separately authorized and needed, a temporary **local synthetic** Woo installation; independent review of the actual installed Woo/WP/PHP/Paystack hooks, backup identity, hardware and rollback is still necessary. A critical installed behavior unsafe to verify remains a **blocker**, not a test pass or a reason to buy infrastructure. A later controlled genuine sale requires its own explicit approval and cannot be used merely as an experiment with customer orders or stock. Record untested cases as **Not tested**, never Pass. Connecting to the live catalogue in the read-only pilot does not pass these tests. Use the [read-only review worksheet](LIVE-READONLY-REVIEW.md) to record settings evidence before planning any supervised sale.

## Live catalogue pilot only (not permission to trade)

- [ ] `pos.mansutrendzgh.com` resolves to the intended VPS and has a valid HTTPS certificate; the old Next.js app still works and 3187 is loopback-only.
- [ ] New dedicated WooCommerce key has **Read** permission only; canonical `https://mansutrendzgh.com` or approved `www` origin is configured without a redirect. No keys or customer records are included in evidence.
- [ ] `/api/health` reports `mode: live`, `liveReadOnly: true`; owner-only Store connection test loads real products/stock. Diagnostics do **not** read customer orders. Local POS ledger and backups are separate.
- [ ] UI explicitly says live catalogue only; retail/Wholesale checkout, payment recording and cash movements are blocked; no test creates, updates or cancels a real Woo order.
- [ ] Owner acknowledges that no tax/total, stock concurrency, recovery, payment or hardware acceptance has been demonstrated; do not collect money or release goods through this POS. See [CONTABO-LIVE-PILOT.md](CONTABO-LIVE-PILOT.md).

## Environment and safety

**Phase 1 is an isolated draft, not an on-host pass.** The v9 migration/identity, backup manifests, recovery events and unresolved cash-refund boundary are described in [PHASE1-RELIABILITY.md](PHASE1-RELIABILITY.md). Do not run its migration or binding tool on the reported pilot until a separate owner-reviewed maintenance plan and verified backup/restore drill exist.

- [ ] Before any approved v9 upgrade, review the real pilot/trading service identity and unique ledger UUID separately; an existing pre-v9 live ledger requires an unchanged verified backup and explicit stopped-service binding. Do not copy a pilot ledger into trading or silently fix duplicate Woo links/historical references.
- [ ] Confirm the actual ledger's `.db` and `.db.manifest.json` verify together off-host, and an isolated same-ledger restore preserves a **separate safety snapshot** with its own manifest. The repaired restore must refuse **both** active-only newer/changed records **and backup-only deleted/revoked accounts or receipts**. A fresh local restore has no active comparison history: verify that all real users and their old password hashes are disabled, sessions invalidated, startup/preflight locked, and a separately authorized stopped-service offline reset reactivates **only one existing owner** with a new secret. Individually reset/authorize other staff later. Independently review newer Woo-only orders, external payments and actual cash that a local comparison cannot detect.
- [ ] Full WordPress files/database backup verified and restoration tested.
- [ ] POS-ledger backup created and integrity checked.
- [ ] Guarded restore tested in an isolated environment; post-restore reconciliation procedure reviewed.
- [ ] Isolated **local** fixtures contain synthetic orders/accounts/stock only; simulated payment/email/fulfilment/webhooks have **no live egress**. Before any separately approved controlled real sale, document installed hooks/notifications and their side effects read-only; a backup cannot undo emails, payments or fulfilment. Unknown critical effects remain a blocker.
- [ ] WordPress/WooCommerce/PHP versions and relevant plugins recorded.
- [ ] GHS currency and tax-inclusive/exclusive behavior verified.
- [ ] All live write gates remain disabled throughout local testing and until an independently reviewed trading deployment, live plugin installation and controlled acceptance checks have **separate written approvals**; the catalogue pilot stays read-only.
- [ ] On a shared VPS, the POS has its own service/project, private ledger/volume, HTTPS hostname and localhost-only listener/host port; the existing application still works and its 80/443 bindings are unchanged. A restart after an abrupt exit succeeds, and a second POS using the same ledger is refused.
- [ ] A first owner is configured and changes the temporary password; the bootstrap secret is then removed from the server environment without losing owner sign-in.

## Catalogue and inventory

- [ ] Simple product search and add-to-cart.
- [ ] Variable product size/attribute selection.
- [ ] Existing SKU scan selects the correct product.
- [ ] Variation SKU scan selects the correct variation.
- [ ] Missing/duplicate SKU report reviewed; no unapproved SKU changes.
- [ ] A separately authorized **synthetic local Woo** test creates at most one Woo order per attempt. This does not prove installed-shop behavior; any later genuine cash sale requires its own controlled live approval and must not be used as an unapproved stock experiment.
- [ ] Correct variation stock decreases by the sold quantity.
- [ ] Record each chosen product/variation's actual Manage stock, quantity and Allow backorders settings. Global Manage stock ON and backorder *notifications* ON do not establish per-option settings or authorize backorders.
- [ ] Record *installed* Woo/plugin versions and order-stock filters **read-only**. A REST-created `mansu-pos` pending order may not reserve units or auto-cancel; a 60-minute checkout Hold stock setting alone is not evidence. Test proposed online-bridge holds/expiry on temporary local synthetic Woo if authorized, then compare installed hooks. If critical installed behavior cannot safely be verified, keep POS selling disabled. No unapproved live test order.
- [ ] Parent-managed options share one Woo stock-owner pool; independently managed options use their own. Test combined synthetic cart quantities locally; verify installed stock ownership for the actual product/variation IDs without modifying them.
- [ ] Verify online stock presentation through read-only evidence; no live stock update merely to test refresh.
- [ ] If authorized local Woo is available, a synthetic website order changes stock visible to the local POS after refresh; otherwise mark this **Not tested**. Do not manufacture a live purchase.
- [ ] A Woo-side safeguard shared by online and POS sales prevents simultaneous last-item overselling. Exercise concurrent **synthetic local** checkout and POS requests if feasible; review installed gateway/stock-hook compatibility. A fresh POS read and subsequent REST write are not atomic, and an unverified last-unit control is **NO-GO** for shared-stock POS selling.
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
- [ ] On **isolated local fixtures only**, a MoMo reference is simulated; live POS remains cash-only, and external-reference deduplication is not accepted.
- [ ] On **isolated local fixtures only**, a card-terminal reference is simulated; live POS remains cash-only.
- [ ] Local tests process no real customer payment. A later separately approved controlled live cash sale must be **genuine**, with counted funds and a normal receipt; never use a customer payment merely for a test.
- [ ] Order and report payment labels are correct.
- [ ] Missing external reference and insufficient cash are rejected.
- [ ] Full card numbers/PINs/CVVs are never entered or stored.
- [ ] Staff understand that recording is not processing or proof of settlement.

## Wholesale checkout — separate acceptance (not dispatch on credit)

- [ ] For branch 1.2.3, owner-only private defaults are stored in the separate POS ledger: view/edit/remove from Inventory, mark changed/missing Woo identities for review, confirm staff/cashiers cannot access the private price API and no retail catalogue, public Woo price or order is modified. Owner/manager can review a suggested per-option default and can still negotiate a different final price for that sale; edits require fresh approval. Do not interpret a saved default as authority to turn on Checkout. See [PRIVATE-WHOLESALE-PRICES.md](PRIVATE-WHOLESALE-PRICES.md).

- [ ] Wholesale uses isolated local synthetic fixtures for preliminary tests. No staging server is required. A controlled **real** Wholesale sale needs distinct written live approval and an acceptance-plan reference **after** Retail, stock/hook and pricing checks. `POS_STAGING_WHOLESALE_APPROVED` is an old non-live test flag, **not** a shortcut to live approval; a flag does not prove acceptance.
- [ ] **Wholesale** is a separate owner/manager navigation page; no negotiated-price controls are in the retail register. Goods are available immediately without choosing or creating a buyer. Type an optional name or leave it blank. A cashier cannot open the wholesale workspace or enter/approve a negotiated price; the API also rejects these actions.
- [ ] Add one item, several different items, and a quantity greater than one, with independently agreed tax-inclusive **final unit prices**. No quantity breaks, minimums, or pack rules; a missing/invalid price blocks review. A one-character/invalid buyer name blocks review, but a blank name does not.
- [ ] **Review quote** shows the optional name (or “Not provided”), approver, each quantity/line price and final all-in amount. Explicit owner/manager approval is required before order creation; editing prices or the name clears approval without discarding goods.
- [ ] For both named and unnamed Wholesale sales, the prepared quote, Sales history and printed 58/80 mm receipt show the approver and agreed final amount; a supplied name is shown, but an unnamed receipt has no empty buyer field. Catalogue prices remain unchanged and visible as a reference; no customer-facing total adds tax to the agreement.
- [ ] With the **actual WooCommerce version/settings verified read-only** and a temporary local Woo fixture if separately authorized, inspect synthetic REST order line `subtotal`/`total` (pre-tax), `total_tax`, `tax_lines`, order total and approval metadata. Mark installed-site implications **unverified** if they cannot safely be confirmed; do not create a live order experimentally. For named orders, verify the entered name in billing/order metadata; for unnamed orders, verify Woo leaves those buyer fields blank rather than supplying a default name. Confirm each line gross equals its agreed unit amount × quantity, including tax where applicable. Confirm WooCommerce has no added fees, coupons or shipping.
- [ ] Verify the **in-store collection** tax location Woo applies both with an optional name and with no name; neither path supplies a shipping/delivery address in this workflow. Test taxable, exempt/zero-rate, and mixed-class goods plus cent-rounding cases; if a different delivery location changes tax, do not use this workflow for that delivery. When Woo cannot reproduce an exact all-in amount, the pending order stays under review and no payment is recorded.
- [ ] On a temporary **local synthetic Woo fixture** or mocked harness (never deliberately corrupting a real order), confirm an edited Woo name (including one added to an unnamed order), price, quantity, line tax, payment status or quote metadata is detected **before** payment; an interrupted order-create/reprice/payment response never creates another Woo order or a second external collection.
- [ ] Full cash payment (only after separate live approval), or simulated tender on **local fixtures**, is confirmed and recorded **before goods leave**. MoMo/card POS payment is outside the live cash-only scope. Leaving an order unpaid saves it for review but never authorizes dispatch.
- [ ] The five special dispatch-first/pay-in-one-to-two-weeks customers are **not** enabled by this feature. Their credit workflow requires a future design and separate authorization.
- [ ] Only with a distinct written owner decision, the existing live write safeguards and a documented controlled live Wholesale acceptance plan/record (`POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE`) consider enabling `POS_LIVE_WHOLESALE_APPROVED=true`. Do **not** copy a staging approval flag into live. Before general staff trading, verify the observed real tax/total, stock and side effects; never use a customer's payment merely as a test.

## Failure recovery

- [ ] On an **isolated fixture only**, owner/manager recovery queue and sale events identify uncertain creates, payments and observed cash refunds; cashier cannot read them. Walk every paginated queue page, not only the first 200.
- [ ] On an isolated fixture, a remote order with a matching key but wrong cashier/origin, a changed cart/total, missing payment intent/record, an incomplete search or a paid-to-cancelled state does **not** release goods or create another order. Verify actual Woo behavior only under a separately approved acceptance plan.
- [ ] The owner documents who authorizes a cash payout, its physical proof and its shift attribution (including a payout after the original shift closed). Until decided, Woo refund observations update net sales but **not** cash payout evidence; open-shift expected cash counts gross received and closed shifts are frozen. Record this policy as **not decided**, not pass, until explicitly approved.
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
