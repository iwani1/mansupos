# Mansu POS

A working, mobile-friendly point-of-sale application for **MansutRENDZGH**, designed to use the existing WooCommerce catalogue, inventory, and orders.

## Current status

The separately deployed `pos.mansutrendzgh.com` **read-only live catalogue (version 1.1.4)** reads the real WooCommerce products with a Read-only key; it cannot create orders or record payment. Its 115-product catalogue was verified, not checkout/tax acceptance. The public UI does not show demo records, but its older build may still contain unused demo illustration files until upgraded. The isolated demo is retained for local tests only. This repository's **1.1.6** refresh removes sample stock/sign-in/assets from non-demo operation and includes a separate, **write-locked** live trading-service template; neither the refresh nor the template is deployed yet. The owner reports written Retail + Wholesale sales approval and a tested off-host store restore, but has declined staging; **real POS trading is not yet enabled**. The proposed no-staging path is a [supervised cash-only live acceptance plan](docs/LIVE-CASH-ROLLOUT.md), not permission to unlock the catalogue service.

The codebase includes production-oriented controls (shifts, audit, lockout, idle sessions, reconciliation sweep, diagnostics, migrations, backup/restore, preflight, Docker/Caddy/systemd/nginx examples, and CI). **A full application audit on 4 November 2026 found release blockers; the code remediation and regression tests are documented in [docs/AUDIT-2026-11-04.md](docs/AUDIT-2026-11-04.md).** Live checkout still needs actual WooCommerce tax/stock/recovery and integration acceptance, physical hardware verification and a separate reviewed trading deployment. Do not enable live writes from the read-only pilot.

- Product names, prices, IDs, and source image URLs were sampled read-only from the public WooCommerce Store API on **3 November 2026**.
- Demo quantities, `DEMO-` barcode aliases, register categories, and sample transactions are not live store data.
- Demo product images are locally hosted **illustrations**, clearly labelled in the interface. They are not photographs of the actual products.
- Staging/live mode loads the actual catalogue and product images through authenticated WooCommerce REST API requests.
- No WordPress plugin was installed and no live website setting was changed.

## Included

- Product search, category filters, grid/list views, and stock visibility.
- Simple products and size/variation selection.
- Exact SKU/barcode lookup and keyboard-wedge scanner input (`F2`).
- Cart quantities, internal notes, and browser-local held **retail** sales.
- Dedicated **Wholesale** workspace (owner/manager only): start with goods; a buyer name is optional and can be entered directly without selecting or creating a buyer. Enter each negotiated final tax-inclusive unit price, review and explicitly approve the quote, then record full payment before goods leave. Named and unnamed sales appear in history; catalogue prices remain unchanged, with no quantity tiers or unpaid dispatch. The retail register has no negotiated-price controls.
- Cash received/change calculation.
- Cash-only live POS payment recording (MoMo/Card recording remains available in demo/staging, not live); online Paystack checkout is separate.
- WooCommerce order creation and payment-status confirmation in staging/live mode.
- Idempotent checkout preparation and interrupted-order reconciliation.
- Printable 58 mm, 80 mm, and A4 receipts.
- Inventory and missing/duplicate SKU visibility.
- Daily/period sales reports, payment mix, top products, and scoped CSV export.
- Named owner/manager/cashier accounts with server-enforced permissions.
- Forced temporary-password change, password policy, account lockout, idle session expiry, and audit log.
- Shift open/close, opening float, cash in/out, expected drawer cash, counted cash, and variance.
- Server-side API credentials, hashed passwords, expiring sessions, login rate limits, and origin checks.
- Periodic read-only reconciliation sweep for interrupted/pending WooCommerce sales.
- Connection diagnostics, health/readiness endpoints, structured logs, and preflight checks.
- Separate demo/staging/live SQLite databases, schema migrations, backup, and guarded restore.
- Docker/Caddy and systemd/nginx deployment examples, backup timer, and CI workflow.

## Run locally

Requires **Node.js 22.13+**.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. The default configuration is demo mode; no credentials are required. The app enters automatically as **Demo Owner**. If a session expires and the sign-in screen appears, choose **Open demo workspace**.

```bash
npm test                 # backend and mocked WooCommerce integration tests
npm run build            # isolated demo frontend build
npm run build:live       # live/staging frontend build; excludes demo illustrations
npm run test:browser     # demo workflow, wholesale quotes, recovery, proxy, motion and design checks; expects port 3000
npm run test:design      # counter/mobile layout and mocked visual-state checks
npm run test:a11y        # axe WCAG A/AA + best-practice scans; expects port 3000
npm run lint             # ESLint
npm run backup           # consistent SQLite backup + integrity check
```

The browser walkthrough creates demo sales and may close an open demo shift. Run it only against a separate `POS_MODE=demo` server with an isolated `POS_DATA_DIR`—never staging or live. Set `TEST_BASE_URL` if that server is not on port 3000. The browser tests use a development-only Chromium package; set `TEST_CHROMIUM_PATH` to use an existing Chrome/Chromium installation instead.

## Connect the store

