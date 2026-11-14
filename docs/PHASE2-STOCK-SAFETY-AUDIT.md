# Phase 2 — read-only shared Woo stock audit (code-only development)

**Status:** Review-only source change, not installed on Contabo or WordPress. It does not authorize checkout or a new service. Base commit is the existing redesigned live pilot `562f5af`; keep `POS_LIVE_READ_ONLY=true` and all live write gates OFF. No new POS database, port, site or Woo credentials are needed for this audit.

## Owner's Phase 2 decision

- **Owner and Manager** may inspect stock-safety findings and uncertain POS orders, and may ultimately approve a separately designed cash-refund/reconciliation workflow.
- **Cashier** may not approve a refund, modify a disputed-order decision or view the privileged recovery queue.
- Approval rights do **not** mean that a Woo refund equals cash paid out, or that observing a pending/paid order resolves physical custody. No cash-refund approval, cash payout, stock restock or order resolution write endpoint is introduced by this milestone; it needs a separately reviewed evidence and shift-accounting model before implementation.
- Reviewers must retain original Woo order references, cash/shift evidence and audit history. Never restore old SQLite snapshots to remove an uncertain trade.

## First deliverable: read-only stock risk evidence

`GET /api/stock-safety/audit` requires a signed-in **Owner or Manager**, forces a Woo product/variation catalogue refresh through the existing catalogue reader, and returns aggregated findings with at most 20 example product/variation IDs. It has no order reads, Woo writes, custom stock balance or reservation method. It does not disclose product names, prices, wholesale defaults, customer details or credentials in the audit response. Its catalogue cache refresh has the same *local SQLite* effect as the existing `/api/catalog?refresh=1` endpoint; no sale/audit event is created.

The pure analyzer `server/phase2-stock-audit.js` identifies, among others:

- Incomplete, unsupported, stale or demo catalogues and failed refreshes.
- Untracked/unknown stock ownership, unmanaged parent variations, backorders, missing quantities, duplicate identities and conflicting shared stock pools.
- Parent-managed variation pools counted **once** (three sizes sharing a parent stock of two remain **one** stock pool of two, not six units).

Every response includes `checkoutAuthorized: false` and `sharedLastUnitGuardVerified: false`, **even if the reported issue count is zero**. A Woo catalogue fetch is only a snapshot. This code does not make a stock reservation, inspect online gateway callbacks or certify the installed Woo checkout hooks.

## Owner/Manager stock safety screen

The existing workspace now includes **Catalogue → Stock safety review** for live POS Owner and Manager accounts. It reads `GET /api/stock-safety/audit` when opened or explicitly refreshed, displays the snapshot age, distinct tracked stock pools, issue categories and up to 20 product/variation identifiers, and provides no button to sell, reserve, edit stock or approve refunds. Its warning explicitly remains visible when there are **zero audit findings**. A synthetic browser regression uses the isolated demo server with a mocked live-pilot session and mocked GET response; no live website or order is accessed.

## Native Woo late-website-payment guard prototype — still NOT live accepted

The earlier pinned WooCommerce 11.0.1/MySQL test **reproduced** a real native order oversell: a website order's hold expired, POS sold the last unit, and a late website `payment_complete()` deducted stock from 0 to **−1**. This was a deliberately synthetic local test, not a store incident.

The uninstalled Woo bridge now includes a **fail-closed native Woo hook prototype** for checkout-created website orders while the bridge is enabled:

- `woocommerce_pre_payment_complete` verifies the website order's original Woo stock-owner holds and at least 30 seconds of remaining validity. When absent/expired, it refuses native payment completion, adds an order note and a `_mansu_website_stock_review=required` marker, and moves the disputed order to **on-hold**. This prevents the tested Paystack webhook from repeatedly generating success notes for a pending order. No gateway money is automatically voided or refunded; Owner/Manager reconciliation is mandatory.
- `woocommerce_can_reduce_order_stock` rejects an unverified website order's stock reduction, including Woo's direct status-transition stock hook.
- `woocommerce_order_status_changed` moves unverified *direct* processing/completed transitions to **on-hold** review. It checks per-line `_reduced_stock` evidence instead of blindly trusting Woo's order-level `stock_reduced` flag: Woo core may set that order-level flag even when a plugin denies physical item reductions.
- A **request-local**, never persisted payment-complete hold check prevents a properly held website order from being falsely quarantined after Woo's own payment pipeline releases the reservation.

