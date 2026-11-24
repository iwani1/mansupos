# Security model

## Secrets

- WooCommerce credentials live only in server environment variables or a secret manager.
- Never put secrets in `VITE_*`, browser storage, source control, logs, receipts, or chat.
- Use a dedicated WooCommerce API key with the minimum required permissions. The live catalogue pilot uses a new **Read-only** key; checkout later requires separate reviewed credentials and approval. Never put a Read/Write live key in the pilot environment.
- Rotate keys if exposed. Revoke old keys in WooCommerce.

## Authentication

- Named owner/manager/cashier accounts; no shared counter login.
- Salted scrypt password hashes.
- Temporary bootstrap/reset passwords force a change at next sign-in.
- Password policy rejects short, common, repetitive, or username-containing passwords.
- Failed logins are rate-limited and accounts lock temporarily after repeated failures.
- Sessions use random tokens; only token hashes are stored.
- Sessions expire after 8 hours and idle out after a configurable period (default 60 minutes).
- Password change/reset revokes other sessions.
- Cookies are HTTP-only and Secure in production. Staging/live cookies are SameSite=Strict; the isolated production demo uses SameSite=None so it can run inside an embedded preview. The browser also keeps a bearer token in memory and sends it as `Authorization: Bearer …` plus an explicit `X-Mansu-Session` fallback for preview proxies that strip `Authorization`. The fallback carries the same server-side session token and does not bypass authentication, origin checks, roles, or live-write gates.

## Authorization

- Owner: staff, connection, audit, all sales/reports/shifts; can enter an optional wholesale buyer name and approve negotiated prices.
- Manager: all POS sales/reports/shifts and optional name/price approval; no staff/connection management.
- Cashier: own sales and own shifts; no wholesale preparation/approval, historical buyer directory, reports/staff/connection/audit.
- Reviewer (retired): accounts made for the removed stock-evidence workflow are refused at sign-in and on every API call. Deactivate any that remain under Staff.
- Permissions are enforced by the API, not only hidden in the UI.

## Request protection

- Mutating API requests require JSON and same-origin checks.
- Production can require a configured `POS_PUBLIC_ORIGIN`.
- Helmet sets CSP, HSTS, nosniff, referrer policy, and related headers in production.
- Rate limits protect login and sensitive mutations.
- CSV cells are escaped to reduce spreadsheet-formula injection.
- Full card numbers are rejected in payment references.

## Payment boundary

The POS records externally collected payments. It does not process MoMo or card payments, store PAN/PIN/CVV, or connect to a payment gateway. MoMo/Card references must be merchant/terminal references, not customer card data. Wholesale orders also require a separately authorized write gate, an approved tax-inclusive quote, an exact WooCommerce tax/total match and a matching full POS payment record before they can be marked paid. Neither **Leave unpaid** nor the unimplemented five-account dispatch-on-credit exception permits unpaid wholesale goods to be released.

## Data protection

- SQLite data directory should be private (`0700`) and database files `0600`. The Docker image creates its persistent data directory with `0700` permissions; the POS-only Compose variant binds only a chosen loopback host port. On the reported host-Nginx VPS, the staging unit **or** the new live-catalogue pilot unit enforces `127.0.0.1:3187` and a distinct private ledger (not both on that port). Neither route takes over the existing 80/443 proxy or port 3000. The pilot unit forces all checkout flags off, and the Woo adapter also refuses non-read requests when writes are locked. Keep staging/pilot/future trading ledgers separate from other apps and from each other.
- A SQLite exclusive-transaction lease prevents a second POS process or a restore operation from using the same ledger concurrently, even if both containers report PID 1. Abrupt exit releases the lease; it is not multi-server replication.
- Preflight requires a valid first-owner bootstrap credential or an active owner already in the ledger. Remove the bootstrap secret from the server environment after the first owner changes the password.
- Backups must be encrypted/access-controlled and stored off-host. Use the app's integrity-checked online SQLite backup, not a copy of a live WAL database, and test restore on an isolated volume.
- Audit logs record security, staff, shift, and sale events. The separate in-store import, cash sales and counted adjustments retain source hashes, idempotency keys and movement records in the private ledger. The user approved publishing the source product CSV and physical-stock PDF (including supplier costs and quantities); the private POS ledger and customer/cashier data are not approved for publication.
- Optional wholesale buyer names (when provided), negotiated unit prices and approving staff are restricted business records in the private POS ledger, Woo order metadata, receipts and reports; do not publish them in screenshots, issues or public test fixtures. Unnamed orders never invent a buyer identity.
- Reports/exports contain cashier names, optional wholesale buyer names and external references; treat them as restricted business records.

