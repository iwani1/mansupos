# MansuPOS workspace UI — pull and run on your Contabo VPS

**Production application package; no staging website or staging deployment.** These are administrator-operated instructions, **not commands already executed on your VPS**. The GitHub development branch is
`audit/lock-legacy-live-checkout-20261114`. This branch contains both the redesigned UI and the newer Woo shared-stock/cash-recovery code. Its presence in GitHub does not mean that real customer cash sales are authorised.

**Critical:** Do not overwrite or restart the existing read-only `pos.mansutrendzgh.com` pilot, its database or service, even if it appears to run. Do not touch the WooCommerce/Paystack hosting, another app using port 3000, PostgreSQL 5432, or existing Nginx 80/443 listeners. Use a **new live-mode production service** with writes OFF, not a duplicate of the pilot ledger. The repository already contains a separate template `deploy/mansu-pos-live-trading.service` for port 3188 and `trading.mansutrendzgh.com`; the DNS hostname is a proposal, not a verified existing record.

## A. Inspect the VPS without changing services

Run these commands through SSH as a trusted VPS administrator, not in the browser/chat:

```bash
cat /etc/os-release
node --version
npm --version
command -v node
git --version
sudo ss -ltnp
sudo systemctl status mansu-pos-live-pilot --no-pager || true
```

Node must be **22.13.0 or newer**, including `node:sqlite`. If an existing Next.js app uses another Node version, do not replace its runtime; install a separate modern Node binary and update BOTH `ExecStart` and `ExecStartPre` in a reviewed copy of the service. Verify that **127.0.0.1:3188** and `/opt/mansu-pos-live-trading` and `/var/lib/mansu-pos-live-trading` are not already in use. If they are, stop: select new dedicated names/port and update the service accordingly. Never reuse the pilot's port 3187, directory, user, SQLite ledger or Woo integration secrets.

## B. Pull the redesign into a dedicated production application directory

Only on an empty, newly approved directory:

```bash
sudo useradd --system --user-group --home-dir /var/lib/mansu-pos-live-trading --shell /usr/sbin/nologin mansu-pos-trading
sudo install -d -o mansu-pos-trading -g mansu-pos-trading -m 0700 /var/lib/mansu-pos-live-trading
sudo install -d -o mansu-pos-trading -g mansu-pos-trading -m 0755 /opt/mansu-pos-live-trading
sudo -u mansu-pos-trading -H git clone --single-branch \
  --branch audit/lock-legacy-live-checkout-20261114 \
  https://github.com/iwani1/mansupos.git /opt/mansu-pos-live-trading
cd /opt/mansu-pos-live-trading
git rev-parse HEAD
sudo -u mansu-pos-trading -H npm ci
sudo -u mansu-pos-trading -H npm run build:live
```

The one-time `useradd` must be **skipped if the dedicated account already exists and has been verified**. Do not run against a nonempty directory. The public repository requires no GitHub password. The production build excludes demo product illustrations; it does not enable live sales.

## C. Private environment and locked POS systemd unit

Create a dedicated environment file **outside the Git repository**:

```bash
sudo install -d -m 0700 /etc/mansu-pos-live-trading
sudo install -m 0600 /opt/mansu-pos-live-trading/.env.live-trading.example /etc/mansu-pos-live-trading/pos.env
sudoedit /etc/mansu-pos-live-trading/pos.env
```

Set `POS_PUBLIC_ORIGIN` to your final **separate HTTPS production POS hostname**, `WOO_BASE_URL` to your real canonical WooCommerce HTTPS origin, and a **read-only Woo key** if the goal is initially to inspect products. Set a fresh owner bootstrap username and long temporary password, privately. Never paste these credentials in chat or push them to GitHub.

Keep all write approvals FALSE, notably `POS_ALLOW_LIVE_WRITES=false`, `POS_ONLINE_BRIDGE_LIVE_ENABLED=false`, `POS_LIVE_WHOLESALE_APPROVED=false`, `POS_INSTORE_CASH_APPROVED=false`, `POS_DESKTOP_SETUP_APPROVED=false`, and `POS_DESKTOP_RESERVATION_APPROVED=false`. Do not install/activate the WooCommerce POS bridge yet. The supplied trading systemd unit also overrides legacy write flags OFF regardless of the private env file.

The example unit pins the hostname `https://trading.mansutrendzgh.com` and port 3188. **Only use it if this hostname and port are your reviewed choices.** Otherwise update the two systemd commands and your env to match the chosen dedicated origin, bind and data directory; do not edit the pilot unit.

```bash
sudo install -m 0644 /opt/mansu-pos-live-trading/deploy/mansu-pos-live-trading.service \
  /etc/systemd/system/mansu-pos-live-trading.service
sudo systemctl daemon-reload
sudo systemctl start mansu-pos-live-trading
sudo systemctl status --no-pager mansu-pos-live-trading
curl --fail --silent http://127.0.0.1:3188/api/health
```

The service runs Node with `NODE_ENV=production` on **127.0.0.1 only** and a new v9 trading identity. `/api/health` returns process health, not permission to trade. `/api/ready` may intentionally return **503** when checkout is locked; that is a safe expected state. If preflight fails, inspect the service's non-secret error name and fix the actual issue rather than disabling the security checks. Once accepted, `sudo systemctl enable mansu-pos-live-trading` configures restart at boot.

## D. Secure HTTPS access

Ask the administrator to create an independent Nginx HTTPS virtual host for the chosen `POS_PUBLIC_ORIGIN` and proxy to `http://127.0.0.1:3188`. Reuse the **existing Nginx**, not a second proxy or Docker container. Inside the new HTTPS host's `location / `:

```nginx
proxy_pass http://127.0.0.1:3188;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_read_timeout 30s;
```

Obtain a valid certificate using the VPS's existing renewal process, run `sudo nginx -t`, then reload **only** the current Nginx if valid. Do not replace the other application's server block. Do not open port 3188 publicly. Verify the POS hostname over HTTPS, log in as the new owner and change the temporary password. Afterwards remove the bootstrap password from the private env and restart **only** this POS service.

## E. Backups and later code updates

Before each update, investigate incomplete orders and take a verified SQLite backup with the repository's supported backup command and off-VPS copy. **Never restore an older ledger over a newer one.** Then:

```bash
cd /opt/mansu-pos-live-trading
sudo -u mansu-pos-trading -H git status --short --branch
sudo -u mansu-pos-trading -H git pull --ff-only origin audit/lock-legacy-live-checkout-20261114
sudo -u mansu-pos-trading -H npm ci
sudo -u mansu-pos-trading -H npm run build:live
sudo systemctl restart mansu-pos-live-trading
curl --fail --silent http://127.0.0.1:3188/api/health
```

The checkout locks should remain active. For genuine cash selling, a **separate explicit owner-approved operational release** must verify the live installed Woo/Paystack environment, manual refunds, signed bridge/ledger health, receipt and shift operations, and off-host backup/restore. The disposable GitHub tests are strong evidence for **WooCommerce 11.0.1** but cannot guarantee that your real installed plugins behave identically.

**Do not run `docker compose down -v`, delete the data directory, run unattended migrations on the pilot, copy the old pilot DB to trading, activate a Woo plugin, or turn on cash checkout simply to see the redesigned UI.**