The ephemeral real Woo/MySQL test exercises an ordinary held website payment, both opposite orderings of expired website callback vs POS payment, and a direct paid-status bypass. It verifies the expired website order requires review and stock never falls below zero **for these exact native Woo hooks**. It also preserves six independent two-process last-unit Woo/MySQL races. CI prints `DISPOSABLE_WOO_LATE_WEBSITE_GUARD_OK` when this limited exercise passes.

**This is not a payment capture guarantee or live Paystack acceptance.** A gateway may update order status, modify `_stock`, acknowledge funds or trigger notifications through other paths; verification against the actual installed Paystack version and any checkout/stock plugins is required. There is no cross-system atomic settlement guarantee and no automatically approved refunds or physical cash disbursements. The genuine live readiness attestation remains deliberately **false**, no Woo plugin is installed on the website, and the existing read-only POS remains unchanged. Operators must not ship goods from a quarantined website order without manual payment, stock and refund reconciliation.

## Checkout Block and Paystack compatibility tests (disposable only)

WooCommerce supports both `created_via=checkout` for the classic checkout and `created_via=store-api` for Checkout Block/Store API orders. The original prototype matched only the former, which would leave the block flow unguarded. The new guard covers **both**, while continuing to exclude manual admin and POS-created orders. Its real pinned-Woo test now confirms ordinary Store API payment completion, expired/replayed Store API payment callbacks after POS sells the final unit, and a direct `wc_reduce_stock_levels()` attempt against an expired website hold.

The publicly available Paystack for WooCommerce source (PaystackOSS/woo-paystack) includes paths that call Woo `payment_complete()`, and some currency/amount discrepancy paths call the native `wc_reduce_stock_levels()` reducer directly. These are **source-inspection hypotheses about a public upstream plugin**, not confirmation of which gateway version, settings, callbacks or additional plugins are installed on this merchant's website. Do not copy or run live Paystack credentials into tests. The earlier conformance suite tests native Woo entry points; a separate new suite invokes the pinned public Paystack token-charge method with all Paystack HTTP calls stubbed. Neither suite exercises Paystack's signed webhook, redirect transaction verification flow, bank settlement, or manual edits outside the known hooks.

The signed `lateGatewayGuardVerified` release flag remains **false** regardless of these test results. Real checkout requires a separately reviewed Paystack/webhook implementation-specific compatibility assessment and a payment/cash/fulfilment reconciliation procedure.

## Additional quarantine and actual Paystack gateway conformance (draft, not live)

