# Setup and safe deployment

**Current decision (owner-stated handoff date 2026-11-14 UTC): the owner rejected a separate staging server/clone. The old staging setup examples below are archived, NOT instructions for this rollout.** Use the [Phase 1 HOLD/isolated-test record](PHASE1-ACCEPTANCE-REVIEW.md), independent Phase 1 restore review and explicit approval before bridge development; a later live installation needs another separate approval. Do not buy/provision infrastructure or start the old staging unit at pilot port 3187. The reported Contabo **live Woo catalogue pilot** is read-only; see [CONTABO-LIVE-PILOT.md](CONTABO-LIVE-PILOT.md). Old optional [CONTABO-NATIVE.md](CONTABO-NATIVE.md)/Compose examples do not authorize trading or changing the other VPS app.

## 1. Read-only audit first

The repository does not contain the WordPress installation or owner credentials. The public Store API was reachable, but this is **not** a completed site audit.

Before **any separately approved production change**, request redacted read-only evidence; do not follow the archived installation steps to gather it:

- WordPress, WooCommerce, and PHP versions; hosting environment.
- Active theme/child theme and relevant checkout, inventory, payment, cache, security, backup, and product plugins.
- WooCommerce stock management, stock-hold duration, backorders, tax, currency (GHS), and order-status settings.
- Product/variation counts; missing/duplicate SKUs; variation-level stock quality.
- Whether Paystack or another gateway is installed. Do not assume it supports POS terminal collection.
- Full backup location, date, access controls, and a tested restoration procedure.
- How optional **temporary local synthetic** fixtures block all live email, webhook, fulfilment, analytics and payment side effects; no staging hostname is required.
- Exact computer/tablet OS and browser, scanner model/interface, printer model/paper width/interface, cash drawer, and terminal models.

Use counts and configuration summaries, not customer records.

## 2. Archived staging-template notes — not current setup

**Do not prepare a separate staging clone/server for this project.** The old checklist below describes settings from an earlier optional template; it is superseded by isolated **local** synthetic testing, not a purchase or installation instruction. The application rejects the production hostname when `POS_MODE=staging`, but that flag alone is not a security boundary.

- Prefer sanitized customer/order data.
- Disable real customer emails, live fulfilment, live payment capture, and production webhooks.
- Keep the staging site and POS database private.
- Verify the staging WooCommerce REST API is enabled and HTTPS works.
- Create a dedicated WordPress account for the integration where possible. Grant only the WooCommerce/product/order access needed; do not use the owner’s personal administrator login.
- In WooCommerce → Settings → Advanced → REST API, create a key with the minimum permissions required. Catalogue-only testing can use Read. Checkout requires Read/Write for orders. The application never sends product/stock edit requests.
- Store credentials in the host’s secret manager or a root-owned environment file. Never put them in `VITE_*` variables, browser storage, source control, logs, or chat.

## 3. Configure the POS server

Copy `.env.example` to a private `.env` on the server. Example **placeholders only**:

```dotenv
POS_MODE=staging
WOO_BASE_URL=https://staging.your-domain.example
WOO_CONSUMER_KEY=<from-secret-manager>
WOO_CONSUMER_SECRET=<from-secret-manager>
POS_STAGING_APPROVED=false
POS_OWNER_USERNAME=owner
POS_OWNER_PASSWORD=<unique-password-at-least-12-characters>
POS_DATA_DIR=/var/lib/mansu-pos
PORT=3000
NODE_ENV=production
POS_ORDER_STATUS=completed
POS_LOW_STOCK_THRESHOLD=5
```

The first owner is created only when no owner exists. Changing the bootstrap password later does **not** reset an existing account. Use the in-app password change feature or the documented administrative recovery procedure.

Build and start:

```bash
npm ci
npm run build
npm start
```

Put the Node service behind an HTTPS reverse proxy. Bind the service to `0.0.0.0` only when the host/network requires it; restrict direct access to port 3000 and expose only HTTPS. The proxy must preserve the public `Host` or set `X-Forwarded-Host` correctly. Do not enable permissive CORS.

A production `Dockerfile` is included. Build it with `docker build -t mansu-pos .`, then run it with the private environment file and a persistent volume mounted at `/var/lib/mansu-pos`. Publish the internal port 3000 only to the host’s reverse proxy on an **unused loopback host port** (for example `127.0.0.1:3187:3000` on a shared VPS), not directly to the public internet. The container runs as the non-root `node` user.

Use a persistent, private volume for `POS_DATA_DIR`. The application uses separate `pos-demo.db`, `pos-staging.db`, and `pos-live.db` files. Do not share one writable database between multiple Node processes.

### Staging checkout gate

After the owner approves staging testing, set `POS_STAGING_APPROVED=true` and restart. Until then, authenticated catalogue reads can work but checkout is blocked.

