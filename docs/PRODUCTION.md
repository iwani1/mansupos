# Production deployment runbook

This application includes production-oriented controls. The code blockers in [AUDIT-2026-11-04.md](AUDIT-2026-11-04.md) have been remediated and regression-tested. **A live-catalogue *read-only* pilot is possible without Woo staging, but it does not authorize checkout.** Woo-backed trading requires acceptance of the actual store's tax/stock/recovery behavior, hardware verification, tested off-host backups and written owner approval. The owner rejected a separate staging server/clone; use isolated local databases, simulated Woo and (if separately authorized) a temporary local Woo installation subject to the [Phase 1 HOLD and isolated-verification constraints](PHASE1-RELIABILITY.md#isolated-verification-and-remaining-acceptance). An installed-site behavior unsafe to verify is a live-sale blocker. The [cash-only live acceptance plan](LIVE-CASH-ROLLOUT.md) requires separate approval and is **not** a substitute for shared-stock safety or a go-live authorization. Physical [In-store collection](INSTORE-COLLECTION.md) is currently a historical source view only: its former POS-only cash/stock path is retired in non-test services because the owner wants these goods on **the same Woo stock pool**. See the [shared-stock plan](SHARED-WOO-STOCK.md). Do not paste secrets into chat or commit them.

## 1. Prerequisites

- A private Linux host or Docker host with a persistent volume.
- Node.js 22.13+ if not using Docker.
- A dedicated HTTPS hostname, for example `pos.mansutrendzgh.com`.
- No separate staging server/clone is required or recommended for this project. Use isolated **local** synthetic tests and redacted read-only installed-site review; keep live POS gates off if critical installed behavior cannot safely be verified. The read-only pilot must never conduct experimental orders.
- WooCommerce REST API credentials stored in a server-side secret manager or root-owned environment file.
- Verified business receipt details, physical printer/scanner acceptance (see [HARDWARE.md](HARDWARE.md)), and external MoMo/card workflow.
- A tested WordPress files/database backup and a POS-ledger backup location.

## 2. Configure

**Archived staging-template example, NOT part of the current rollout; do not provision a clone/server or follow these commands on the pilot.** For the read-only pilot consult [CONTABO-LIVE-PILOT.md](CONTABO-LIVE-PILOT.md). The example below documents the old mode/config shape only, not a current instruction to create or start an environment:

```dotenv
NODE_ENV=production
POS_PUBLIC_ORIGIN=https://pos-staging.your-domain.example
POS_MODE=staging
WOO_BASE_URL=https://staging.your-domain.example
WOO_CONSUMER_KEY=<secret>
WOO_CONSUMER_SECRET=<secret>
POS_STAGING_APPROVED=false
POS_STAGING_WHOLESALE_APPROVED=false
POS_OWNER_USERNAME=owner
POS_OWNER_PASSWORD=<temporary-unique-password>
POS_DATA_DIR=/var/lib/mansu-pos
POS_REQUIRE_SHIFT=true
```

The first owner must change the temporary password at first sign-in. After that, remove `POS_OWNER_PASSWORD` from the private server environment and restart only the POS; changing or removing the bootstrap value does not reset an existing account. Preflight now refuses a first staging/live deployment with no valid owner bootstrap credentials, but accepts an existing active owner after the secret is removed.

On a host running Node.js directly, run:

```bash
npm ci
npm run build
npm run preflight
```

Preflight checks configuration, sample `.example` hostnames, build output, data directory, credential presence, first-owner access, the **restored-account quarantine** and approval gates. It does not replace local synthetic tests, independent review or production acceptance.

## 3. VPS with another application: choose an isolated deployment

**For the reported Contabo VPS (host Nginx on 80/443, Next.js on 3000, no Docker), the owner-requested live-catalogue/no-staging path is [CONTABO-LIVE-PILOT.md](CONTABO-LIVE-PILOT.md)**. `/usr/bin/node` 22.23.3 was reported available and port 3187 unused when checked; independently verify the POS hostname's current DNS/HTTPS before use. The separate native pilot unit forces `127.0.0.1:3187`, its own ledger, a live **Read-only** Woo key and all order/payment write gates off. The old [CONTABO-NATIVE.md](CONTABO-NATIVE.md) staging-unit guide is **archived**; do not install it or start its port-3187 service, which would conflict with the pilot. This project uses isolated local tests rather than a new server.

If an administrator deliberately chooses to install Docker instead, follow [CONTABO.md](CONTABO.md). Do **not** run the bundled `deploy/docker-compose.yml` on this shared VPS: its Caddy service claims ports 80 and 443. `deploy/docker-compose.existing-proxy.yml` starts **only** the POS under a separate Compose project, requires an explicitly chosen unused `POS_HOST_PORT`, and binds it to the VPS's `127.0.0.1`. The administrator adds a separate HTTPS hostname to the existing **host-level** proxy; no existing app/port is changed. If the existing proxy itself runs inside a container or the existing app binds 80/443 directly, stop and plan a private Docker network/shared proxy route instead of publicly exposing the POS.

## 4. Dedicated VPS only: deploy with Docker/Caddy

The original all-in-one stack is for a dedicated host **where nothing else owns ports 80/443**:

```bash
cd deploy
POS_DOMAIN=pos.your-domain.example docker compose up -d --build
```

It runs the POS as a non-root, read-only container with a persistent SQLite volume. Caddy terminates HTTPS and proxies to the app. Keep port 3000 internal. Back up the `pos-data` volume and Caddy data. Use an explicit Compose project name and separate persistent volumes when operating several environments; never share staging/live ledgers.

