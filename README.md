# Mansu POS

A point-of-sale web app for **MansutRENDZGH**. It sells from the shop's existing WooCommerce catalogue, so the shop and the website share one stock count.

## Current status (16 Nov 2026)

- **Live:** `https://pos.mansutrendzgh.com` runs the trading service in **cash-only Retail** mode. Each sale creates a real WooCommerce order and lowers website stock.
- **Safeguards:** stock is re-read before the order is created and again before it is marked paid; a last-unit sale is refused while an unpaid website or POS order holds that item; items without a WooCommerce stock count cannot be sold; unpaid POS orders nobody touched are cancelled automatically.
- **Locked:** Wholesale, MoMo/card recording, offline Windows tills, the WooCommerce reservation plugin and the old POS-only stock pool. Each has its own switch and is off.
- **Stock control (new, switch off on live by default):** owners/managers receive deliveries, write off damage, run shelf counts and (owner) change retail prices from the POS; each change is written to WooCommerce, so the website and shop keep one stock count. Turn on with `POS_INVENTORY_WRITES_APPROVED=true`; see [docs/INVENTORY-MANAGEMENT.md](docs/INVENTORY-MANAGEMENT.md).
- **Add / edit products (new, switch off on live by default):** owners and managers add products with photos, sizes and colours, published straight to the website, and edit them later. Turn on with `POS_PRODUCT_WRITES_APPROVED=true` (+ a WordPress Application Password for photos); see [docs/PRODUCT-MANAGEMENT.md](docs/PRODUCT-MANAGEMENT.md).
- **Purchasing (new):** suppliers, purchase orders with owner approval, receiving full or partial deliveries (adds stock to WooCommerce once, records damaged units), weighted-average cost, stock value at cost and a reorder list that counts stock already on order; see [docs/PURCHASING.md](docs/PURCHASING.md).
- **Customer returns (new, switch off on live by default):** return items from a POS sale with a restock choice per item; refund recorded on the Woo order (Woo restock off), cash out on the open shift, never more than sold or twice. Turn on with `POS_RETURNS_APPROVED=true`; see [docs/CUSTOMER-RETURNS.md](docs/CUSTOMER-RETURNS.md).
- **Windows app (new, QA):** *Mansu POS* for Windows opens this live POS in its own window — online only, every sale made on the server at once, nothing queued offline. Unsigned QA installer from CI; still needs acceptance on the shop PC. See [docs/WINDOWS-ONLINE-TILL.md](docs/WINDOWS-ONLINE-TILL.md).
- **Known limit:** two sales of the same last unit within a second or two (shop and website) are not prevented.

Operate and update it with [docs/RETAIL-CASH-GO-LIVE-RUNBOOK.md](docs/RETAIL-CASH-GO-LIVE-RUNBOOK.md). [docs/README.md](docs/README.md) says which documents are current and which are history.

## Features

- **Register:** product search, category filters, size/colour variations, SKU/barcode lookup and keyboard-wedge scanners (`F2`), cart notes and held sales.
- **Checkout:** cash received/change, idempotent order preparation and recovery of interrupted orders; printable 58 mm, 80 mm and A4 receipts.
- **Shifts:** opening float, cash in/out, expected vs counted cash and variance.
- **Reports:** daily/period sales, payment mix, top products, CSV export; payment reconciliation; daily tasks and weekly staff scorecard.
- **Stock, products, purchasing and returns:** see the status list above. Each writes to WooCommerce, so the website and shop keep one stock count.
- **Wholesale (locked on live):** negotiated per-sale prices with explicit approval and full payment before goods leave.
- **Accounts and security:** owner/manager/cashier roles enforced on the server, hashed passwords, forced password change, lockout, idle session expiry, rate limits, origin checks and an audit log. API keys stay on the server.
- **Operations:** health/readiness endpoints, structured logs, preflight checks, separate demo/staging/live SQLite ledgers with migrations, backup and guarded restore.
- **Installable web app:** manifest, icons and an offline notice. The service worker never caches `/api` responses.

## Run locally

Requires **Node.js 22.13+**.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. The default is demo mode: no credentials, and the app enters as **Demo Owner**.

## Tests

```bash
npm test                 # backend and mocked WooCommerce tests
npm run lint             # ESLint
npm run build            # demo frontend build
npm run build:live       # live/staging build without demo images
npm run test:browser     # browser suites; needs a separate POS_MODE=demo server on port 3000
npm run test:a11y        # axe WCAG A/AA scans; needs the same demo server
```

Browser tests create demo sales. Run them only against an isolated `POS_MODE=demo` server with its own `POS_DATA_DIR`, never staging or live. Set `TEST_BASE_URL` if the server is not on port 3000.

## Deploy

The live service runs under systemd behind nginx on the shop's VPS; [docs/RETAIL-CASH-GO-LIVE-RUNBOOK.md](docs/RETAIL-CASH-GO-LIVE-RUNBOOK.md) covers install, update, switch-over and rollback. `deploy/` also has Docker/Caddy examples and the backup timer. Security notes are in [docs/SECURITY.md](docs/SECURITY.md).

**Never paste API keys, WordPress passwords, payment credentials or customer data into chat, and never commit them to Git.**

## Windows apps

- `npm run dist:online:win` — Mansu POS for Windows, the online till for every shop ([guide](docs/WINDOWS-ONLINE-TILL.md)).
- `npm run dist:practice:win` — offline practice till for training ([guide](docs/POS-PRACTICE-TRIAL.md)).
- `npm run dist:hardware:win` — printer/scanner/drawer test ([guide](docs/HARDWARE-TEST.md)).
- `npm run dist:win` — the older offline till. Locked: it needs a WooCommerce reservation bridge that is not in place.

## Limitations

- Payments are **recorded**, not processed. MoMo/card processing is not integrated, and live checkout is cash-only.
- Checkout needs internet: there is no offline sale queue for the web till.
- Stock checks and order updates are separate WooCommerce requests, so the shop and website can both sell the same last unit within a second or two.
- Opening the cash drawer is not implemented. Check printers and scanners on the actual hardware.
- The local ledger is not an accounting or tax system. Confirm Ghanaian receipt and tax requirements with the owner's adviser ([docs/TAX-DECISION.md](docs/TAX-DECISION.md)).
- Designed for one shop on a single Node process with private persistent storage.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the integration and failure-handling design and [DESIGN.md](DESIGN.md) for design tokens and component rules.
