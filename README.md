# Mansu POS

A working, mobile-friendly point-of-sale application for **MansutRENDZGH**, designed to use the existing WooCommerce catalogue, inventory, and orders.

## Current status

The separately deployed `pos.mansutrendzgh.com` **read-only live pilot** was last checked locally at **1.1.6** after its own verified backup, demo-free build and restart; the requested public HTTPS readiness result has not yet been reported. It uses a WooCommerce Read-only key, displayed 115 verified online products and **cannot create orders, record payments or open cash shifts**. This branch's **1.2.0** code adds a separate [In-store collection](docs/INSTORE-COLLECTION.md) from the client's physical-stock PDF/CSV. On the pilot it remains a **catalogue only**, while an independently gated POS-only cash, receipt and stock ledger is implemented for a later reviewed trading service. **No new sale has been enabled or deployed.** The existing separate live trading-service template is not installed and forces Woo and in-store writes off. The owner reports written Retail + Wholesale approval and an off-site shop restore, but declined staging; actual-store Woo order acceptance still requires the [supervised cash-only plan](docs/LIVE-CASH-ROLLOUT.md). The physical-stock cash path needs its *own* reviewed acceptance and does not create Woo orders.

The codebase includes production-oriented controls (shifts, audit, lockout, idle sessions, reconciliation sweep, diagnostics, migrations, backup/restore, preflight, Docker/Caddy/systemd/nginx examples, and CI). **A full application audit on 4 November 2026 found release blockers; the code remediation and regression tests are documented in [docs/AUDIT-2026-11-04.md](docs/AUDIT-2026-11-04.md).** Live checkout still needs actual WooCommerce tax/stock/recovery and integration acceptance, physical hardware verification and a separate reviewed trading deployment. Do not enable live writes from the read-only pilot.

- Product names, prices, IDs, and source image URLs were sampled read-only from the public WooCommerce Store API on **3 November 2026**.
- Demo quantities, `DEMO-` barcode aliases, register categories, and sample transactions are not live store data.
- Demo product images are locally hosted **illustrations**, clearly labelled in the interface. They are not photographs of the actual products.
- Staging/live mode loads the actual catalogue and product images through authenticated WooCommerce REST API requests.
- No WordPress plugin was installed and no live website setting was changed.

## Included

