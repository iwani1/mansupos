# Mansu POS

A working, mobile-friendly point-of-sale application for **MansutRENDZGH**, designed to use the existing WooCommerce catalogue, inventory, and orders.

## Current status

The live preview runs in **isolated demo mode**. It does not create orders, change stock, send receipts, or collect money on mansutrendzgh.com.

The codebase includes production-oriented controls (shifts, audit, lockout, idle sessions, reconciliation sweep, diagnostics, migrations, backup/restore, preflight, Docker/Caddy/systemd/nginx examples, and CI). **A full application audit on 4 November 2026 found release blockers; the code remediation and regression tests are documented in [docs/AUDIT-2026-11-04.md](docs/AUDIT-2026-11-04.md).** Do not enable live writes until staging acceptance, hardware verification, backups, and owner approval are complete. Production deployment still requires an approved staging clone, server-side credentials, hardware verification, and the live write gate.

- Product names, prices, IDs, and source image URLs were sampled read-only from the public WooCommerce Store API on **3 November 2026**.
- Demo quantities, `DEMO-` barcode aliases, register categories, and sample transactions are not live store data.
- Demo product images are locally hosted **illustrations**, clearly labelled in the interface. They are not photographs of the actual products.
- Staging/live mode loads the actual catalogue and product images through authenticated WooCommerce REST API requests.
- No WordPress plugin was installed and no live website setting was changed.

## Included

- Product search, category filters, grid/list views, and stock visibility.
- Simple products and size/variation selection.
- Exact SKU/barcode lookup and keyboard-wedge scanner input (`F2`).
- Cart quantities, internal notes, and browser-local held sales.
- Cash received/change calculation.
- Explicitly external MoMo/Card payment recording with merchant references.
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
npm run build            # production frontend build
npm run test:browser     # demo workflow, recovery, proxy, motion and design checks; expects port 3000
npm run test:design      # counter/mobile layout and mocked visual-state checks
npm run test:a11y        # axe WCAG A/AA + best-practice scans; expects port 3000
npm run lint             # ESLint
npm run backup           # consistent SQLite backup + integrity check
```

The browser walkthrough creates demo sales and may close an open demo shift. Run it only against a separate `POS_MODE=demo` server with an isolated `POS_DATA_DIR`—never staging or live. Set `TEST_BASE_URL` if that server is not on port 3000. The browser tests use a development-only Chromium package; set `TEST_CHROMIUM_PATH` to use an existing Chrome/Chromium installation instead.

## Connect the store

Read **[docs/PRODUCTION.md](docs/PRODUCTION.md)** for the production deployment runbook, **[docs/SETUP.md](docs/SETUP.md)** for staging configuration, **[docs/OPERATIONS.md](docs/OPERATIONS.md)** for daily use, and **[docs/SECURITY.md](docs/SECURITY.md)** for the security model.

The short version:

1. Audit the existing site and verify a full WordPress files/database backup.
2. Create a separate staging clone with outbound email/fulfilment/payment side effects controlled.
3. Configure `POS_MODE=staging`, the staging URL, and WooCommerce API credentials **on the server**.
4. Bootstrap a named owner account and create individual cashier accounts.
5. Complete **[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)** using test products and externally simulated payment records.
6. Obtain written owner approval before enabling the separate live write gate.

**Never paste API keys, WordPress passwords, payment credentials, or customer data into chat or commit them to Git.**

## Verification

- `npm test`: 41 backend/mocked WooCommerce/restore regression tests pass, including shared-parent and independent variation stock, backorders, and stock changes before payment.
- `npm run test:browser`: full demo register → checkout → receipt → scanner → hold/resume → reports/staff/shifts/audit/diagnostics/mobile flow, plus lost-response recovery, embedded-preview sessions, reduced motion, counter/mobile layout and mocked stock/variation/report checks, passes. Run it against an isolated demo database.
- `npm run test:a11y`: axe WCAG A/AA + best-practice scans and 320px overflow check pass.
- `npm run lint`: ESLint passes.
- Receipt PDF was checked for one-page layout and extractable receipt text.
- `npm run build`: production frontend build passes.
- GitHub Actions: backend, lint, production-browser/recovery/accessibility, and clean Docker build/smoke jobs pass.
- `npm run preflight`: configuration/build/data-directory/gate checks pass.
- `npm audit --omit=dev`: no known production dependency vulnerabilities at the time of the build.
- `npm run backup` and guarded `npm run restore`: SQLite online backup, restore, and integrity check pass in an isolated test directory.

These checks use demo data and mocked WooCommerce responses. They do not prove compatibility with the live WordPress/WooCommerce installation; staging acceptance is still required.

## Important limitations

- This application **records** payments; it does not process MoMo or card payments.
- Internet access is required for checkout. There is no offline payment queue.
- Fresh stock checks and order updates are separate requests, not an atomic reservation. Concurrent online/POS sales can still race; a WooCommerce-side safeguard shared by both channels or an approved operational control must be established and verified before live trading.
- Printer/scanner/cash-drawer compatibility must be verified on the actual hardware. Cash-drawer triggering is not implemented.
- Refunds are initiated in WooCommerce, then reconciled into POS reports. The POS does not issue payment refunds.
- Reports cover POS transactions recorded by this application, not every online order.
- The local ledger is not an accounting/tax system. Verify Ghanaian receipt/tax requirements with the owner’s adviser.
- The app is designed for one shop and a single Node server instance with persistent private storage. Multi-instance deployment needs a shared database/distributed lock and a revised reconciliation design.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the integration and failure-handling design, and **[docs/UI-DESIGN.md](docs/UI-DESIGN.md)** for the Retail Studio visual system and research references.
