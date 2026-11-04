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

1. Set `POS_STAGING_APPROVED=true` only after owner approval for staging tests.
2. Sign in as owner, change the temporary password, create named cashier/manager accounts.
3. Run `docs/ACCEPTANCE.md` against test products and simulated external payments.
4. Verify scanner, printer, paper width, shift open/close, cash movements, reports, audit log, backup, and restore.
5. Verify concurrent online/POS last-item behavior and interrupted-order reconciliation.
6. Record evidence without customer secrets.

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

Take fresh WordPress and POS backups. Run a small owner-approved live smoke test only after staging passes. Never use a real customer payment as a test.

## 7. Emergency stop

To stop new sales quickly, set the relevant write gate to `false` and restart:

- Staging: `POS_STAGING_APPROVED=false`
- Live: `POS_ALLOW_LIVE_WRITES=false`

Keep the POS ledger and WooCommerce orders for reconciliation. Do not delete orders or restore an old database over new trading data.