**Wholesale is a separate workspace and gate.** Only on the isolated staging clone, after the owner explicitly authorizes testing negotiated tax-inclusive prices, set `POS_STAGING_WHOLESALE_APPROVED=true` and restart. This flag allows tests; it does **not** mean the tests passed. On the dedicated **Wholesale** page (not the retail register), an owner or manager adds goods immediately, optionally enters a buyer name directly (no selection required), enters a final tax-inclusive unit amount for every line, chooses **Review quote** and explicitly approves it. The catalogue price is a reference, not a discount rule. The POS creates a pending Woo order and derives pre-tax line amounts from Woo's tax calculation; it refuses payment if the returned lines, taxes, total, optional name (or its absence), approver or payment verification cannot be confirmed. There is no quantity-break pricing and **no wholesale dispatch on credit**. Keep Wholesale locked if any staging test fails.

For the actual staging acceptance, verify the in-store collection tax location Woo applies both with an optional buyer name and with no buyer name (neither supplies a delivery address), and test taxable/exempt tax classes, multiple items/quantities, rounding to the cent, product/variation metadata, lost order/update responses, and an externally simulated full payment. Do not use this workflow for deliveries with an unverified taxable location. See [ACCEPTANCE.md](ACCEPTANCE.md). Do not use a real customer transaction as a test.

Create individual cashier accounts in Staff & access. Share temporary credentials through the owner’s approved password manager, not the handover report. Staff should change their password after first sign-in.

## 4. Hardware

See [HARDWARE.md](HARDWARE.md) for the owner-supplied counter hardware profile and device-specific setup notes.

- Scanner: configure USB/Bluetooth keyboard (HID) mode with an Enter/Return suffix. Test an existing SKU and a variation SKU. `F2` opens the scan field.
- Printer: install the manufacturer’s trusted driver. Select 58 mm, 80 mm, or A4 in the receipt dialog. Disable browser headers/footers and unwanted scaling if necessary. Test alignment and cutting on the actual device.
- Cash drawer: not triggered by this version. Do not assume a browser print action opens it.
- Card terminal: use the acquirer’s approved standalone terminal. Verify its receipt/approval reference before recording Card in the POS.
- MoMo: verify the merchant app/SMS notification, not a customer-supplied screenshot alone. Record the merchant transaction reference.

## 5. Acceptance and live approval

Complete `docs/ACCEPTANCE.md`, including parent-shared variation stock and concurrent online/POS last-item controls. The POS does not atomically reserve stock: agree on a WooCommerce-side safeguard shared by both channels or an approved operational control. Staging is preferred; if the owner declines it, follow [LIVE-CASH-ROLLOUT.md](LIVE-CASH-ROLLOUT.md) to document the accepted risks and a supervised genuine cash-sale plan before any live write. Keep evidence without customer secrets. Obtain written approval identifying the version, environment, hardware, payment workflow, limitations, and reconciliation plan.

Live mode requires **all** of these deliberate gates:

```dotenv
POS_MODE=live
WOO_BASE_URL=https://www.mansutrendzgh.com
WOO_CONSUMER_KEY=<live-key-from-secret-manager>
WOO_CONSUMER_SECRET=<live-secret-from-secret-manager>
POS_ALLOW_LIVE_WRITES=true
POS_OWNER_APPROVAL_REFERENCE=<written-approval-reference>
```

The approval reference must be at least eight characters. This is a deployment guard, not a substitute for actual written approval. **Retail approval and legacy trade flags never enable Wholesale.** Wholesale also needs `POS_LIVE_WHOLESALE_APPROVED=true` (a distinct written owner decision) and an at-least-eight-character `POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE` pointing to a documented live acceptance plan/record. Staging's approval flag does not count toward live authorization. Leave the live wholesale flag false until a supervised, risk-reviewed live acceptance plan is approved; general Wholesale trading needs signed-off actual tax/stock/recovery results. The five dispatch-before-payment buyers remain a future, separately approved workflow.

Before any separately approved live sale, independently verify full WordPress and POS-ledger backups, off-host restore evidence, actual service/database identity, rollback and incident response. Use isolated local synthetic tests and read-only installed-site hook/stock evidence; **no separate staging server**. If critical installed behavior cannot safely be verified, stay read-only. Never manufacture a real customer order or use customer money/stock merely as a test. A genuine controlled cash sale needs its **own** explicit approval after safety gates pass. Live POS is cash-only; keep online Paystack unchanged. See [LIVE-CASH-ROLLOUT.md](LIVE-CASH-ROLLOUT.md).

## 6. Backup and rollback

```bash
npm run backup -- /private/backup/directory
```

This uses SQLite’s online backup API and runs `PRAGMA integrity_check` on the copy. It backs up the **POS ledger only**. The WordPress files/database require a separate host-level backup.

To stop new sales quickly, set the relevant write gate to `false` and restart. Keep the POS ledger and WooCommerce orders for reconciliation. Do not delete orders or restore an old database over new trading data. After trading begins, recover by reconciling transactions and stock, not by blindly restoring a backup.

## 7. Operational notes

- The app is online-first. An outage blocks checkout; it does not queue payments.
- Use Sales → Reconcile after an interrupted create/payment confirmation. Never create a replacement order until the original is verified.
- Initiate refunds in WooCommerce. Reconcile the order afterward to update net POS reports.
- CSV exports contain cashier names and external payment references. Treat them as restricted business records.
- Review WordPress/WooCommerce/plugin updates and dependency advisories regularly.