On the shared Contabo VPS (host Nginx, another Node app on port 3000, no Docker), the isolated **[read-only live pilot](docs/CONTABO-LIVE-PILOT.md)** is already serving `pos.mansutrendzgh.com` over HTTPS on loopback port 3187. It cannot create orders, record payment or open cash shifts. **[docs/CONTABO-NATIVE.md](docs/CONTABO-NATIVE.md)** is a distinct Woo-staging route; it cannot run on the pilot's port. **[docs/CONTABO.md](docs/CONTABO.md)** covers optional POS-only Docker/Compose only if an administrator chooses to install Docker. The owner's no-staging request has a **separate, not-yet-deployed and write-locked** [live trading-service template](docs/CONTABO-LIVE-TRADING.md); real trading requires the checks in **[docs/LIVE-CASH-ROLLOUT.md](docs/LIVE-CASH-ROLLOUT.md)**. See **[docs/PRODUCTION.md](docs/PRODUCTION.md)** for gates, **[docs/SETUP.md](docs/SETUP.md)** for setup, **[docs/OPERATIONS.md](docs/OPERATIONS.md)** for daily use, and **[docs/SECURITY.md](docs/SECURITY.md)** for security.

The deployed read-only catalogue pilot does **not** authorize real Woo test orders. For eventual trading without a staging clone:

1. Review live pending/paid order effects (Paystack, emails, webhooks, fulfilment), store tax and stock rules **without changing settings**.
2. Verify the reported off-host shop restore evidence; establish a separate trading POS ledger backup and isolated restore.
3. Agree on a supervised **genuine cash-sale** acceptance plan with the owner, including the failure/reconciliation and last-item-stock controls; see **[docs/LIVE-CASH-ROLLOUT.md](docs/LIVE-CASH-ROLLOUT.md)**.
4. Only after the checks, have an administrator review a **separate** trading service and dedicated credentials. Never repurpose the pilot or its Read-only key.
5. Keep general staff access and Wholesale writes locked until the actual store, hardware and recovery results are signed off. Separate written Wholesale approval alone does not prove tax/total acceptance.

**Never paste API keys, WordPress passwords, payment credentials, or customer data into chat or commit them to Git.**

## Verification

- `npm test`: backend/mocked WooCommerce/restore and deployment-safety regression tests pass locally, including the live catalogue pilot's forced loopback/write locks, Woo request guard, multi-page catalogue reads, optional-name and unnamed wholesale quotes, exact tax-inclusive amounts, cash-only live payment gate, no-staging Wholesale approval separation, historical-order compatibility, loss/reconciliation recovery, stock checks, single-instance locking and owner preflight.
- `npm run test:browser`: demo retail/Wholesale quotes, recovery, receipt, proxy session, reduced motion, counter/mobile layout, pilot checkout-lock labels and **isolated mock live-mode cash-only UI**. Run only against an isolated demo database, never the live site.
- `npm run test:a11y`: axe WCAG A/AA + best-practice scans and 320px overflow check pass.
- `npm run lint`: ESLint passes.
- Receipt PDF was checked for one-page layout and extractable receipt text.
- `npm run build` (isolated demo) and `npm run build:live` (live package without copied demo illustrations) pass.
- GitHub Actions: backend, lint, production-browser/recovery/accessibility, and clean Docker build/smoke jobs pass.
- `npm run preflight`: configuration/build/data-directory/gate checks pass.
- `npm audit --omit=dev`: no known production dependency vulnerabilities at the time of the build.
- `npm run backup` and guarded `npm run restore`: SQLite online backup, restore, and integrity check pass in an isolated test directory.

These checks use isolated fixtures and mocked WooCommerce responses. They do not prove compatibility with the live WordPress/WooCommerce installation; the read-only service verifies only catalogue connectivity, not taxes or safe checkout. The owner declined staging, so the [controlled no-staging plan](docs/LIVE-CASH-ROLLOUT.md) must be reviewed before any real order write.

## Important limitations

- This application **records** payments; it does not process MoMo or card payments. An unpaid or under-review wholesale order **never** authorizes release of goods. The five dispatch-first/pay-later accounts remain unimplemented.
- Wholesale is restricted to in-store collection at the store tax location **to be verified against actual WooCommerce tax settings** (preferably staging, or under an owner-supervised genuine-sale plan). Different delivery-tax jurisdictions require a separately accepted address/tax workflow; do not assume a buyer name alone supplies a taxable destination.
- Internet access is required for checkout. There is no offline payment queue.
- Fresh stock checks and order updates are separate requests, not an atomic reservation. Concurrent online/POS sales can still race; a WooCommerce-side safeguard shared by both channels or an approved operational control must be established and verified before live trading.
- Printer/scanner/cash-drawer compatibility must be verified on the actual hardware. Cash-drawer triggering is not implemented.
- Refunds are initiated in WooCommerce, then reconciled into POS reports. The POS does not issue payment refunds.
- Reports cover POS transactions recorded by this application, not every online order.
- The local ledger is not an accounting/tax system. Verify Ghanaian receipt/tax requirements with the owner’s adviser.
- The app is designed for one shop and a single Node server instance with persistent private storage. Multi-instance deployment needs a shared database/distributed lock and a revised reconciliation design.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the integration and failure-handling design, **[DESIGN.md](DESIGN.md)** for the current design tokens and component rules, and **[docs/UI-DESIGN.md](docs/UI-DESIGN.md)** for the visual audit history and research references.
