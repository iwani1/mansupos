# Mansu POS

A point-of-sale web app for **MansutRENDZGH**. It sells from the shop's existing WooCommerce catalogue, so the shop and the website share one stock count.

## Current status (16 Nov 2026)

- **Live:** `https://pos.mansutrendzgh.com` runs the trading service in **cash-only Retail** mode. Each sale creates a real WooCommerce order and lowers website stock.
- **Safeguards:** stock is re-read before the order is created and again before it is marked paid; a last-unit sale is refused while an unpaid website or POS order holds that item; items without a WooCommerce stock count cannot be sold; unpaid POS orders nobody touched are cancelled automatically.
- **Locked:** Wholesale, MoMo/card recording, offline Windows tills, the WooCommerce reservation plugin and the old POS-only stock pool. Each has its own switch and is off.
- **Stock control (new, switch off on live by default):** owners/managers receive deliveries, write off damage, run shelf counts and (owner) change retail prices from the POS; each change is written to WooCommerce, so the website and shop keep one stock count. Turn on with `POS_INVENTORY_WRITES_APPROVED=true`; see [docs/INVENTORY-MANAGEMENT.md](docs/INVENTORY-MANAGEMENT.md).
- **Known limit:** two sales of the same last unit within a second or two (shop and website) are not prevented.

Operate and update it with [docs/RETAIL-CASH-GO-LIVE-RUNBOOK.md](docs/RETAIL-CASH-GO-LIVE-RUNBOOK.md). [docs/README.md](docs/README.md) says which documents are current and which are history. Much of the text below this section and many documents describe earlier, superseded plans.

## Included

- Product search, category filters, grid/list views, and stock visibility.
- **Current-branch UI (not deployed):** responsive grouped/collapsible workspace, real POS-only Overview, searchable Woo product/category directories, separate Sales/Orders presentations, named Wholesale-buyer directory for authorised roles, and consistent neutral, document-style operational screens. There is no supplier or Woo product-write API; incomplete catalogue and reporting coverage are labelled rather than invented. See [DESIGN.md](DESIGN.md).
- **Installable web app (read-only pilot 1.2.3):** same-origin manifest and desktop icons, labeled desktop directory / compact-screen navigation drawer, and a public offline safety notice only. No authenticated or `/api` responses are cached by the service worker; [install guidance](docs/INSTALLABLE-WEB-APP.md).
- **Separate Windows online pilot QA app:** native NSIS installer for the same remote HTTPS POS, with in-memory session, no offline sale/queue, health verification and an independent read-only request lock; [Windows installer guide](docs/WINDOWS-ONLINE-PILOT.md). The full web app remains available separately.
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

On Windows, `npm run dist:online:win` builds the **unsigned, read-only online pilot** installer (no publication); follow [its QA and hash-check guide](docs/WINDOWS-ONLINE-PILOT.md). It is not the legacy `dist:win` offline till.

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
