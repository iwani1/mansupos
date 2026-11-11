# Security model

## Secrets

- WooCommerce credentials live only in server environment variables or a secret manager.
- Never put secrets in `VITE_*`, browser storage, source control, logs, receipts, or chat.
- Use a dedicated WooCommerce API key with the minimum required permissions.
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

- SQLite data directory should be private (`0700`) and database files `0600`. The Docker image creates its persistent data directory with `0700` permissions; the POS-only Compose variant binds only a chosen loopback port and cannot take over an existing 80/443 proxy. Keep the POS volume separate from other apps and from a future live POS.
- A SQLite exclusive-transaction lease prevents a second POS process or a restore operation from using the same ledger concurrently, even if both containers report PID 1. Abrupt exit releases the lease; it is not multi-server replication.
- Preflight requires a valid first-owner bootstrap credential or an active owner already in the ledger. Remove the bootstrap secret from the server environment after the first owner changes the password.
- Backups must be encrypted/access-controlled and stored off-host. Use the app's integrity-checked online SQLite backup, not a copy of a live WAL database, and test restore on an isolated volume.
- Audit logs record security, staff, shift, and sale events.
- Optional wholesale buyer names (when provided), negotiated unit prices and approving staff are restricted business records in the private POS ledger, Woo order metadata, receipts and reports; do not publish them in screenshots, issues or public test fixtures. Unnamed orders never invent a buyer identity.
- Reports/exports contain cashier names, optional wholesale buyer names and external references; treat them as restricted business records.

## Reporting issues

Do not open public issues containing secrets or customer data. Rotate exposed credentials first, then report the issue privately to the owner/operator.