## 5. Deploy with systemd/nginx

The generic `deploy/mansu-pos.service`/`deploy/nginx.conf` examples below assume a dedicated host and use port 3000. **Do not install them unchanged on the reported Contabo VPS: port 3000 already belongs to the existing Next.js app.** For live catalogue reads only, use [CONTABO-LIVE-PILOT.md](CONTABO-LIVE-PILOT.md) and `deploy/mansu-pos-live-pilot.service`. For isolated Woo staging orders, use [CONTABO-NATIVE.md](CONTABO-NATIVE.md) and `deploy/mansu-pos-staging.service`. Neither shared-host unit authorizes live checkout.

- Create a `mansu` system user.
- Install the app under `/opt/mansu-pos`, owned by root, readable by `mansu`.
- Store environment in `/etc/mansu-pos/pos.env`, mode `0600`.
- Create `/var/lib/mansu-pos`, owned by `mansu`, mode `0700`.
- Install `deploy/mansu-pos.service`.
- Install `deploy/nginx.conf` and obtain a TLS certificate.
- Restrict direct access to port 3000; expose only HTTPS.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mansu-pos
sudo systemctl status mansu-pos
```

## 6. Isolated local acceptance (no staging-server requirement)

The older `POS_STAGING_APPROVED` and Wholesale staging flags are **not live approvals** and do not require provisioning a separate server. Do not start the old staging unit or use it on the pilot port. Instead:

1. Independently review the Phase 1 restore-security repair and [updated acceptance report](PHASE1-ACCEPTANCE-REVIEW.md). Keep all live gates off.
2. Run isolated local SQLite/automated tests with simulated Woo responses; only with separate approval, use a temporary local synthetic WordPress/Woo installation to test shared stock-owner holds, concurrent last-unit checkout, expiry/cancellation, interrupted requests and tax-inclusive Retail/Wholesale. No live credentials, customer records or payment/email/webhook egress.
3. Obtain redacted read-only installed Woo/WP/PHP/Paystack hook, HPOS, product/variation identity, stock ownership and backup/service identity evidence. If a critical installed-site behavior is unsafe to verify, record **HOLD** rather than claiming a fixture pass or experimenting with a real order.
4. A separate approved bridge-development decision precedes any bridge code; independent code review and **another** approval precede live plugin installation. Verify rollback/incident recovery, WordPress/POS backups, operator roles and hardware before any separately authorized controlled live check. No approval is implied by this document.

## 7. Live WooCommerce order approval gate (not the physical-stock cash gate)

**Not for `mansu-pos-live-pilot.service`.** That unit enforces read-only access in both startup commands and must never be converted to a trading unit or use its pilot ledger for live sales. This section describes a *future separately reviewed deployment* after acceptance and distinct written authorization. Physical-source goods first need a separately reviewed [Woo-backed shared-stock cutover](SHARED-WOO-STOCK.md); the archived POS-only In-store gate must stay off.

Woo Retail/Wholesale order writes require all of:

```dotenv
POS_MODE=live
WOO_BASE_URL=https://www.mansutrendzgh.com
WOO_CONSUMER_KEY=<live-secret>
WOO_CONSUMER_SECRET=<live-secret>
POS_ALLOW_LIVE_WRITES=true
POS_OWNER_APPROVAL_REFERENCE=<written-approval-reference>
```

**Do not set these example live-write flags now.** Independently verify fresh WordPress and POS backups, service/database identity and a rollback/incident plan. The owner rejected a separate staging server: follow the [isolated Phase 1 review/Phase 2 prerequisite record](PHASE1-ACCEPTANCE-REVIEW.md), then request **separate explicit approval** before any live bridge installation or [controlled genuine-sale acceptance](LIVE-CASH-ROLLOUT.md). If critical installed behavior cannot safely be verified, live selling stays disabled; never use a customer order, stock or payment merely as a test. Live POS payment recording is **cash only** for both Retail and Wholesale; Paystack remains for the online checkout. Wholesale stays **off** until distinct owner authorization (`POS_LIVE_WHOLESALE_APPROVED=true`) and a documented live Wholesale acceptance-plan reference (`POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE`, at least eight characters) are available. `POS_STAGING_WHOLESALE_APPROVED` is an old **non-live** flag; never set it in live to claim acceptance. A reference and flags do not prove acceptance or permit general staff access before sign-off. Keep the five dispatch-before-payment customers outside this workflow.

## 8. Emergency stop

To stop new sales quickly, set the relevant write gate to `false` and restart:

- Staging: `POS_STAGING_APPROVED=false` (all writes) or `POS_STAGING_WHOLESALE_APPROVED=false` (wholesale only)
- Live Woo Retail/Wholesale: `POS_ALLOW_LIVE_WRITES=false` (Woo writes) or `POS_LIVE_WHOLESALE_APPROVED=false` (Wholesale only)
- Legacy independent physical-store cash: keep `POS_INSTORE_CASH_APPROVED=false`. Under the client's new [shared-Woo stock target](SHARED-WOO-STOCK.md), this local stock path must **never** be enabled for these goods; branch version 1.2.1 rejects it in production. If an older isolated ledger ever contained POS-only receipts, preserve and reconcile it separately. This flag does not unlock or relock Woo orders.

Keep the POS ledger and any WooCommerce orders for reconciliation. With the Woo write gate revoked, Woo-backed POS payment **and remote cancellation** are blocked; the owner must review an unpaid order directly in WooCommerce rather than bypassing the gate. Locking In-store cash separately stops new POS-only sales/counts but preserves paid receipts and last balances. Do not delete orders or restore an old database over new trading data.
