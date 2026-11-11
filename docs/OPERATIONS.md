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

## Wholesale workspace (owner or manager only)

1. Open the **Wholesale** navigation page, not the retail register. Only proceed when the separate wholesale gate is authorized. Start with goods; you do **not** need to select or create a buyer. If useful, type a **buyer name (optional)** in the quote; leave it blank for an unnamed sale. Neither choice creates payment terms or a credit limit.
2. Add one or several goods. Enter the **negotiated final unit price, including applicable tax**, for *each* product/option. Quantity multiplies that unit amount; it never chooses a discount tier. The unchanged WooCommerce catalogue price is only a reference.
3. Choose **Review quote**. Check the optional name (or “Not provided”), each quantity and all-in line amount, then explicitly approve as the signed-in owner or manager. **Edit quote** returns to pricing and clears approval; editing a name also clears approval without discarding the goods/prices. Wholesale drafts cannot be held in browser-local retail carts.
4. Prepare the pending WooCommerce order. The POS uses Woo's own product tax class and order tax calculation to find pre-tax line inputs and checks that each returned line gross, tax and final order amount match the approval exactly. Any difference leaves the order under review, **not payable**. In Sales, choose **View quote** and reconcile the original order; do not create a replacement automatically.
5. Count full cash or verify the full MoMo/card merchant settlement outside this app. Record the full amount with an external reference when relevant. Print the receipt only when the POS reports **Paid**. **Leave unpaid** saves an order; it does not allow goods to leave.

This iteration is for payment before goods are taken from the shop. Do not use it for delivery with a different applicable tax location until the actual WooCommerce tax rules and address workflow have been separately accepted on staging. The five special dispatch-now/pay-in-one-to-two-weeks buyers are **not** supported by this workflow; no pay-later dispatch is authorized.

## Interrupted sales

- If checkout or payment confirmation is interrupted, do **not** create a replacement order. Editing/clearing the optional name or price does not make an uncertain order safe to retry; the POS blocks a matching pending Wholesale cart even if the name or approver changes. Resolve the original order first.
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
5. Export or review the day’s reports. Wholesale is identified separately from retail; unpaid and under-review quotes remain in Sales history, not paid totals.

## Refunds

Initiate refunds in WooCommerce. Then reconcile the POS sale so net reports update. The POS does not issue payment refunds.

## Backups

```bash
npm run backup -- /private/backup/directory
```

This creates an integrity-checked SQLite backup of the POS ledger **only when the command has the correct `POS_MODE`/`POS_DATA_DIR` environment**. On the host-Nginx Contabo staging installation, the private settings live in a systemd EnvironmentFile rather than the Git checkout: use the documented `mansu-pos-staging-backup.service` in [CONTABO-NATIVE.md](CONTABO-NATIVE.md), not a bare `npm run backup` with demo defaults. WordPress files/database require separate host-level backups. Store backups off-host and restrict access.

## Restore

Stop the POS service first. Then:

```bash
npm run restore -- /private/backup/pos-live-DATE.db --confirm-restore
```

The restore command verifies integrity, preserves the existing database, and restores the backup. On Contabo, a bare command from the Git checkout does **not** inherit the private systemd staging environment; an administrator must stop the staging POS and run restore with the correct staging mode/data directory under that protected environment. Restore refuses a running POS on the same ledger. After trading has begun, reconcile WooCommerce orders and stock before resuming sales. Do not blindly restore over new trading data.

## Health checks

- `GET /api/health`: process liveness.
- `GET /api/ready`: database readiness and configuration issues.
- Owner UI: **Store connection → Run diagnostics**.
- Owner UI: **Audit log** for security/staff/shift/sale events.

## Logs

Production logs are structured JSON. They include request IDs, method, path, status, duration, and user ID where available. They must not include passwords, API keys, card numbers, or customer personal information.
