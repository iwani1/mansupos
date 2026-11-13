# Mansu POS

A working, mobile-friendly point-of-sale application for **MansutRENDZGH**, designed to use the existing WooCommerce catalogue, inventory, and orders.

## Current status

The owner reports that the separately deployed `pos.mansutrendzgh.com` **read-only live pilot** now runs **1.2.3 (`143d68e`)**, with an encrypted, matching-hash off-VPS **post-upgrade pilot** backup. Owner-provided public HTTPS health/readiness output showed `1.2.3`, `liveReadOnly:true` and no readiness issues; the owner reports sign-in, Woo product connection and catalogue checks passed. These observations do **not** verify store tax, order writes or concurrent stock safety. The pilot uses a WooCommerce Read-only key and **cannot create orders, record payments or open cash shifts**. Its [In-store collection](docs/INSTORE-COLLECTION.md) shows the original CSV/PDF **historical source snapshot**, not a live Woo stock count. The local POS-only cash path remains locked. Version 1.2.3 includes the [installable, online-only web app](docs/INSTALLABLE-WEB-APP.md) and [private wholesale defaults](docs/PRIVATE-WHOLESALE-PRICES.md) in code; the pilot refuses private-price edits and all checkout. **The current branch also redesigns the existing application shell, POS, Overview, Products/Categories, POS Sales/Orders and existing operational views. That redesign is not installed on the pilot.** The [read-only trading review](docs/LIVE-READONLY-REVIEW.md) tracks what remains unknown before a separate trading deployment.

**New client target, not deployed:** [share these physical goods' WooCommerce retail catalogue and stock with the shop's negotiated-price Wholesale POS](docs/SHARED-WOO-STOCK.md). This supersedes the proposed *POS-only* In-store cash rollout for those goods: **do not enable `POS_INSTORE_CASH_APPROVED`** or use the PDF quantities to sell after online publication. Offline, no-write [matching, identity review, size grouping and both colour-layout comparison tools](docs/SHARED-WOO-STOCK.md) are available; the owner clarified that all 115 existing Woo parent goods are distinct from the physical-source goods and prefers to mix colour layouts **by style**, but no per-style choices have been made. None of these tools approves an import or sets current stock. No goods have been bulk-created or stocked online, no new sale is enabled, and the separately locked trading-service template is not installed. Actual Woo order/tax/stock side effects and a safe shared last-unit control still need the [supervised cash-only acceptance plan](docs/LIVE-CASH-ROLLOUT.md).

**Windows offline draft, not distributed:** This branch adds a separate Windows Electron shell, protected local SQLite cash-sales queue, signed central sync and an **uninstalled** Woo reservation plugin proposal. The existing browser app remains online-only; its pilot remains read-only. Isolated tests pass and Windows CI built an **unsigned QA-only installer that it discarded without publishing**; there is **no device-tested/distributable Windows installer, portable device-loss restore or witnessed website/POS last-unit result**. Desktop setup and selling are separately gated OFF in the checked-in trading unit. See [Windows offline design, tests and blockers](docs/WINDOWS-OFFLINE-DESIGN.md). Do not install the plugin or publish a GitHub Release without a subsequent approval.

The codebase includes production-oriented controls (shifts, audit, lockout, idle sessions, reconciliation sweep, diagnostics, migrations, backup/restore, preflight, Docker/Caddy/systemd/nginx examples, and CI). **A full application audit on 4 November 2026 found release blockers; the code remediation and regression tests are documented in [docs/AUDIT-2026-11-04.md](docs/AUDIT-2026-11-04.md).** Live checkout still needs actual WooCommerce tax/stock/recovery and integration acceptance, physical hardware verification and a separate reviewed trading deployment. Do not enable live writes from the read-only pilot.

- Product names, prices, IDs, and source image URLs were sampled read-only from the public WooCommerce Store API on **3 November 2026**.
- Demo quantities, `DEMO-` barcode aliases, register categories, and sample transactions are not live store data.
- Demo product images are locally hosted **illustrations**, clearly labelled in the interface. They are not photographs of the actual products.
- Staging/live mode loads the actual catalogue and product images through authenticated WooCommerce REST API requests.
- No WordPress plugin was installed and no live website setting was changed.

## Included