- **Sticky quarantine:** once an order receives `_mansu_website_stock_review=required`, rebuilding a valid Woo hold later must never automatically authorize that already-disputed website payment. A real pinned Woo/MySQL regression deliberately resets a quarantined order from on-hold to pending and attempts a new Woo reservation; the order still cannot complete or reduce stock. A new order/refund cannot be inferred from a renewed hold.
- **Short payment on-hold:** successful but underpaid Paystack transactions can change status directly to `on-hold`, skipping `payment_complete()` and any explicit stock reducer. The draft guard now attaches Owner/Manager review evidence when a Paystack-style website order moves to `on-hold` without a valid original reservation, while preserving the on-hold state. This also covers direct expired-hold admin on-hold transitions; it does not prove the funds received.
- **Real plugin method, fake payments:** the disposable GitHub Actions workflow installs the publicly released **Paystack for WooCommerce v5.8.6** alongside Woo 11.0.1, then invokes its actual `WC_Gateway_Paystack::process_token_payment()` method against synthetic products and a `pre_http_request` stub. It tests classic and Store API valid payments, delayed last-unit payment, short-paid on-hold, and wrong-currency direct stock-reduction behavior. Paystack API traffic is intercepted locally; no real Paystack customer, credential, settlement or refund is involved. This method-level suite covers only the token/saved-authorization route. Separate synthetic HTTP tests below cover some actual webhook/redirect paths; **normal popup, automated refunds, subscriptions, real settlement, and installed-site plugin/settings paths are NOT accepted.** See `tests/woocommerce-real-paystack-conformance.php`.
- **Paystack wrong-currency oversell reproduced and prevented in the tested code:** the first real-plugin CI exercise drove one synthetic last-unit product from quantity **0 to −1** after the gateway called `wc_reduce_stock_levels()` following an `on-hold` transition. Root cause: Woo can mark its **order-level** `stock_reduced` flag even after item reductions were denied; trusting that flag to bypass the hold guard was unsafe. The draft Woo filter now checks actual line-item `_reduced_stock` evidence and refuses to bypass a review marker. The regression uses both the real Paystack token method and the equivalent direct Woo on-hold/reducer sequence. A passing follow-up disposable run at code commit `46821aa` recorded **66 native Woo assertions, 23 real Paystack method assertions and 6 concurrent last-item races**: https://github.com/iwani1/mansupos/actions/runs/43643461379 . These do not establish production Paystack webhook safety or financial settlement atomicity.
- **Known release blocker:** upstream `process_token_payment()` returns a successful method result even when Woo `payment_complete()` returns false after a stock-safety quarantine. Thus a positive Paystack gateway return value cannot be treated as proof that a Woo order was paid/stocked/fulfillable. Manual financial reconciliation is mandatory; no automatic resubmission or cash refund is authorized. The hard interlock `lateGatewayGuardVerified: false` remains unchanged.

The isolated gateway tests passed against source commit `46821aa`; subsequent changes still require their own green runs. This evidence certifies only those tested paths, not the installed merchant gateway or a production checkout rollout.

## Signed Paystack webhook and return HTTP tests (disposable-only conformance passed)

The draft now contains a **CI-only, uninstalled HTTP test harness**:

- `tests/fixtures/mansu-ci-paystack-http-mock.php` — synthetic `pre_http_request` Paystack transaction verifier; rejects any unrecognized Paystack API route or reference. Loads only in the disposable local WordPress fixture, never on the merchant's website.
- `tests/woocommerce-real-paystack-http-fixture.php` — creates real Woo checkout and Store API orders and original holds, intentionally expires selected holds and marks the last unit as sold for the scenario, and provides read-only post-callback assertions.
- `tests/woocommerce-real-paystack-http-runner.mjs` — exercises the public Paystack 5.8.6 plugin's genuine WC-API entry points over a *loopback* PHP server using synthetic HMAC-SHA512 webhook requests and payment-return URLs. Tests invalid signature, valid webhook, replay, expired hold, valid/late redirect, and wrong-currency webhook; no network call to Paystack is authorized.

