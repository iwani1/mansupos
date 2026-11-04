# Daily operations

## Opening the register

1. Sign in with your named account.
2. Open **Shifts & drawer** and count the opening float.
3. Open a shift. In staging/live, checkout is blocked until a shift is open.
4. Refresh the catalogue and check the connection badge.
5. Test the scanner with a known SKU if needed.

## Selling

- Search, tap, or scan products. Variable products open a size picker.
- Hold a sale if needed; held carts are browser-local and do not create orders.
- Prepare the order. WooCommerce confirms the authoritative total and tax.
- Record Cash, MoMo, or Card only after payment is collected/verified externally.
- Print the receipt on the verified printer.

## Interrupted sales

- If checkout or payment confirmation is interrupted, do **not** create a replacement order.
- Go to **Sales history → Reconcile**.
- The server also runs a periodic read-only reconciliation sweep for pending/interrupted sales.
- If reconciliation cannot find the order, an owner must verify WooCommerce before retrying.

## Cash movements

Record cash in/out against the open shift with a reason. Cash out cannot exceed expected drawer cash. MoMo and Card are not drawer cash.

## Closing the shift

1. Resolve pending or interrupted sales.
2. Count the physical drawer.
3. Enter closing cash and a note.
4. Review the variance. The shift records expected cash, counted cash, and variance.
5. Export or review the day’s reports.

## Refunds

Initiate refunds in WooCommerce. Then reconcile the POS sale so net reports update. The POS does not issue payment refunds.

## Backups

```bash
npm run backup -- /private/backup/directory
```

This creates an integrity-checked SQLite backup of the POS ledger. WordPress files/database require separate host-level backups. Store backups off-host and restrict access.

## Restore

Stop the POS service first. Then:

```bash
npm run restore -- /private/backup/pos-live-DATE.db --confirm-restore
```

The restore command verifies integrity, preserves the existing database, and restores the backup. After trading has begun, reconcile WooCommerce orders and stock before resuming sales. Do not blindly restore over new trading data.

## Health checks

- `GET /api/health`: process liveness.
- `GET /api/ready`: database readiness and configuration issues.
- Owner UI: **Store connection → Run diagnostics**.
- Owner UI: **Audit log** for security/staff/shift/sale events.

## Logs

Production logs are structured JSON. They include request IDs, method, path, status, duration, and user ID where available. They must not include passwords, API keys, card numbers, or customer personal information.
