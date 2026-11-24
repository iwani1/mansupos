# Mansu POS platform (multi-shop) — phase 1

**What it is:** one server process that runs many shops. Each shop has its own web address (`<shop>.<PLATFORM_BASE_DOMAIN>`), its own SQLite database in its own folder, its own staff, sessions and rate limits, and its own WooCommerce store and keys. It is a separate entry point (`server/platform/`); the single-shop MansutRENDZGH server (`npm start`) is unchanged and keeps running live.

**Status (23 Nov 2026):** phase 1 of the [SaaS plan](https://claude.ai/artifact/QqLDEKcVAuoCtrD7ifALHR) is built and tested; not deployed. Sign-up, billing, the web console and the multi-shop Windows till are later phases.

## How a request finds its shop

1. nginx (wildcard certificate for `*.mansupos.com`) passes every request to the platform on `127.0.0.1:3100` with the original `Host`.
2. The platform reads the shop from the host name **before any shop code runs**. Anything that is not exactly `<valid-name>.<base domain>` — unknown, reserved (`admin`, `www`, `api` …), nested or foreign hosts — gets "Shop not found" and opens nothing.
3. Suspended shops get "This shop is paused"; closed shops "Shop not found".
4. The shop's own POS app is opened on first use (its database, its settings and its decrypted keys only) and handles the request exactly like the single-shop server. Idle shops are closed after `PLATFORM_SHOP_IDLE_MINUTES` (default 30); at most `PLATFORM_MAX_OPEN_SHOPS` (default 50) stay open.

## What keeps shops apart

| Layer | Protection | Tested |
|---|---|---|
| Routing | Shop chosen from the host only; strict names; reserved names refused | unknown/reserved/malformed hosts open no shop |
| Data | One SQLite file per shop under `shops/<shop id>/`, named by a generated id (never the chosen name) | sales, staff, shifts and Woo orders invisible to the other shop |
| Ledger binding | Each shop database records its shop id; a copy in another shop's folder, or opened by the single-shop server, refuses to start | swapped database refused |
| Sessions | Tokens live in each shop's own database; cookies are host-only | shop A's token, cookie and password rejected at shop B |
| Cross-shop requests | Each shop accepts writes only from its own `https://<shop>.<domain>` origin | write with shop B's Origin refused |
| Credentials | WooCommerce/WordPress keys AES-256-GCM encrypted in `platform.db`, bound to shop and kind; master key outside the data folder | plaintext absent on disk; a key copied to another shop, edited, or read with the wrong master key fails closed |
| Settings | Each shop's settings are built from scratch from its own record, never inherited from the process environment | — |
| Store address | HTTPS public domain names only (no IP addresses, `localhost`, `.local`, `.internal`, ports, paths) | 13 bad addresses refused |
| Product scope | MansutRENDZGH-only audit, evidence, reviewer, offline-till, in-store and payment-dossier routes and screens do not exist for platform shops | those APIs return 404 |

Tests: `node --test tests/platform-isolation.test.js` (11 tests, part of `npm test`).

## Run it

```bash
npm ci && npm run build:live
export PLATFORM_BASE_DOMAIN=mansupos.com
export PLATFORM_DATA_DIR=/var/lib/mansu-platform
export PLATFORM_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")   # once; store it safely
npm run start:platform        # listens on 127.0.0.1:3100 (PORT, PLATFORM_BIND_HOST)
```

Keep `PLATFORM_MASTER_KEY` in a root-only environment file and in your password manager. Without it, saved shop keys cannot be read after a restore. Do not set `WOO_*` or `POS_TENANT_ID` for the platform process: it refuses to start.

## Admin commands (until the web console)

```bash
npm run platform -- create-shop --slug amaboutique --name "Ama Boutique" --store https://amaboutique.com --owner ama
# prints the owner's temporary password ONCE; they must change it at first sign-in
npm run platform -- set-woo-keys --slug amaboutique      # paste ck_..., Enter, cs_..., Enter (read from stdin, never in shell history)
npm run platform -- set-stage --slug amaboutique --stage read_only    # catalogue visible, no sales
npm run platform -- set-stage --slug amaboutique --stage selling      # cash retail orders to WooCommerce, shifts required
npm run platform -- set-feature --slug amaboutique --feature returns --on   # inventoryWrites | productWrites | returns
npm run platform -- set-business --slug amaboutique --address "..." --phone "..." --receipt-width 80
npm run platform -- set-media-login --slug amaboutique  # WordPress user + application password for photos
npm run platform -- suspend --slug amaboutique          # or resume
npm run platform -- list
npm run platform -- backup [--to /path]                 # central + every shop database, verified, with manifest
```

Changes reach an open shop on its next request once nothing is in flight. Every change is recorded in `platform_audit`.

## nginx (sketch)

```nginx
server {
    listen 443 ssl;
    server_name mansupos.com *.mansupos.com;
    ssl_certificate     /etc/letsencrypt/live/mansupos.com/fullchain.pem;   # wildcard cert (DNS challenge)
    ssl_certificate_key /etc/letsencrypt/live/mansupos.com/privkey.pem;
    server_tokens off;
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Not in phase 1 (next)

- **Outbound address check at connection time:** store names are validated, but a shop's domain could still resolve to a private address. Phase 2 adds a resolver check in the WooCommerce/WordPress HTTP client before shops can enter their own address.
- Self-service sign-up and the WooCommerce "authorise app" flow (phase 2); Paystack billing and the web console (phase 3); multi-shop Windows till (phase 4).
- Backups run on demand (`backup`); schedule them (systemd timer or cron) and copy off-server. Restore is manual for now: stop the platform, put `platform.db` and the shop folders back, start it.
- Background order checks run only while a shop is open; a shop closed while it has an unpaid order is checked again when next opened.
- The Mansutrendz-only modules are switched off for platform shops, not deleted; the single-shop server still uses them.
