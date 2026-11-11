# Contabo VPS: install alongside an existing application

**This is a staging-first deployment, not approval to trade live.** Code and mocked/demo checks cannot establish compatibility with the real WooCommerce tax settings, stock concurrency, payment workflow, printer/scanner, or backups. Complete [ACCEPTANCE.md](ACCEPTANCE.md) and obtain distinct written live and Wholesale approval before enabling live writes. Never put passwords, Woo API keys, or customer data in chat, Git, a command transcript, or a public issue.

The POS is a separate Node service and private SQLite ledger; it is **not** a WordPress plugin. Your existing application can keep using ports 80/443. **Do not run `deploy/docker-compose.yml` on this shared VPS**: that example starts a second Caddy bound to 80/443. Use only `deploy/docker-compose.existing-proxy.yml` below until an administrator has reviewed the current proxy setup. The POS-only file publishes one chosen port to `127.0.0.1` on the VPS, never to the internet. All Docker commands below use a distinct Compose project name; never run `docker compose down -v` on the POS or the other application.

## 1. Check the VPS and the Woo staging clone

Ask the VPS administrator to identify the operating system, which process/container owns 80/443, whether the existing reverse proxy is **on the host or in a container**, a free local port (for example 3187), and whether Docker Engine and the Compose plugin are installed. These commands are read-only:

```bash
cat /etc/os-release
sudo ss -ltnp
sudo docker ps --format 'table {{.Names}}\t{{.Ports}}'
sudo docker compose version
```

If the current app binds 80/443 directly, do not start or replace it: an administrator must first plan shared HTTPS routing. The localhost-port setup below assumes a **host-level** Nginx/Caddy proxy. A proxy inside another Docker container cannot reach the VPS's `127.0.0.1`; its administrator must arrange a private shared Docker network instead. Do **not** work around this by publishing POS port 3000 publicly.

WooCommerce staging also needs a **separate HTTPS hostname** (such as `https://staging.mansutrendzgh.com/`), its own WordPress database, staging-only REST credentials, and disabled live email/payment/fulfilment/webhook side effects. A path under `https://mansutrendzgh.com/stagings/` is not a usable `WOO_BASE_URL`: the POS rejects the live hostname in staging and does not accept a path in the store URL. Verify WordPress files/database backups before testing. The POS staging hostname is *different* from the Woo staging hostname.

## 2. Reserve the POS hostname and fetch the code

Create a DNS A/AAAA record at the domain's DNS provider for `pos-staging.mansutrendzgh.com` pointing to the VPS (only add AAAA if IPv6 works). Do **not** change the apex or the other application's DNS. Arrange TLS for this new hostname in the **existing** reverse proxy; do not start another proxy on 80/443.

On the VPS, using a normal administrative shell with `sudo` and an unused installation path:

```bash
sudo install -d -m 0750 -o "$USER" -g "$(id -gn)" /opt/mansu-pos-staging
git clone --single-branch --branch arena/f5331f1d-mansupos https://github.com/iwani1/mansupos.git /opt/mansu-pos-staging
cd /opt/mansu-pos-staging
git status --short --branch
git rev-parse --short HEAD
```

The GitHub repository is public, so cloning needs no GitHub password or access token. Fetching code does not install it or make any WooCommerce changes. Keep this directory and Compose project separate from the existing app.

## 3. Configure staging only, with checkout locked

Copy the example to a private root-owned file and edit it **on the VPS**, not in chat:

```bash
cd /opt/mansu-pos-staging
sudo install -m 0600 -o root -g root .env.production.example .env
sudoedit .env
```

Set `POS_MODE=staging`, `POS_PUBLIC_ORIGIN=https://pos-staging.mansutrendzgh.com`, `WOO_BASE_URL=` to the **distinct Woo staging HTTPS origin with no path**, and `POS_HOST_PORT=3187` **only if** the read-only port check found 3187 unused. Use staging-only Woo REST credentials with the required order/catalogue access; keep them private in the server environment. Provide a unique first-owner username/password (at least 12 characters) and verified receipt details. Keep `POS_STAGING_APPROVED=false` and `POS_STAGING_WHOLESALE_APPROVED=false`. Do not set `POS_MODE=live`, `POS_ALLOW_LIVE_WRITES`, or `POS_LIVE_WHOLESALE_APPROVED`. `POS_DATA_DIR=/var/lib/mansu-pos` is a dedicated named Docker volume, **not** the existing app's volume or WordPress directory.

After the owner first signs in and changes the bootstrap password, remove `POS_OWNER_PASSWORD` from `.env` and recreate **only the POS** container with `sudo docker compose -p mansu-pos-staging -f deploy/docker-compose.existing-proxy.yml up -d --no-deps --force-recreate pos`. The existing owner is stored in the ledger; changing/removing the bootstrap environment value does not reset the account.

## 4. Build, check, and launch the POS alone

Run from `/opt/mansu-pos-staging` after installing Docker/Compose and confirming the private `.env` is complete. The `-p` and `-f` arguments are important; they isolate this project from the existing app. `config --quiet` checks syntax without printing the resolved secrets (do not paste `docker compose config` or `docker inspect` output into chat).