## Reporting issues

Do not open public issues containing secrets or customer data. Rotate exposed credentials first, then report the issue privately to the owner/operator.

## Security review — 23 Nov 2026

Code review of the POS server and web app plus passive checks of the live service (ordinary requests only; no attack traffic).

**Already in good shape (verified):** session tokens are random, stored only as SHA-256 hashes, `httpOnly` + `SameSite=Strict` cookies, kept in browser memory (never `localStorage`); every write checks the request Origin and requires JSON; owner/manager/cashier roles are enforced on the server, and cashiers can only see/act on their own sales and shifts; sign-in has per-IP rate limits, account lockout and equal timing for unknown usernames; staff deactivation and password resets end that person's sessions; strict CSP (`script-src 'self'`), HSTS, `nosniff`, `frame-ancestors`; unexpected errors return a generic message; photo uploads are checked by file signature, size-capped and owner/manager only; no raw-HTML rendering in the web app; `/.env`, `/.git` and other paths only return the app shell; `trust proxy` is loopback-only, so `X-Forwarded-For` cannot be forged to dodge rate limits; `npm audit`: 0 known vulnerabilities.

**Fixed in this change:**

| Severity | Issue | Fix |
|---|---|---|
| Medium | Product name, option names/values, SKU and new category name could contain HTML. They are published through a WordPress administrator's Application Password (which may store raw HTML), so a misused manager account could plant a script on the public shop (stored XSS). | `<` and `>` are refused in those fields (descriptions were already HTML-escaped). |
| Low–Medium | Passwords hashed with scrypt N=2¹⁴, below OWASP's recommendation, and synchronously, so each sign-in paused the whole POS. | OWASP parameters (N=2¹⁵, r=8, p=3), hashed off the main thread; each person's old hash is upgraded automatically at their next sign-in. |
| Low | Simultaneous wrong passwords could undercount failed attempts (read-then-write). | Atomic increment in SQLite. |
| Low | Signed-out `/api/session` listed every feature switch, the version and business details. | Signed out it returns only mode, configured, read-only flag and business name; the rest comes after sign-in. |
| Low | Purchasing and stock CSV exports missed formulas hidden behind leading spaces/tabs (spreadsheet formula injection). | Same neutralising as the other exports. |
| Low | No `Permissions-Policy`. | Camera, microphone, location, payment, USB, serial, Bluetooth and similar are denied. |

**Needs a server change (not in this repo):** the live nginx reveals its exact version (`Server: nginx/1.24.0 (Ubuntu)`), and its default 1 MB body limit refuses product photos larger than 1 MB. Apply [`deploy/nginx-pos-hardening.conf`](../deploy/nginx-pos-hardening.conf) (`server_tokens off`, 10 MB body limit for the POS, an nginx rate limit on sign-in, no dotfiles).

**Accepted / to decide:**
- Account lockout (8 failures → 15 minutes) lets someone who knows a username keep that account locked. The per-IP limit and nginx rate limit reduce this; consider owner-only alerts if it happens.
- Until everyone has signed in once after this update, accounts with old hashes answer slightly faster than unknown usernames.
- `img-src https:` in the CSP allows images from any HTTPS site (needed while product photos may come from a CDN).
- Windows till: *Open cash drawer now* is available to anyone signed in at that PC and logged only on that PC.
- The WordPress/WooCommerce site itself (plugins, admin accounts, Application Passwords) is outside this review; give the POS's Application Password to a dedicated user with only the rights it needs.
