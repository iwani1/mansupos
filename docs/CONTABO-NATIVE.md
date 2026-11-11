# Contabo with existing host Nginx and no Docker: staging POS

**Use this path only after confirming Node.js 22.13+ is available without replacing the runtime used by the existing app.** The reported VPS has host Nginx on 80/443, an existing Next.js app on 3000 and PostgreSQL on localhost:5432; Docker is not installed. This plan does **not** install Docker, start Caddy, stop the existing app, change its Nginx virtual host, or use ports 3000/5432. It installs a **separate staging-only systemd service** on `127.0.0.1:3187` with its own code directory and SQLite ledger. No commands here authorize live checkout.

The native service example enforces `POS_MODE=staging`, `POS_BIND_HOST=127.0.0.1`, `PORT=3187`, a separate data directory and loopback-only proxy trust **even if someone copies a different `.env` template**. Verify the port is still free before use; change *both* service commands together if another process has taken it. The existing Docker instructions remain an alternative only if an administrator deliberately installs Docker later.

## 1. Read-only checks before touching this live VPS

At a root shell:

```bash
command -v node || true
node --version 2>&1 || true
npm --version 2>&1 || true
command -v git || true
ss -ltnp
ls -1 /etc/nginx/sites-enabled
```

The POS requires **Node.js >=22.13**, including `node:sqlite`. The example unit uses `/usr/bin/node`. If that path is missing or its version is too old, **do not upgrade/replace the Node runtime used by the existing Next.js app blindly**. An administrator must provide an isolated Node 22.13+ binary and adjust *both* paths in the copied unit, or choose the reviewed Docker route instead. If `/usr/bin/node` already meets the requirement, the two apps may share that binary while keeping their services and data separate. Do not paste Nginx dumps, `.env`, certificates, keys, passwords or application logs containing customer data into chat.

Confirm `3187` is unused; leave 80/443, 3000 and 5432 alone. Confirm the **WooCommerce staging site has its own HTTPS hostname**, separate WordPress database, and disabled live emails, payments, fulfilment and webhooks. A path such as `https://mansutrendzgh.com/stagings/` on the live hostname cannot be used as `WOO_BASE_URL`. Back up WordPress before staging tests.

## 2. Prepare a dedicated identity and code (administrator task)

After verifying the `mansu-pos` account and `/opt/mansu-pos-staging` path are not already in use by another service, create them. Run from a root shell; do not run package installation as root:

```bash
useradd --system --user-group --home-dir /var/lib/mansu-pos-staging --shell /usr/sbin/nologin mansu-pos
install -d -o mansu-pos -g mansu-pos -m 0700 /var/lib/mansu-pos-staging
install -d -o mansu-pos -g mansu-pos -m 0755 /opt/mansu-pos-staging
sudo -u mansu-pos -H git clone --single-branch --branch arena/f5331f1d-mansupos https://github.com/iwani1/mansupos.git /opt/mansu-pos-staging
sudo -u mansu-pos -H sh -c 'cd /opt/mansu-pos-staging && npm ci && npm run build && npm prune --omit=dev'
```

The public repository needs no GitHub password or token. Record `git -C /opt/mansu-pos-staging rev-parse --short HEAD` for acceptance evidence. The code directory and data directory must not be used by the existing Next.js or PostgreSQL services. If `mansu-pos` already exists or the directory is nonempty, **stop and inspect rather than overwriting it**.

## 3. Configure private staging-only settings

Only after the distinct Woo staging origin is confirmed, create a root-owned, mode-0600 environment file **on the VPS**:

```bash
install -d -m 0700 /etc/mansu-pos-staging
install -m 0600 /opt/mansu-pos-staging/.env.production.example /etc/mansu-pos-staging/pos.env
sudoedit /etc/mansu-pos-staging/pos.env
```

Use the actual separate Woo staging HTTPS origin **without `/wp-admin/` or a path** for `WOO_BASE_URL`; use staging-only REST credentials, kept out of Git/chat. Set `POS_PUBLIC_ORIGIN` to the new POS HTTPS hostname, for example `https://pos-staging.mansutrendzgh.com`. Set `POS_MODE=staging`, `PORT=3187`, `POS_BIND_HOST=127.0.0.1`, `POS_DATA_DIR=/var/lib/mansu-pos-staging`, `POS_TRUST_PROXY=loopback`, `POS_OWNER_USERNAME` and a unique temporary `POS_OWNER_PASSWORD` (at least 12 characters). The service unit also enforces the mode/port/bind/data/proxy values. Keep `POS_STAGING_APPROVED=false` **and** `POS_STAGING_WHOLESALE_APPROVED=false`; leave all live flags off. Fill only owner-verified receipt details. The example `.example` URLs will fail preflight until replaced.

