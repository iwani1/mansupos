# Contabo: connect the live WooCommerce catalogue without enabling checkout

**This is a read-only pilot, not permission to sell.** Its existing Contabo installation reported **1.2.0**, `liveReadOnly:true` and HTTPS readiness OK from the VPS after a verified on-host backup/build/restart; an off-VPS pilot-backup copy and external-browser acceptance were not confirmed. This branch's **1.2.2** shared-stock preparation and [installable online-only desktop web app](INSTALLABLE-WEB-APP.md) have **not** been deployed. The owner connected the real `mansutrendzgh.com` store without using its `/stagings/` path. The pilot reads actual products, prices, options and stock with a **Read-only** WooCommerce REST key. It cannot create, reprice, cancel or mark WooCommerce orders paid. Retail, Wholesale and physical **In-store collection** checkout, POS payments and cash shifts are disabled. The [In-store collection](INSTORE-COLLECTION.md) is still a historical CSV/PDF source view, **not** live Woo stock. The client now requests [one shared Woo stock pool](SHARED-WOO-STOCK.md); the old POS-only cash gate must stay off. Do not collect money or release goods using this POS. Local owner sign-in, sessions, audit and catalogue cache **do** write to its own private SQLite ledger.

The reported VPS has host Nginx on 80/443, a separate Next.js app on port 3000 and PostgreSQL on localhost:5432, without Docker. `/usr/bin/node` was reported as v22.23.3 (minimum 22.13); port 3187 was free **when checked**. Recheck before installation. The new POS hostname `pos.mansutrendzgh.com` needs independently verified DNS and HTTPS before use; the repository does not provision either. No action in this guide replaces Node, installs Docker/Caddy, changes the other app or starts a second proxy. [CONTABO-NATIVE.md](CONTABO-NATIVE.md) is for an *independent Woo staging clone* instead; **do not install its staging unit and point it at the live store**.

The dedicated `mansu-pos-live-pilot.service` forces `POS_MODE=live`, `POS_LIVE_READ_ONLY=true`, all live/staging write flags off, `127.0.0.1:3187`, an isolated data directory and `POS_PUBLIC_ORIGIN=https://pos.mansutrendzgh.com` in both preflight and server startup. The code additionally rejects conflicting Woo or In-store cash approval flags and restricts its Woo adapter to **product/variation reads only** (no customer/order reads); online and in-store sale/count mutations are blocked. Its own in-store catalogue reads only the local verified CSV/PDF snapshot, not Woo goods. This unit has **no env-file-only upgrade path to trading**. Its backup unit targets only the pilot ledger. Both pilot units were installed separately by the administrator in the earlier read-only rollout; these repository changes do not install a trading unit.

## 1. Before any installation: origin, DNS and HTTPS plan (read-only checks)

Run on the VPS and share only versions/statuses, never keys, passwords, full Nginx dumps or customer records:

```bash
command -v node; node --version
command -v npm; npm --version
command -v git; command -v sudo
ss -ltn '( sport = :3187 )'
```

Confirm the *canonical HTTPS store origin* without an API key. The Woo adapter intentionally refuses redirects so Basic credentials are never forwarded to another host. A 401/403 on an unauthenticated Woo endpoint can be normal; a 301/302 reveals which **approved** hostname serves it. Do not add `-L`, `-k` or a key to these commands:

```bash
curl -sS -o /dev/null -w 'bare: %{http_code} -> %{redirect_url}\n' --max-time 15 'https://mansutrendzgh.com/wp-json/wc/v3/products?per_page=1'
curl -sS -o /dev/null -w 'www:  %{http_code} -> %{redirect_url}\n' --max-time 15 'https://www.mansutrendzgh.com/wp-json/wc/v3/products?per_page=1'
```

`WOO_BASE_URL` must be **only** `https://mansutrendzgh.com` or `https://www.mansutrendzgh.com`, whichever is the actual canonical Woo endpoint. Do not use HTTP, `/stagings/`, `/wp-admin/`, a URL with a path, or a different store. The test above does not prove authentication; the owner-only connection test later does.

In the DNS provider's panel, the administrator creates an **A** record for `pos.mansutrendzgh.com` pointing to the VPS public IPv4 from the Contabo control panel. Create an AAAA record only if the VPS IPv6 and HTTPS listener are actually configured. Do not guess an address or change the live store's DNS records. Once published, verify with `getent ahostsv4 pos.mansutrendzgh.com`. Check that no Nginx virtual host already claims that exact name; never overwrite an existing one. The administrator must plan a valid, automatically renewed **TLS certificate** for this new host using the VPS's existing Nginx/certificate tooling before opening it to users. Do not disable TLS verification or publish a plain-HTTP sign-in page.

In WooCommerce → Settings → Advanced → REST API, an authorized store administrator creates a **new dedicated key with `Read` permission only**, preferably for a dedicated least-privileged integration user. This changes key configuration but **does not authorize order/stock writes**. Do not reuse an existing Read/Write key, a WordPress password, or an old staging key. Store the one-time key and secret privately on the server, never in chat, Git, command-line arguments, or browser settings. Back up WordPress files/database according to the site's existing policy before administrative changes.