```bash
sudo docker compose -p mansu-pos-staging -f deploy/docker-compose.existing-proxy.yml config --quiet
sudo docker compose -p mansu-pos-staging -f deploy/docker-compose.existing-proxy.yml build pos
sudo docker compose -p mansu-pos-staging -f deploy/docker-compose.existing-proxy.yml run --rm --no-deps pos node server/preflight.js
sudo docker compose -p mansu-pos-staging -f deploy/docker-compose.existing-proxy.yml up -d --no-deps pos
sudo docker compose -p mansu-pos-staging -f deploy/docker-compose.existing-proxy.yml ps
curl --fail --silent http://127.0.0.1:3187/api/health
```

Replace **3187** in the last command if you chose another free `POS_HOST_PORT`. Preflight must pass before starting, but is not a live-store acceptance test. `GET /api/health` proves process liveness; `GET /api/ready` checks the ledger/configuration, and owner **Store connection → Run diagnostics** tests authenticated Woo reads. None of these authorize checkout. Check `sudo ss -ltnp` again: the POS port must listen on `127.0.0.1` only. The app's internal port 3000 must not be opened in the VPS firewall.

## 5. Add one hostname to the existing HTTPS proxy

An administrator must add **only** a new host route for `pos-staging.mansutrendzgh.com` to `http://127.0.0.1:3187` (or your chosen POS host port). Preserve `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, and the actual client IP. Use the existing proxy's certificate/renewal workflow and validate its configuration **before a reload**, without stopping the other app. For a host-level Caddy proxy, the new site block is conceptually:

```caddyfile
pos-staging.mansutrendzgh.com {
    reverse_proxy 127.0.0.1:3187
}
```

For host-level Nginx, add a **separate** TLS virtual host for this hostname with `proxy_pass http://127.0.0.1:3187`, `proxy_set_header Host $host`, `proxy_set_header X-Forwarded-Host $host`, `proxy_set_header X-Forwarded-Proto $scheme`, and a trusted client-IP configuration. Do not replace the other app's server block or launch a second proxy process; the existing proxy administrator should handle TLS and routing. If the proxy is containerized or the other app owns 80/443 directly, **stop here** and get its topology before adding a route.

Verify `https://pos-staging.mansutrendzgh.com/api/health` and the owner sign-in through HTTPS. Sign in, immediately change the temporary password, then remove the bootstrap secret as described above. Do not let this staging POS be an open demo or connect to the live Woo site.

## 6. Back up and test before any checkout authorization

The SQLite ledger is in the Compose project's `pos-data` named volume. **Do not copy a running `.db` file directly:** it uses a WAL; use the online integrity-checked backup command inside the POS container:

```bash
cd /opt/mansu-pos-staging
sudo docker compose -p mansu-pos-staging -f deploy/docker-compose.existing-proxy.yml exec -T pos node server/backup.js /var/lib/mansu-pos/backups
```

The command prints the verified backup's path. Have the administrator copy **that finished backup** out of the container (for example with `sudo docker cp <pos-container-id>:/var/lib/mansu-pos/backups/pos-staging-DATE.db /private/backup/`), store it encrypted off the VPS with retention, and perform a restore drill on an **isolated** volume. Also back up the WooCommerce staging and live WordPress files/databases independently. The `pos-data` volume is not backed up just because the source code is on GitHub or because Contabo offers VPS snapshots.

Only after the staging clone is confirmed isolated and the owner explicitly authorizes dummy staging checkout should an administrator enable `POS_STAGING_APPROVED=true`; Wholesale requires separate authorization for `POS_STAGING_WHOLESALE_APPROVED=true`. Recreate only this POS container after changing flags. Run [ACCEPTANCE.md](ACCEPTANCE.md) with test goods and simulated payments, including Woo tax-inclusive totals, last-item stock concurrency, recovery and physical hardware. A failed test leaves the relevant gate off. Written live/Wholesale approval is a **later, separate** decision.

## 7. Pull updates without touching the other app

After taking a verified POS backup and checking for pending/unreconciled sales, from the POS repository only:

```bash
cd /opt/mansu-pos-staging
git status --short --branch
git pull --ff-only origin arena/f5331f1d-mansupos
sudo docker compose -p mansu-pos-staging -f deploy/docker-compose.existing-proxy.yml build pos
sudo docker compose -p mansu-pos-staging -f deploy/docker-compose.existing-proxy.yml run --rm --no-deps pos node server/preflight.js
sudo docker compose -p mansu-pos-staging -f deploy/docker-compose.existing-proxy.yml up -d --no-deps pos
```

Check the POS health/ready endpoints, Woo diagnostics and existing app afterward. Never run `down -v`, `docker volume prune`, or a host-wide Docker prune: those can delete the POS ledger or the other application's data. A future live POS needs its **own** project name, hostname, private environment, unused port and volume; it must not reuse the staging ledger or credentials, and must not start writing before the recorded staging, stock, backup, hardware and written-approval gates pass.