- Product search, category filters, grid/list views, and stock visibility.
- **In-store collection**: independent client PDF-count/CSV-price stock, searched by name/SKU/group, with 41 quarantined exceptions and no cost fields in the POS API. The live pilot can only view it; a distinct, locked-by-default live cash workflow has atomic POS-only deductions, cash receipts, owner-count movements and separate history/reports. No Woo order, online-stock change or Paystack action occurs on that path.
- Simple products and size/variation selection.
- Exact SKU/barcode lookup and keyboard-wedge scanner input (`F2`).
- Cart quantities, internal notes, and browser-local held **retail** sales.
- Dedicated **Wholesale** workspace (owner/manager only): start with goods; a buyer name is optional and can be entered directly without selecting or creating a buyer. Enter each negotiated final tax-inclusive unit price, review and explicitly approve the quote, then record full payment before goods leave. Named and unnamed sales appear in history; catalogue prices remain unchanged, with no quantity tiers or unpaid dispatch. The retail register has no negotiated-price controls.
- Cash received/change calculation.
- Cash-only live POS payment recording (MoMo/Card recording remains available in demo/staging, not live); online Paystack checkout is separate.
- WooCommerce Retail/Wholesale order creation and payment-status confirmation **only behind their separate staging/live gates**; In-store collection sales never use that adapter.
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
npm run test:browser     # isolated demo and intercepted in-store/pilot/cash UI, recovery, motion, design; expects port 3000
npm run test:design      # counter/mobile layout and mocked visual-state checks
npm run test:a11y        # axe WCAG A/AA + best-practice scans; expects port 3000
npm run lint             # ESLint
npm run backup           # consistent SQLite backup + integrity check
```

The browser walkthrough creates demo sales and may close an open demo shift. Its live/in-store UI cases intercept fixture responses and **never submit a real sale**. Run it only against a separate `POS_MODE=demo` server with an isolated `POS_DATA_DIR`—never staging or live. Set `TEST_BASE_URL` if that server is not on port 3000. The browser tests use a development-only Chromium package; set `TEST_CHROMIUM_PATH` to use an existing Chrome/Chromium installation instead.

## Connect the store

On the shared Contabo VPS (host Nginx, another Node app on port 3000, no Docker), the isolated **[read-only live pilot](docs/CONTABO-LIVE-PILOT.md)** is already serving `pos.mansutrendzgh.com` over HTTPS on loopback port 3187. It cannot create orders, record payment or open cash shifts. **[docs/CONTABO-NATIVE.md](docs/CONTABO-NATIVE.md)** is a distinct Woo-staging route; it cannot run on the pilot's port. **[docs/CONTABO.md](docs/CONTABO.md)** covers optional POS-only Docker/Compose only if an administrator chooses to install Docker. The owner's no-staging request has a **separate, not-yet-deployed and write-locked** [live trading-service template](docs/CONTABO-LIVE-TRADING.md). The physical-stock pool has its own [POS-only acceptance boundary](docs/INSTORE-COLLECTION.md), whereas Woo Retail/Wholesale trading needs the checks in **[docs/LIVE-CASH-ROLLOUT.md](docs/LIVE-CASH-ROLLOUT.md)**. See **[docs/PRODUCTION.md](docs/PRODUCTION.md)** for gates, **[docs/SETUP.md](docs/SETUP.md)** for setup, **[docs/OPERATIONS.md](docs/OPERATIONS.md)** for daily use, and **[docs/SECURITY.md](docs/SECURITY.md)** for security.

The deployed read-only catalogue pilot does **not** authorize real Woo test orders. For eventual trading without a staging clone:

1. Review live pending/paid order effects (Paystack, emails, webhooks, fulfilment), store tax and stock rules **without changing settings**.
2. Verify the reported off-host shop restore evidence; establish a separate trading POS ledger backup and isolated restore.
3. Agree on a supervised **genuine cash-sale** acceptance plan with the owner, including the failure/reconciliation and last-item-stock controls; see **[docs/LIVE-CASH-ROLLOUT.md](docs/LIVE-CASH-ROLLOUT.md)**.
4. Only after the checks, have an administrator review a **separate** trading service and dedicated credentials. Never repurpose the pilot or its Read-only key.
5. Keep general staff access and Wholesale writes locked until the actual store, hardware and recovery results are signed off. Separate written Wholesale approval alone does not prove tax/total acceptance.

**Never paste API keys, WordPress passwords, payment credentials, or customer data into chat or commit them to Git.**

## Verification

- `npm test`: backend/mocked WooCommerce/restore and deployment-safety regression tests, plus physical-source matching, quarantines, separate cash gate, atomic POS-only stock/receipt, last-item race, idempotency, owner counts, distinct reports and pilot locks.
- `npm run test:browser`: demo Retail/Wholesale, recovery, receipt, mobile layout, pilot lock and **isolated In-store collection** UI/cash receipt/lost-response recovery/accessibility with mocked live responses. Run only against an isolated demo database, never the live site.
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
- Woo-backed Wholesale is for **collection at the shop tax location**, to be verified against actual WooCommerce rules; it does **not** sell goods from the distinct **In-store collection** stock pool. Different delivery-tax jurisdictions require another address/tax workflow.
- Woo Retail/Wholesale checkout requires internet; the independent In-store collection uses only the local POS server but has **no offline payment queue**.
- Woo stock checks and order updates are separate requests, not an atomic reservation; concurrent online/POS sales can race and need a shared safeguard. POS-exclusive In-store collection stock is deducted atomically with its cash receipt, and must not be sold by another till.
- Printer/scanner/cash-drawer compatibility must be verified on the actual hardware. Cash-drawer triggering is not implemented.
- Woo Retail/Wholesale refunds are initiated in WooCommerce, then reconciled into their POS reports. **In-store collection returns/refunds are not implemented**; arrange a separate owner procedure before live cash sales. The POS does not issue payment refunds.
- Woo Retail/Wholesale history/reports and In-store collection cash history/reports are **distinct**. Neither includes every online order. The shared shift drawer includes both cash pools without double-counting.
- The local ledger is not an accounting/tax system. Verify Ghanaian receipt/tax requirements with the owner’s adviser.
- The app is designed for one shop and a single Node server instance with persistent private storage. Multi-instance deployment needs a shared database/distributed lock and a revised reconciliation design.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the integration and failure-handling design, **[DESIGN.md](DESIGN.md)** for the current design tokens and component rules, and **[docs/UI-DESIGN.md](docs/UI-DESIGN.md)** for the visual audit history and research references.
