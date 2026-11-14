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

## Reverse late-website-payment release blocker

The disposable real WooCommerce/MySQL conformance exercise now tests **both orderings** after a website payment's hold expires: (1) the late website payment consumes the last unit before POS payment, which the bridge currently blocks as a POS stock change, and (2) POS completes while the old website order is still unpaid, then an asynchronous website gateway callback completes the old order. The second race can cause a paid order to consume stock already sold by POS. CI prints an explicit `DISPOSABLE_WOO_LATE_GATEWAY_RELEASE_BLOCKER` when it observes negative stock. A passing conformance test is therefore **not** a live-release approval. Do not attempt to solve the second race by retrying POS writes, changing Woo stock manually or assuming the 60-minute Hold stock option prevents late gateway callbacks. A separately reviewed Woo/Paystack-side admission and paid/refund/fulfilment recovery mechanism is required.

The additional test is strictly on the GitHub Actions ephemeral `WP_ENVIRONMENT_TYPE=local` WordPress installation with pinned WooCommerce 11.0.1, disposable MySQL, a synthetic product and zero actual transactions. It must not be executed on GreenGeeks/Contabo. The installed website's actual plugins, Paystack notifications and callbacks remain unverified.

## Explicit live checkout safety interlock

The uninstalled Woo online bridge now reports `lateGatewayGuardVerified: false` in its **signed, read-only health response**. The bridge client requires this field, and the live `OnlineSalesService.assertLiveBridgeReady()` refuses to prepare a new Woo order or report collectible cash unless it is **true**. The existing Woo bridge source cannot currently assert it: no Paystack/website late-callback admission guard has been implemented or independently accepted. This ensures that copying old live approvals and Woo settings is not enough to activate live transactions. Synthetic tests may inject `true` into a fake bridge **only to exercise other logic**; that fake is not a production configuration and does not affect Contabo.

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
