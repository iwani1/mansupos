# Mansu POS platform (multi-shop) — phases 1 to 5

**What it is:** one server process that runs many shops. Each shop has its own web address (`<shop>.<PLATFORM_BASE_DOMAIN>`), its own SQLite database in its own folder, its own staff, sessions and rate limits, and its own WooCommerce store and keys. It is a separate entry point (`server/platform/`); the single-shop MansutRENDZGH server (`npm start`) is unchanged and keeps running live.

**Status (23 Nov 2026):** phases 1 (multi-shop core) and 2 (sign-up and store connection) of the [SaaS plan](https://claude.ai/artifact/QqLDEKcVAuoCtrD7ifALHR) 3 (billing and console) and 4 (multi-shop Windows till) are built and tested; not deployed.

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

## Sign-up and shop setup (phase 2)

1. **Sign up** at `https://<base domain>/`: shop name, shop address (live availability check), WooCommerce store address, owner name, email, phone, username, password, terms. Limited to `PLATFORM_SIGNUPS_PER_HOUR` (default 5) per connection; cross-site posts refused; the password is stored only as a scrypt hash.
2. **Confirm the email.** The link (`/verify#token=…`, 24 hours, single use) creates the shop in `setup` stage with a 14-day trial. The owner signs in with the password they chose (no forced change).
3. **Shop setup** (owner only, opens automatically until the shop sells):
   - **Connect store:** sends the owner to their store's WooCommerce *authorise app* page (`/wc-auth/v1/authorize`, Read/Write). WooCommerce posts the new keys to `https://<shop>.<domain>/api/setup/woo/callback`; they are accepted only with this shop's one-time code (30 minutes, single use, Read/Write only) and stored encrypted. The shop moves to **practice mode** (`read_only`: real catalogue, no sales).
   - **Store check:** currency GHS, stock management on, hold-stock minutes, tax setting, published products, SKUs present and unique, simple products tracking stock (first 1,000 products). "Must fix" items block selling.
   - **Receipt details:** name, address, phone, tax ID, footer, paper width.
   - **Optional features:** stock control, product editing, returns (apply once selling).
   - **Start selling:** needs a passing store check from the last 24 hours and an explicit "sales will be real" confirmation. Owners can pause back to practice.
4. **Outbound safety:** every request a platform shop makes to its store (WooCommerce, WordPress photos, the store check) goes through `server/net-guard.js`: HTTPS only, no IP literals, and the connection's own DNS lookup refuses private, loopback, link-local, carrier-grade NAT, metadata, multicast and reserved addresses (IPv4 and IPv6, including IPv4-mapped forms), so DNS rebinding and redirects are covered too.
5. **Email:** `PLATFORM_MAIL_DRIVER=resend` sends through Resend (see phase 5). `outbox` writes messages to `<data>/outbox/` instead (read them with `mansu-platform outbox` on a server, or `npm run platform -- outbox`); the server logs a warning while it is in use in production.

Tests: `tests/platform-signup.test.js` (8 tests).

## Billing and console (phase 3)

**Plans** (GHS, per shop): Starter 250/month (3 staff, no stock control, product editing or returns), Growth 450, Pro 800. Yearly = 10 months' price. Shops created by sign-up start on Growth with a 14-day trial.

**What a shop can do** (`server/platform/billing.js`):

| State | When | Effect |
|---|---|---|
| trial | before the trial ends | everything |
| active | paid up | everything the plan includes |
| grace | up to `PLATFORM_GRACE_DAYS` (7) after trial/payment ran out | everything, with a "payment due" banner |
| lapsed | after grace | read-only: sign-in, history, reports and exports stay; no sales or website changes. Nothing is deleted. Paying restores selling on the next request. |
| comped | set by an admin | everything |
| unbilled | admin-created shop with no trial or payment | everything; flagged in the console |

**Paying** (shop owner, *Billing* page): *Pay for one month/year* (card or Mobile Money, no auto-renew) or *Renew automatically by card* (needs Paystack plans: run `billing-sync-plans` once). Paystack's hosted page takes the money; on return the server verifies the transaction with Paystack and counts it only if it is a success, in GHS, for exactly the amount of our own checkout record, for this shop. Each payment reference extends access once; time is added after any remaining trial or paid period.

**Webhook** `POST https://<base domain>/api/paystack/webhook` (set this URL in the Paystack dashboard): HMAC-SHA512 signature required; `charge.success` (first payments and renewals, matched by checkout record or by plan code + customer), `subscription.create`, `subscription.not_renew`/`subscription.disable` (auto-renew off, paid time kept), `invoice.payment_failed` (status past due; access then follows paid-until + grace). Duplicates are ignored.

**Console** `https://<base domain>/console`: password + authenticator code (TOTP; each code once), 10 sign-in attempts per 15 minutes per connection, 8 failures lock the account 15 minutes, sessions end after 30 idle minutes / 8 hours, host-only `HttpOnly; SameSite=Strict; Secure` cookie. Lists every shop with access state, plan, owner, store connection and check status; per shop: suspend/resume, record an invoice payment (note required), extend trial, change plan, complimentary on/off (reason required), billing events and activity. Every action is in the audit log with the admin's name.

```bash
echo 'a-long-admin-passphrase' | npm run platform -- admin-create --username prince   # prints the authenticator secret once
npm run platform -- billing-sync-plans          # with PLATFORM_PAYSTACK_SECRET_KEY set
npm run platform -- record-payment --slug amaboutique --plan growth --interval monthly --note "INV-0001"
npm run platform -- extend-trial --slug amaboutique --days 7
npm run platform -- set-plan --slug amaboutique --plan starter
npm run platform -- comp --slug amaboutique --on --note "founding shop"
```

Settings: `PLATFORM_PAYSTACK_SECRET_KEY` (sk_test_… for staging; a test key in production also needs `PLATFORM_ALLOW_TEST_BILLING=true`), `PLATFORM_GRACE_DAYS`. Without a Paystack key, shops see "contact support to pay by invoice" and you record payments in the console or CLI.

Tests: `tests/platform-billing.test.js` (6 tests).

## Windows till for many shops (phase 4)

- **One installer** (`desktop/online`, version 2): on first launch a local picker asks for the shop address and the till pins itself to `https://<shop>.<platformDomain>` (or a legacy address listed in `desktop/online/till.json`, e.g. the MansutRENDZGH till). Until a shop is pinned every request is refused; afterwards only that shop's pages and API, and product images from any store's `/wp-content/uploads/`, load. Upgraded MansutRENDZGH tills are offered their old address.
- **Change shop**: owner signed in on that till only; clears sign-in and held sales, keeps printer/drawer settings.
- **Updates**: `npm run platform -- till-release --version 2.0.1 --url https://… --sha256 …` publishes `https://<base domain>/till/latest.json`; tills offer the download (allowed hosts in `till.json`) and Shop setup shows the download link. No silent install until signing.
- **Code signing**: add repository secrets `WIN_CSC_LINK` (base64 .pfx or URL) and `WIN_CSC_KEY_PASSWORD`; the `[online-qa]` CI job then signs and requires a *Valid* signature, otherwise it builds unsigned. A Windows code-signing certificate (OV or EV) has to be bought; EV removes SmartScreen warnings fastest.
- Set `platformDomain` / `updateFeed` in `desktop/online/till.json` to the real domain before the first public build.

Tests: `tests/online-till.test.js` (13), plus the platform release-notice test.

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

## Pilot readiness (phase 5)

**Invitation-only sign-up.** `PLATFORM_SIGNUP_MODE=invite` (the default) needs a code such as `MANSU-K7QP-3XMV` for every sign-up. Create one in the console (**Invitations**) or with `npm run platform -- invite-create`. The code is shown once and only its hash is stored. A code can be limited to one email address, expires after 30 days by default, and works once: it is claimed when the email is confirmed, so if two people start with the same code, only the first to confirm gets the shop. The link `https://<base>/?invite=CODE` fills the code in. `open` mode lets anyone sign up, and a code is then optional.

**Founding prices.** An invitation can carry a discount (for example 50% for 6 months). It is applied when the shop is created, and an admin can change or end it from the shop's page in the console. While it lasts, the Billing page shows the reduced and the usual price, and only one-off payments are offered. Paystack plans have one fixed price, so automatic card renewal is offered again once the discount ends. Manual payments recorded in the console use the discounted price as well.

**Email (Resend).** `PLATFORM_MAIL_DRIVER=resend` with `PLATFORM_RESEND_API_KEY` and `PLATFORM_MAIL_FROM` (`Mansu POS <hello@mansupos.com>`, on a domain verified in Resend with SPF and DKIM). If the confirmation email cannot be sent, sign-up says so (`MAIL_FAILED`) instead of pretending it worked. In production the platform warns at start-up if it is still on `outbox`.

**Reminders.** Each hour the platform emails the owner:
- 3 days and 1 day before the trial ends;
- 5 days before a paid period ends (only for shops not renewing automatically);
- when payment is overdue (grace);
- when sales have paused (lapsed).

Each reminder is sent once per period. One that fails to send is tried again the next hour. Suspended and closed shops get none. `npm run platform -- run-jobs` runs the job now.

**Scheduled backups.** Every `PLATFORM_BACKUP_HOURS` (24 by default, `0` turns them off), the platform writes a verified backup to `PLATFORM_BACKUP_DIR` (default `<data>/backups`). Backups older than `PLATFORM_BACKUP_KEEP_DAYS` (default 14) are pruned. Pruning only removes folders the platform made itself (a timestamped name with a `manifest.json` inside). Copy that folder off the server too, for example with an rsync or rclone timer.

**Feedback.** Every signed-in user of a platform shop has **Feedback & support** in the menu, for a problem, an idea or a question. Messages are limited to 20 per shop per hour. Cashiers see their own messages, and owners and managers see the whole shop's. The console's **Feedback** tab lists open messages. Resolving one with a reply shows that reply on the shop's Feedback page.

**Pilot health.** The console's **Pilot health** tab reads each shop's own database read-only. It shows:
- sales and takings, today and over 7 days;
- the last sale;
- open shifts;
- staff, and the last time anyone signed in;
- **stuck sales**: sales neither paid nor cancelled for over 30 minutes. They are flagged as critical, because a stuck sale is the early sign of a lost one.

It also flags:
- overdue and lapsed billing;
- a failing store check;
- a shop that is selling but has had no sale in 7 days;
- a shop not selling a week after sign-up.

**Terms and privacy.** `/terms` and `/privacy` are drafts, clearly marked as such. They follow the Ghana Data Protection Act, 2012 (Act 843), but **a Ghanaian lawyer must review them**, and Mansu POS must register with the Data Protection Commission before general launch. The privacy notice says closed shops' data is kept for 90 days. That is a policy for now; deletion is manual (see below).

**Deployment files** are in `deploy/platform/`:
- `mansu-platform.service`: systemd, with the network and data settings pinned and the service sandboxed;
- `nginx-platform.conf`: a wildcard certificate, HTTP/2 and a rate limit (the app sets HSTS and the other security headers);
- `platform.env.example`: every setting, with notes;
- `install.sh`: installs, upgrades and checks a server (see **Install on a server** below).

Tests: `tests/platform-pilot.test.js` (6).

### Pilot checklist (outside the code)

1. A server, the domain, and a wildcard certificate for `*.<domain>` (DNS-01).
2. A Resend account with the sending domain verified.
3. A Paystack account. Run the test-mode checks below with `sk_test_` and `PLATFORM_ALLOW_TEST_BILLING=true` on staging, then switch to `sk_live_`. Set the webhook URL to `https://<domain>/api/paystack/webhook`.
4. Create the console admin with `sudo mansu-platform admin-create --username <you>`, and enrol the authenticator.
5. A code-signing certificate for the Windows till (set `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` in CI). Set `platformDomain` / `updateFeed` in `desktop/online/till.json`.
6. Legal review of `/terms` and `/privacy`.
7. Invite 3–5 shops, with a founding price if you like. Watch **Pilot health** daily and answer **Feedback** within a working day.

## Install on a server

On a fresh Ubuntu 24.04 (or Debian 12) server, from a checkout of this repository:

```bash
sudo deploy/platform/install.sh install mansupos.com
```

What `install` does:
- installs nginx, rsync and sqlite3, plus Node.js 22 from NodeSource's signed apt repository if `/usr/bin/node` is older;
- creates the `mansu-platform` account and its folders:
  - `/opt/mansu-platform` (code, owned by root);
  - `/var/lib/mansu-platform` (data, 0700);
  - `/etc/mansu-platform` (settings);
- builds the app;
- writes `/etc/mansu-platform/platform.env` with a **new master key**. It never overwrites an existing settings file. Save the key in your password manager straight away;
- installs the service and the `mansu-platform` admin command;
- configures nginx once the wildcard certificate exists. Without a certificate it prints the certbot command for a DNS-01 challenge;
- starts the platform and checks it answers.

It does not start the platform while a needed setting is empty (for example `PLATFORM_RESEND_API_KEY`), and says which one to fill in. It does not change the firewall; `status` reminds you to.

```bash
sudo deploy/platform/install.sh upgrade   # after git pull
sudo deploy/platform/install.sh status    # running? health? latest backup? what is left to do
```

`upgrade` works in this order:
1. Backs up all data.
2. Checks the new nginx config. If `nginx -t` fails, it puts back the previous nginx config and stops before anything else changes.
3. Builds the new code in a separate folder and swaps it in.
4. Restarts the platform and checks it answers. If the new version does not come up, it **rolls back** to the previous release by itself.

The script is safe to run again.

Admin commands on the server run as the service account with the server's settings:

```bash
sudo mansu-platform list
sudo mansu-platform invite-create --email owner@shop.com --discount 50 --months 6
sudo mansu-platform backup
```

## Restore

```bash
sudo mansu-platform verify-backup --from /var/lib/mansu-platform/backups/<folder>        # changes nothing
sudo systemctl stop mansu-platform
sudo mansu-platform restore --from /var/lib/mansu-platform/backups/<folder>              # shows the plan only
sudo mansu-platform restore --from /var/lib/mansu-platform/backups/<folder> --yes        # whole platform
sudo mansu-platform restore --from /var/lib/mansu-platform/backups/<folder> --shop amaboutique --yes   # one shop only
sudo systemctl start mansu-platform
```

- **Checks before anything changes:**
  - every file matches its checksum;
  - SQLite integrity;
  - each shop copy still names its own shop (`app_meta.tenant_id`), so swapped or renamed files are refused;
  - shop ids are checked, so a manifest cannot point outside the data folder;
  - the backup was made with **this** `PLATFORM_MASTER_KEY` (a fingerprint of the key is stored in `platform.db`) and its saved store keys open with it;
  - enough free disk space.
- **The plan** names any shop that exists now but not in the backup (signed up after it was made). A whole-platform restore would stop serving those shops.
- **Never while running:** the platform and a restore hold a lock on the data folder (`platform.lock`), so a restore refuses while the platform runs, and the platform refuses to start during a restore. A lock left by a crash or from before a reboot is taken over.
- **Nothing is deleted:** the current files are moved to `/var/lib/mansu-platform/pre-restore-<time>/`. Delete that folder by hand once you are happy.
- **After a restore:** anything since the backup is not in the restored data.
  - Check the Paystack dashboard for payments made since then, and record each one in the console (**Record a payment**, with the Paystack reference as the note).
  - Check WooCommerce for orders the tills made since then.
- **Master key:** the platform also refuses to start if `PLATFORM_MASTER_KEY` is not the key its data was created with, instead of failing later on every store.

Tests: `tests/platform-restore.test.js` (4).

## Admin commands added in phase 5

```bash
npm run platform -- invite-create --email owner@shop.com --note "Ama, Osu" --discount 50 --months 6   # code printed once
npm run platform -- invites
npm run platform -- feedback
npm run platform -- run-jobs        # reminders + scheduled backup now
```

## Not built yet (next)

- **Paystack test-mode run** with a real `sk_test_` key covering:
  - plans;
  - a card subscription;
  - a Mobile Money one-month payment;
  - a renewal;
  - a cancellation.

  The code was tested against a fake Paystack; field names follow Paystack's documented API. Confirm whether Mobile Money can auto-renew in Ghana.
- A bot check (Turnstile or hCaptcha) before sign-up is opened to everyone. Invitation-only sign-up does not need one.
- Silent automatic updates for the till (electron-updater), once it is code-signed.
- Deleting a closed shop's data after 90 days is manual.
- Background order checks run only while a shop is open. A shop closed while it has an unpaid order is checked again when it is next opened. Pilot health flags such a sale after 30 minutes.
- The Mansutrendz-only modules are switched off for platform shops, not deleted; the single-shop server still uses them.