After the first owner changes the bootstrap password in the POS, remove `POS_OWNER_PASSWORD` from this file and restart **only** `mansu-pos-staging`; the owner account remains in the ledger. Protect this file and your server login with a password manager. Never put Woo keys in a `VITE_*` variable or browser.

## 4. Install and check only the staging POS service

The template `deploy/mansu-pos-staging.service` specifies `/usr/bin/node`; verify that path is Node 22.13+ before copying it. If using a separately installed Node binary, an administrator must edit both `ExecStartPre` and `ExecStart` in the copy. From a root shell:

```bash
install -m 0644 /opt/mansu-pos-staging/deploy/mansu-pos-staging.service /etc/systemd/system/mansu-pos-staging.service
systemctl daemon-reload
systemctl start mansu-pos-staging
systemctl status --no-pager mansu-pos-staging
curl --fail --silent http://127.0.0.1:3187/api/health
ss -ltnp
```

`ExecStartPre` runs `server/preflight.js`; a failure means do **not** expose the POS until corrected. The API health response must show `mode: staging` and the expected version. In `ss`, only **127.0.0.1:3187** should serve the POS, not `0.0.0.0:3187`. If the port is not available, stop the POS unit and have the administrator select another unused localhost port in **both** service commands and the Nginx route. Do not open the POS port in the public firewall. Once verified, `systemctl enable mansu-pos-staging` makes only this new service start after reboot.

## 5. Add a separate HTTPS Nginx hostname (administrator task)

Create a DNS record for a POS *test* hostname pointing to the VPS. Use the existing Nginx and certificate/renewal setup to add a **new virtual host**, not a new proxy process or a replacement for the existing Next.js site. The new host must route to `http://127.0.0.1:3187` and preserve `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` and the actual client IP. For example, within the new host's HTTPS `location /`:

```nginx
proxy_pass http://127.0.0.1:3187;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_read_timeout 30s;
```

The administrator must obtain a valid certificate for that hostname using the existing TLS method. Validate `nginx -t` **before** `systemctl reload nginx`; never overwrite or stop the current site's virtual host. Verify the new HTTPS `/api/health` and owner sign-in, and that the existing application still works. Keep staging checkout locked until the owner explicitly authorizes dummy staging tests.

## 6. Backups, acceptance and future updates

The ledger is `/var/lib/mansu-pos-staging/pos-staging.db`. **Never copy this file while the app is running**; SQLite also uses a WAL. The separate one-shot backup unit runs `server/backup.js` with the same staging environment (adjust `/usr/bin/node` there too if needed). After the POS has started, an administrator can create a verified local backup with:

```bash
install -m 0644 /opt/mansu-pos-staging/deploy/mansu-pos-staging-backup.service /etc/systemd/system/mansu-pos-staging-backup.service
systemctl daemon-reload
systemctl start mansu-pos-staging-backup
journalctl -u mansu-pos-staging-backup -n 30 --no-pager
```

Only copy the **finished, integrity-checked backup** from `/var/lib/mansu-pos-staging/backups/` to encrypted off-host storage; test restore on an isolated volume and plan retention/scheduling. A backup left on the same VPS is not off-host protection. Back up WooCommerce's files/database separately. [ACCEPTANCE.md](ACCEPTANCE.md) includes tax/total, concurrent stock, recovery, physical hardware, staff and reporting checks. Only explicit owner approval for isolated staging orders permits `POS_STAGING_APPROVED=true`, and Wholesale needs its own `POS_STAGING_WHOLESALE_APPROVED=true`. Written live approval is a later decision; this staging-only unit cannot be used as a live POS.

Before a later update, take an integrity-checked POS backup and resolve or record pending orders. Use the same branch, then rebuild as the dedicated user and restart only this unit:

```bash
sudo -u mansu-pos -H git -C /opt/mansu-pos-staging pull --ff-only origin arena/f5331f1d-mansupos
sudo -u mansu-pos -H sh -c 'cd /opt/mansu-pos-staging && npm ci && npm run build && npm prune --omit=dev'
systemctl restart mansu-pos-staging
curl --fail --silent http://127.0.0.1:3187/api/health
```

Do not restore an old ledger over new trading data, install a second POS process on the same ledger, expose 3187 publicly, or modify the existing app's service or database.