- Product search, category filters, grid/list views, and stock visibility.
- **Current-branch UI (not deployed):** responsive grouped/collapsible workspace, real POS-only Overview, searchable Woo product/category directories, separate Sales/Orders presentations, named Wholesale-buyer directory for authorised roles, and consistent pink/charcoal operational screens. There is no supplier or Woo product-write API; incomplete catalogue and reporting coverage are labelled rather than invented. See [DESIGN.md](DESIGN.md).
- **Installable web app (read-only pilot 1.2.3):** same-origin manifest and desktop icons, labeled desktop directory / compact-screen navigation drawer, and a public offline safety notice only. No authenticated or `/api` responses are cached by the service worker; [install guidance](docs/INSTALLABLE-WEB-APP.md).
- **In-store collection (historical source view on the 1.2.3 pilot):** the PDF-count/CSV-price source, with 41 quarantined exceptions and no cost fields in the POS API. A previously implemented POS-only cash/stock path remains locked and is **not the client's new shared-Woo-stock target**; do not enable it. The proposed path uses Woo-backed Wholesale so online and shop stock have one authority.
- Simple products and size/variation selection.
- Exact SKU/barcode lookup and keyboard-wedge scanner input (`F2`).
- Cart quantities, internal notes, and browser-local held **retail** sales.
- Dedicated **Wholesale** workspace (owner/manager only): start with goods; a buyer name is optional and can be entered directly without selecting or creating a buyer. Enter each negotiated final all-in unit price (including any applicable tax), review and explicitly approve the quote, then record full payment before goods leave. Named and unnamed sales appear in history; catalogue prices remain unchanged, with no quantity tiers or unpaid dispatch. The retail register has no negotiated-price controls.
- **Version 1.2.3, pilot remains locked:** private owner-managed wholesale defaults per exact Woo product/variation are available in code for an isolated demo or a future approved trading workspace. The deployed read-only pilot cannot view or edit them; no Woo retail/stock change or public price exposure occurs, and explicit per-sale approval remains mandatory. See [private price guide](docs/PRIVATE-WHOLESALE-PRICES.md).
- Cash received/change calculation.
- Cash-only live POS payment recording (MoMo/Card recording remains available in demo/staging, not live); online Paystack checkout is separate.
- WooCommerce Retail/Wholesale order creation and payment-status confirmation **only behind their separate staging/live gates**; the old locked POS-only In-store route never uses that adapter and must not be used for the new shared-stock plan.
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
npm run test:browser     # isolated demo, real-data workspace, guarded workflows, PWA and responsive checks; expects production demo on port 3000
npm run test:pwa         # install/offline + responsive navigation, isolated production-built demo on port 3000
npm run test:design      # counter/mobile layout and mocked visual-state checks
npm run test:a11y        # axe WCAG A/AA + best-practice scans; expects port 3000
npm run lint             # ESLint
npm run backup           # consistent SQLite backup + integrity check
```

The browser walkthrough creates demo sales and may close an open demo shift. Its live/in-store UI cases intercept fixture responses and **never submit a real sale**. Run it only against a separate `POS_MODE=demo` server with an isolated `POS_DATA_DIR`—never staging or live. Set `TEST_BASE_URL` if that server is not on port 3000. The browser tests use a development-only Chromium package; set `TEST_CHROMIUM_PATH` to use an existing Chrome/Chromium installation instead.

## Connect the store

On the shared Contabo VPS (host Nginx, another Node app on port 3000, no Docker), the isolated **[read-only live pilot](docs/CONTABO-LIVE-PILOT.md)** is already serving `pos.mansutrendzgh.com` over HTTPS on loopback port 3187. The owner reports 1.2.3 (`143d68e`) there, including the [installable web app](docs/INSTALLABLE-WEB-APP.md). Installing 1.2.3 did not unlock private-price editing or selling: the private-price workflow belongs in a separate, approved trading workspace, and the pilot must stay read-only. The installed pilot cannot create orders, record payment or open cash shifts. **[docs/CONTABO-NATIVE.md](docs/CONTABO-NATIVE.md)** is a distinct Woo-staging route; it cannot run on the pilot's port. **[docs/CONTABO.md](docs/CONTABO.md)** covers optional POS-only Docker/Compose only if an administrator chooses to install Docker. The owner's no-staging request has a **separate, not-yet-deployed and write-locked** [live trading-service template](docs/CONTABO-LIVE-TRADING.md). The old physical [POS-only stock path](docs/INSTORE-COLLECTION.md) is retired outside isolated tests for these goods. The proposed [shared Woo stock plan](docs/SHARED-WOO-STOCK.md) and Woo Retail/Wholesale trading need the checks in **[docs/LIVE-CASH-ROLLOUT.md](docs/LIVE-CASH-ROLLOUT.md)**. See **[docs/PRODUCTION.md](docs/PRODUCTION.md)** for gates, **[docs/SETUP.md](docs/SETUP.md)** for setup, **[docs/OPERATIONS.md](docs/OPERATIONS.md)** for daily use, and **[docs/SECURITY.md](docs/SECURITY.md)** for security.

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
- `npm run test:pwa`: manifest/icons and cache headers, network-only `/api`, installed-window navigation at 320–1920px, offline safety notice and its accessibility scan (isolated production-built demo only).
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
- Woo-backed Wholesale is for **collection at the shop tax location**, to be verified against actual WooCommerce rules. The new shared-stock target would use this flow for physical-source goods **after** an owner-reviewed Woo import; the current legacy In-store POS-only checkout must stay locked. Different delivery-tax jurisdictions require another address/tax workflow.
- Woo Retail/Wholesale checkout requires internet and has **no offline payment queue**. The old local In-store cash path works only with a separate POS pool and is incompatible with the new shared-Woo requirement.
- Woo stock checks and order updates are separate requests, not an atomic reservation; concurrent online/POS sales can race and need a shared safeguard before any real shared-stock sale. The legacy POS-only In-store sale deducts a separate balance and must not be enabled for the goods being moved online.
- Printer/scanner/cash-drawer compatibility must be verified on the actual hardware. Cash-drawer triggering is not implemented.
- Woo Retail/Wholesale refunds are initiated in WooCommerce, then reconciled into their POS reports. **In-store collection returns/refunds are not implemented**; arrange a separate owner procedure before live cash sales. The POS does not issue payment refunds.
- Woo Retail/Wholesale history/reports and In-store collection cash history/reports are **distinct**. Neither includes every online order. The shared shift drawer includes both cash pools without double-counting.
- The local ledger is not an accounting/tax system. Verify Ghanaian receipt/tax requirements with the owner’s adviser.
- The app is designed for one shop and a single Node server instance with persistent private storage. Multi-instance deployment needs a shared database/distributed lock and a revised reconciliation design.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the integration and failure-handling design, **[DESIGN.md](DESIGN.md)** for the current design tokens and component rules, and **[docs/UI-DESIGN.md](docs/UI-DESIGN.md)** for the visual audit history and research references.
