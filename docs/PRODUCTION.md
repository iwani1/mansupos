# Production deployment runbook

This application includes production-oriented controls. The code blockers in [AUDIT-2026-11-04.md](AUDIT-2026-11-04.md) have been remediated and regression-tested. **A live-catalogue *read-only* pilot is possible without Woo staging, but it does not authorize checkout.** Trading requires acceptance of the actual store's tax/stock/recovery behavior (preferably on a separate staging clone), hardware verification, tested off-host backups and written owner approval. Do not paste secrets into chat or commit them.

## 1. Prerequisites

- A private Linux host or Docker host with a persistent volume.
- Node.js 22.13+ if not using Docker.
- A dedicated HTTPS hostname, for example `pos.mansutrendzgh.com`.
- For live **checkout** acceptance, a separate WooCommerce staging clone is strongly recommended. The read-only pilot does not need one and must not be used to conduct real test orders.
- WooCommerce REST API credentials stored in a server-side secret manager or root-owned environment file.
- Verified business receipt details, physical printer/scanner acceptance (see [HARDWARE.md](HARDWARE.md)), and external MoMo/card workflow.
- A tested WordPress files/database backup and a POS-ledger backup location.

## 2. Configure

**This section is for a distinct Woo staging clone, not the live read-only pilot.** For the pilot use `.env.live-pilot.example` and its enforced systemd unit in [CONTABO-LIVE-PILOT.md](CONTABO-LIVE-PILOT.md). For staging, copy `.env.production.example` to a private `.env` on the server. Set:

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

Preflight checks configuration, sample `.example` hostnames, build output, data directory, credential presence, first-owner access, and approval gates. It does not replace staging tests.

## 3. VPS with another application: choose an isolated deployment

**For the reported Contabo VPS (host Nginx on 80/443, Next.js on 3000, no Docker), the owner-requested live-catalogue/no-staging path is [CONTABO-LIVE-PILOT.md](CONTABO-LIVE-PILOT.md)**. `/usr/bin/node` 22.23.3 was reported available and port 3187 unused when checked; the POS hostname still needs DNS/HTTPS. The separate native pilot unit forces `127.0.0.1:3187`, its own ledger, a live **Read-only** Woo key and all order/payment write gates off. For an independent Woo **staging** clone instead, follow [CONTABO-NATIVE.md](CONTABO-NATIVE.md), never pointing its staging unit at the live store. Do not install both units on port 3187 simultaneously.

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

## 6. Staging acceptance

1. Set `POS_STAGING_APPROVED=true` only after owner approval for staging tests. Wholesale has a **separate** staging-test gate: `POS_STAGING_WHOLESALE_APPROVED=true` only after explicit approval to test negotiated tax-inclusive amounts on the isolated staging clone. Enabling this flag authorizes a test, not a live release or a claim that tax acceptance passed.
2. Sign in as owner, change the temporary password, create named cashier/manager accounts.
3. Run `docs/ACCEPTANCE.md` against test products and simulated external payments.
4. Verify scanner, printer, paper width, shift open/close, cash movements, reports, audit log, backup, and restore.
5. Establish a WooCommerce-side stock safeguard shared by online/POS sales, or an owner-approved operational control; verify it prevents concurrent last-item overselling on staging. Fresh POS stock reads followed by Woo order updates are not atomic. Also verify interrupted-order reconciliation.
6. Exercise the separate wholesale acceptance checklist: no required buyer selection, optional typed name and unnamed sales, plus owner/manager approval; one or multiple individually priced goods; tax-inclusive final unit amounts under the actual Woo tax settings; no extra tax or fee; full externally verified payment and no credit dispatch. A Woo tax/total mismatch must leave the order unpaid and under review.
7. Record evidence without customer secrets.

## 7. Live approval gate

**Not for `mansu-pos-live-pilot.service`.** That unit enforces read-only access in both startup commands and must never be converted to a trading unit or use its pilot ledger for live sales. This section describes a *future separately reviewed deployment* after acceptance and distinct written authorization.

Live writes require all of:

```dotenv
POS_MODE=live
WOO_BASE_URL=https://www.mansutrendzgh.com
WOO_CONSUMER_KEY=<live-secret>
WOO_CONSUMER_SECRET=<live-secret>
POS_ALLOW_LIVE_WRITES=true
POS_OWNER_APPROVAL_REFERENCE=<written-approval-reference>
```

Take fresh WordPress and POS backups. Run a small owner-approved live smoke test only after staging passes. Never use a real customer payment as a test. Wholesale stays **off** unless documented staging tax acceptance also permits `POS_STAGING_WHOLESALE_APPROVED=true` in the live environment and a distinct written wholesale authorization permits `POS_LIVE_WHOLESALE_APPROVED=true`. Retail's live write gate and legacy trade flags alone are not Wholesale approval; keep the five dispatch-before-payment customers outside this workflow.

## 8. Emergency stop

To stop new sales quickly, set the relevant write gate to `false` and restart:

- Staging: `POS_STAGING_APPROVED=false` (all writes) or `POS_STAGING_WHOLESALE_APPROVED=false` (wholesale only)
- Live: `POS_ALLOW_LIVE_WRITES=false` (all writes) or `POS_LIVE_WHOLESALE_APPROVED=false` (wholesale only)

Keep the POS ledger and WooCommerce orders for reconciliation. With either write gate revoked, POS payment **and remote cancellation** are blocked; the owner must review an unpaid order directly in WooCommerce rather than bypassing the gate. Do not delete orders or restore an old database over new trading data.