**Status:** actual Paystack v5.8.6 webhook and return entry points ran successfully using synthetic signed payloads through a disposable loopback WordPress HTTP server. At code commit `3d12d4d` the GitHub Actions conformance run [43645842952](https://github.com/iwani1/mansupos/actions/runs/43645842952) passed **22 HTTP assertions across nine phases** (invalid HMAC, valid webhook, valid webhook replay, expired-hold webhook, **expired-hold replay with exactly one success note**, valid return, expired-hold return, wrong-currency webhook, and **underpaid webhook**), alongside **66 real Woo/MySQL assertions, 23 Paystack token-method assertions and six last-unit concurrent races**. A previous synthetic run reproduced two duplicate Paystack success notes on late replay; the quarantine update moved disputed payment-completion attempts to on-hold, and the final repeat test asserted only one success note. These are isolated gateway conformance tests, not real-money settlement, installed-site Paystack compatibility, external multi-request atomicity, or production approval. The test-only MU plugin exists only in a fresh disposable WordPress instance, never the merchant site.

### Remaining payment-release blockers

1. Extend HTTP-level callback conformance to simultaneous cross-channel verification, unknown or mismatched references, network failures, partial capture/refunds and customer notification side effects. Underpayment and duplicate late callbacks are now verified only in the isolated nine-phase suite; real gateway settlement remains unverified.
2. Compare the exact *installed-site* Woo/Paystack versions, gateways, settings, HPOS, checkout type, third-party stock hooks and transaction-status callbacks using authorized **read-only** inspection. Public upstream source is not proof of the installed plugin.
3. Specify and test how a gateway's positive response after Woo rejects `payment_complete()` is recorded as an *externally paid but stock-quarantined* liability, including payment-reference deduplication and Owner/Manager refund evidence. No duplicate cash receipt, shipment or automatic refund.
4. Prove recoverable timeout/retry and explicit owner approval before any production write. The draft's `lateGatewayGuardVerified` must remain false until independent acceptance.

## Explicit live checkout safety interlock

The uninstalled Woo online bridge now reports `lateGatewayGuardVerified: false` in its **signed, read-only health response**. The bridge client requires this field, and the live `OnlineSalesService.assertLiveBridgeReady()` refuses to prepare a new Woo order or report collectible cash unless it is **true**. The existing Woo bridge source cannot currently assert it: the native Woo hook prototype is not independently verified against the installed Paystack gateway and cannot cover every callback/stock mutation path. This ensures that copying old live approvals and Woo settings is not enough to activate live transactions. Synthetic tests may inject `true` into a fake bridge **only to exercise other logic**; that fake is not a production configuration and does not affect Contabo.

This is a **deliberate hard blocker**, not a promise that the late callback is safe. It must be lifted only by a separately reviewed, proved Woo/Paystack integration that prevents post-expiry paid orders from silently claiming the same last item, while preserving genuine customer payment and manual refund/recovery evidence.

## Separate acceptance gates before selling (not done by this change)

1. Verify the exact installed Woo version, checkout type, HPOS, database engine, Paystack gateway callback paths, custom hooks, plugin stock adjustments and `wc_reserved_stock` reservation behavior in an isolated environment. The Woo Online Bridge already in the repository is a **disabled-by-default prototype**, not an installed or signed-off service.
2. Prove the shared last-unit race for the actual website checkout **and** proposed POS reservation, including expired holds and late Paystack callbacks. If the gateway bypasses reservation payment guards, keep checkout locked.
3. Design idempotent order creation, cash intent and same-order recovery, then test pending-order expiry, paid/refunded status changes, stock movement and notification side effects. A timeout must never cause another order or second cash collection.
4. Define audited **Owner/Manager** incident decisions and refund approvals: evidence required, original vs later shift, actual payout amount/time/method, one-time refund ID/stock-restock rule, partial payouts, and no silent modification of closed shifts. Do not turn a generic cash movement into an approved refund.
5. Obtain distinct owner acceptance for any genuine live order or cash collection, verify Woo/WordPress backups and a restore drill, and provide a separate maintenance/cutover review for the **existing** pilot identity. This milestone never changes the installed `live-pilot` ledger to `live-trading`.

## Local tests

```sh
node --test tests/phase2-stock-audit.test.js
npm test
npm run lint
npm run build:live
# GitHub Actions also runs browser regressions and disposable real Woo/MySQL conformance on the Phase 2 branch.
```

Tests use synthetic products, local ephemeral SQLite and mocked Woo calls. Passing tests is **not** evidence of production Woo/Paystack atomicity, receipt/tax correctness or authorization for live selling. Do not merge, deploy, install a WordPress bridge, rotate API keys or enable a checkout gate on the strength of this audit alone.
