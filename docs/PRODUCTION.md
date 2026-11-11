# Production deployment runbook

This application includes production-oriented controls. The code blockers in [AUDIT-2026-11-04.md](AUDIT-2026-11-04.md) have been remediated and regression-tested, but **production deployment is not complete until staging acceptance passes, hardware is verified, backups are tested off-host, and written owner approval is recorded**. Do not paste secrets into chat or commit them.

## 1. Prerequisites

- A private Linux host or Docker host with a persistent volume.
- Node.js 22.13+ if not using Docker.
- A dedicated HTTPS hostname, for example `pos.mansutrendzgh.com`.
- A separate WooCommerce staging clone for acceptance testing.
- WooCommerce REST API credentials stored in a server-side secret manager or root-owned environment file.
- Verified business receipt details, physical printer/scanner acceptance (see [HARDWARE.md](HARDWARE.md)), and external MoMo/card workflow.
- A tested WordPress files/database backup and a POS-ledger backup location.

## 2. Configure

Copy `.env.production.example` to a private `.env` on the server. Set:

```dotenv
NODE_ENV=production
POS_PUBLIC_ORIGIN=https://pos.your-domain.example
POS_MODE=staging
WOO_BASE_URL=https://staging.your-domain.example
WOO_CONSUMER_KEY=<secret>
WOO_CONSUMER_SECRET=<secret>
POS_STAGING_APPROVED=false
POS_OWNER_USERNAME=owner
POS_OWNER_PASSWORD=<temporary-unique-password>
POS_DATA_DIR=/var/lib/mansu-pos
POS_REQUIRE_SHIFT=true
```

The first owner must change the temporary password at first sign-in. Changing the bootstrap password later does not reset an existing account.

Run:

```bash
npm ci
npm run build
npm run preflight
```

Preflight checks configuration, build output, data directory, credential presence, and approval gates. It does not replace staging tests.

## 3. Deploy with Docker/Caddy

```bash
cd deploy
POS_DOMAIN=pos.your-domain.example docker compose up -d --build
```

The compose file runs the POS as a non-root, read-only container with a persistent SQLite volume. Caddy terminates HTTPS and proxies to the app. Keep port 3000 internal. Back up the `pos-data` volume and Caddy data.

## 4. Deploy with systemd/nginx

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

## 5. Staging acceptance

1. Set `POS_STAGING_APPROVED=true` only after owner approval for staging tests. Paid trade has a **separate** staging-test gate: `POS_STAGING_TRADE_APPROVED=true` only after explicit approval to test negotiated tax-inclusive amounts on the isolated staging clone. Enabling this flag authorizes a test, not a live release or a claim that tax acceptance passed.
2. Sign in as owner, change the temporary password, create named cashier/manager accounts.
3. Run `docs/ACCEPTANCE.md` against test products and simulated external payments.
4. Verify scanner, printer, paper width, shift open/close, cash movements, reports, audit log, backup, and restore.
5. Establish a WooCommerce-side stock safeguard shared by online/POS sales, or an owner-approved operational control; verify it prevents concurrent last-item overselling on staging. Fresh POS stock reads followed by Woo order updates are not atomic. Also verify interrupted-order reconciliation.
6. Exercise the separate paid-trade acceptance checklist: named buyers and owner/manager approval; one or multiple individually priced goods; tax-inclusive final unit amounts under the actual Woo tax settings; no extra tax or fee; full externally verified payment and no credit dispatch. A Woo tax/total mismatch must leave the order unpaid and under review.
7. Record evidence without customer secrets.

## 6. Live approval gate

Live writes require all of:

```dotenv
POS_MODE=live
WOO_BASE_URL=https://www.mansutrendzgh.com
WOO_CONSUMER_KEY=<live-secret>
WOO_CONSUMER_SECRET=<live-secret>
POS_ALLOW_LIVE_WRITES=true
POS_OWNER_APPROVAL_REFERENCE=<written-approval-reference>
```

Take fresh WordPress and POS backups. Run a small owner-approved live smoke test only after staging passes. Never use a real customer payment as a test. Paid trade stays **off** unless documented staging tax acceptance also permits `POS_STAGING_TRADE_APPROVED=true` in the live environment and a distinct written trade authorization permits `POS_LIVE_TRADE_APPROVED=true`. Retail's live write gate alone is not a trade approval; keep the five dispatch-before-payment customers outside this workflow.

## 7. Emergency stop

To stop new sales quickly, set the relevant write gate to `false` and restart:

- Staging: `POS_STAGING_APPROVED=false` (all writes) or `POS_STAGING_TRADE_APPROVED=false` (trade only)
- Live: `POS_ALLOW_LIVE_WRITES=false` (all writes) or `POS_LIVE_TRADE_APPROVED=false` (trade only)

Keep the POS ledger and WooCommerce orders for reconciliation. Do not delete orders or restore an old database over new trading data.