## 2. Prepare a separate Linux identity and code (administrator task)

Proceed only when the origin, DNS/TLS plan and key permissions have been reviewed. If any identity/path below already belongs to another service, **stop and inspect**. With a root shell, leave the existing Next.js user/process, Nginx site and PostgreSQL untouched:

```bash
id mansu-pos-pilot || true
ls -ld /opt/mansu-pos-live-pilot /var/lib/mansu-pos-live-pilot /etc/mansu-pos-live-pilot 2>/dev/null || true
ss -ltn '( sport = :3187 )'
```

Only if the identity and paths are unused and 3187 is still free:

```bash
useradd --system --user-group --home-dir /var/lib/mansu-pos-live-pilot --shell /usr/sbin/nologin mansu-pos-pilot
install -d -o mansu-pos-pilot -g mansu-pos-pilot -m 0700 /var/lib/mansu-pos-live-pilot
install -d -o mansu-pos-pilot -g mansu-pos-pilot -m 0755 /opt/mansu-pos-live-pilot
sudo -u mansu-pos-pilot -H git clone --single-branch --branch arena/f5331f1d-mansupos https://github.com/iwani1/mansupos.git /opt/mansu-pos-live-pilot
sudo -u mansu-pos-pilot -H sh -c 'cd /opt/mansu-pos-live-pilot && npm ci && npm run build:live && test ! -e dist/demo && npm prune --omit=dev'
sudo -u mansu-pos-pilot -H git -C /opt/mansu-pos-live-pilot rev-parse --short HEAD
```

The repository is public and does not need a GitHub token. Install dependencies/build as the new user, **not root**. Keep this code directory and its ledger distinct from the existing app and from any future staging or live-trading POS. Do not place a real `.env` in Git.

## 3. Configure private server settings (no live write approval)

Create the root-owned environment file from the **pilot** template, not `.env.production.example`:

```bash
install -d -m 0700 /etc/mansu-pos-live-pilot
install -m 0600 /opt/mansu-pos-live-pilot/.env.live-pilot.example /etc/mansu-pos-live-pilot/pos.env
sudoedit /etc/mansu-pos-live-pilot/pos.env
```

Use the canonical store HTTPS origin found above for `WOO_BASE_URL`, the new dedicated **Read-only** Woo key/secret, and a unique temporary `POS_OWNER_PASSWORD` of at least 12 characters. Do not reuse the WordPress password. The unit itself imposes the POS HTTPS origin, live-read-only profile, localhost listener, pilot data directory, and all write gates **even if the copied file is wrong**. Leave `POS_ALLOW_LIVE_WRITES=false`, `POS_STAGING_WHOLESALE_APPROVED=false`, `POS_LIVE_WHOLESALE_APPROVED=false`, `POS_INSTORE_CASH_APPROVED=false`, and both owner acceptance references blank. Never set them to true to “test” on the live store. The first owner must change the temporary POS password after sign-in; then remove `POS_OWNER_PASSWORD` from the private file and restart **only** this pilot unit. An existing owner account remains in the ledger.

## 4. Install and test only the pilot service on loopback

The units use `/usr/bin/node`; the VPS report showed v22.23.3. Install only these pilot units, not the generic port-3000 service and not the staging unit:

```bash
install -m 0644 /opt/mansu-pos-live-pilot/deploy/mansu-pos-live-pilot.service /etc/systemd/system/mansu-pos-live-pilot.service
systemd-analyze verify /etc/systemd/system/mansu-pos-live-pilot.service
systemctl daemon-reload
systemctl start mansu-pos-live-pilot
systemctl status --no-pager mansu-pos-live-pilot
curl --fail --silent http://127.0.0.1:3187/api/health
curl --fail --silent http://127.0.0.1:3187/api/ready
ss -ltn '( sport = :3187 )'
```

Preflight fails closed until the build, valid owner bootstrap and Woo key/URLs are present. Health must report `"mode":"live"` **and** `"liveReadOnly":true`. Readiness should return 200 when the local pilot is configured; it **does not test remote Woo credentials** or approve trading. `ss` must show **only `127.0.0.1:3187`**, not `0.0.0.0:3187`; do not open 3187 in the firewall. If 3187 becomes occupied, stop and have the administrator choose another unused localhost port in *both* pilot service commands and Nginx; never reuse 3000. `systemctl enable mansu-pos-live-pilot` is optional **after** checks pass; it changes only this new service's boot behavior.

## 5. Add only a new HTTPS Nginx virtual host

Use the **existing** Nginx and certificate/renewal workflow. Do not replace the Next.js vhost or Nginx's global/default config. The administrator adds a distinct `server_name pos.mansutrendzgh.com` with a valid HTTPS certificate and a new HTTPS `location /` proxying only to `127.0.0.1:3187`, for example:

```nginx
proxy_pass http://127.0.0.1:3187;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_read_timeout 30s;
```

Set up an HTTP → HTTPS redirect for **this hostname only** after certificate issuance. Test with `nginx -t` *before* `systemctl reload nginx`. Never use `curl -k` to hide certificate problems. Check `https://pos.mansutrendzgh.com/api/health` for `liveReadOnly:true`, verify owner sign-in and **Store connection → Test connection / Run diagnostics**, and confirm that the existing Next.js site and live Woo storefront still work. The connection test is a Woo **product GET**; pilot diagnostics intentionally skip reading real customer orders. Do not paste diagnostics containing customer data into chat. A missing/incorrect key, WAF response or canonical-host redirect must be resolved before relying on stock data. A green test counts published Woo products but does **not** prove that every catalogue page/variation was loaded. Check the preview count, unsupported product types, snapshot date, several real prices/stock quantities and any repeated refresh error before showing it to a client. Version 1.1.4 corrects WordPress's `X-WP-TotalPages` pagination header; earlier pilots could silently stop after the first 100 products or variations. If the POS receives an HTML gateway/timeout response during a full refresh, inspect *only the pilot* request timings and its Nginx host; do not change the shared proxy's global settings or turn on checkout.

## 6. Backups and what this pilot cannot do

The pilot's own ledger is `/var/lib/mansu-pos-live-pilot/pos-live.db` (auth, audit, cache and local settings), **not a WooCommerce database**. Use the separate one-shot backup unit for a consistent online SQLite snapshot; do not copy the WAL-backed file while it is running:

```bash
install -m 0644 /opt/mansu-pos-live-pilot/deploy/mansu-pos-live-pilot-backup.service /etc/systemd/system/mansu-pos-live-pilot-backup.service
systemctl daemon-reload
systemctl start mansu-pos-live-pilot-backup
journalctl -u mansu-pos-live-pilot-backup -n 30 --no-pager
```

Encrypt/copy finished integrity-checked backups off-host and perform an isolated restore drill; the same VPS is not off-host protection. Continue the existing WooCommerce files/database backups separately. Do not restore a production POS ledger into this pilot, run a second POS instance on its data directory, or turn on writes by editing this unit or its env file.

**A green catalogue connection is not approval for checkout.** Real retail/Wholesale writes still need actual WooCommerce tax/total, quantity/overselling, payment recovery and hardware acceptance, verified off-host backups and *distinct written owner approval*. The `/stagings/` path is not a safe substitute for an independent test environment. If the owner declines a separate clone, use [LIVE-CASH-ROLLOUT.md](LIVE-CASH-ROLLOUT.md) to review real-order side effects and a supervised **genuine** cash-sale acceptance plan **before** any order write. A future approved trading deployment requires a **new reviewed service and separate ledger**, not a flip of this pilot; Wholesale needs its own written decision and documented live acceptance reference. See [ACCEPTANCE.md](ACCEPTANCE.md).

## 7. Updating an existing pilot without replacing its ledger

After a verified pilot backup and a review of any pending maintenance window, update **only** its service-user-owned code directory. The private `/etc/mansu-pos-live-pilot/pos.env`, `/var/lib/mansu-pos-live-pilot` and the other app must stay untouched. Do not use `git reset --hard`, rebuild as root, or repurpose the pilot unit for trading:

```bash
sudo -u mansu-pos-pilot -H git -C /opt/mansu-pos-live-pilot pull --ff-only origin arena/f5331f1d-mansupos
sudo -u mansu-pos-pilot -H sh -c 'cd /opt/mansu-pos-live-pilot && npm ci --include=dev && npm run build:live && test ! -e dist/demo && test -f dist/manifest.webmanifest && test -f dist/sw.js && test -f dist/offline.html && test -f dist/icons/mansu-192.png && test -f dist/icons/mansu-512.png && npm prune --omit=dev'
sudo -u mansu-pos-pilot -H git -C /opt/mansu-pos-live-pilot rev-parse --short HEAD
systemctl restart mansu-pos-live-pilot
curl --fail --silent http://127.0.0.1:3187/api/health
```

Confirm `liveReadOnly:true`, the reviewed version/commit, HTTPS, owner sign-in, a working product-only connection test and a *complete* refreshed online catalogue before inviting users. For the installable build, also check the public manifest, service worker, offline notice and icons over the **external HTTPS** origin and test installation in Chrome/Edge; see [INSTALLABLE-WEB-APP.md](INSTALLABLE-WEB-APP.md). Installing does not enable offline sales. For 1.2.0, owner/cashier can inspect **In-store collection**: 1,571 items, 41 quarantined and **no Add/cash checkout**, while the in-store import and cash-sale tables remain empty in the pilot ledger. Verify source hashes and the original PDF/CSV before updating; the database migration adds empty in-store tables and must never seed stock on this unit. Do not enable real sales from this service. If any step fails, stop and inspect only this pilot; never restore an older ledger over newer records while it is running.
