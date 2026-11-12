# Daily operations

**Not for the live catalogue pilot.** [CONTABO-LIVE-PILOT.md](CONTABO-LIVE-PILOT.md) connects to the real store with a Read-only Woo key: checkout, payments and cash shifts are disabled. The steps below apply only after a separately reviewed trading deployment and acceptance. The pilot's local owner/session/audit/catalogue cache still needs a verified backup.

## Opening the register

1. Sign in with your named account.
2. Open **Shifts & drawer** and count the opening float.
3. Open a shift. In staging/live, checkout is blocked until a shift is open.
4. Refresh the catalogue and check the connection badge.
5. Test the scanner with a known SKU if needed.

## Selling WooCommerce-linked Retail goods (not the physical In-store collection)

- Search, tap, or scan products. Variable products open a size picker.
- Hold a sale if needed; held carts are browser-local and do not create orders.
- Prepare the order. WooCommerce confirms the authoritative total and tax.
- Record Cash, MoMo, or Card only after payment is collected/verified externally.
- Print the receipt on the verified printer. Live POS Retail/Wholesale recording is cash-only; MoMo/Card instructions above apply only to isolated demo/staging.

## Physical In-store collection (separate acceptance)

The deployed pilot shows this collection **read-only** and cannot open a cash shift or sell. The steps below apply only after the distinct in-store gate and a separate trading ledger are approved (see [INSTORE-COLLECTION.md](INSTORE-COLLECTION.md)):

1. Open a counted shift and open **In-store collection → Collection**. Search by name/SKU/group; most goods have no barcode. Check the actual POS balance, final all-in GHS unit amount and physical goods. Never sell the 41 quarantined negative/unknown-unit/missing-SKU/fractional-cent items, even if a PDF number looks positive.
2. Add eligible goods, enter and **count cash already received**, confirm the exact gross total, then record the sale once. The POS creates a paid cash receipt and deducts **only its private physical stock** atomically. It neither creates a Woo order nor changes online stock or Paystack. Print the separate 58/80 mm/A4 gross-only receipt; do not claim tax is zero.
3. If the response is lost, do **not** take more cash or start another sale. Select **Check saved attempt** to retrieve its receipt; if absent, retry the **same** attempt key without collecting cash again. An owner must reconcile any counted money before discarding an attempt.
4. Review **Cash receipts** or **Cash reports** in this section, not Woo Sales history/Reports. Cashiers see their own receipts; owners/managers see the report and formula-safe CSV. The shared shift drawer includes this cash and shows the in-store subset.
5. Only the owner may use **Record count** for an already eligible SKU after a physical check and with a reason. Owners/managers can view paginated **Stock history** for source import, cash-sale deductions and counted corrections. Neither action can clear a quarantined item. Returns/refunds of physical goods are not implemented; agree an owner procedure before live use.

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
5. Export or review the day’s reports. Woo Retail/Wholesale history is separate from physical In-store cash reports; the counted drawer includes both cash pools. Unpaid and under-review Woo quotes remain in Woo Sales history, not paid totals.

## Refunds

For Woo-backed Retail/Wholesale only, initiate refunds in WooCommerce and reconcile the POS sale so its net report updates. **Physical In-store collection has no return/refund/void flow yet**; do not issue a Woo refund for a POS-only cash receipt. Arrange an owner-approved return and stock/cash procedure before live use. The POS does not issue payment refunds.

## Backups

```bash
npm run backup -- /private/backup/directory
```

This creates an integrity-checked SQLite backup of the POS ledger **only when the command has the correct `POS_MODE`/`POS_DATA_DIR` environment**. On the host-Nginx Contabo installations, the private settings live in a systemd EnvironmentFile rather than the Git checkout: use `mansu-pos-live-pilot-backup.service` in [CONTABO-LIVE-PILOT.md](CONTABO-LIVE-PILOT.md) for the live-read-only pilot, or `mansu-pos-staging-backup.service` in [CONTABO-NATIVE.md](CONTABO-NATIVE.md) for staging. Do not run a bare `npm run backup` with demo defaults. WordPress files/database require separate host-level backups. Store backups off-host and restrict access.

## Restore

Stop the POS service first. Then:

```bash
npm run restore -- /private/backup/pos-live-DATE.db --confirm-restore
```

The restore command verifies integrity, preserves the existing database, and restores the backup. On Contabo, a bare command from the Git checkout does **not** inherit the private systemd staging environment; an administrator must stop the staging POS and run restore with the correct staging mode/data directory under that protected environment. Restore refuses a running POS on the same ledger. After Woo trading, reconcile WooCommerce orders and stock before resuming. After physical-stock sales, also reconcile **POS in-store receipts, stock movements, and drawer cash**; restoring an older ledger would erase newer sales. Do not blindly restore over any new trading data.

## Health checks

- `GET /api/health`: process liveness.
- `GET /api/ready`: database readiness and configuration issues. In the live catalogue pilot, a 200 means the **read-only** process is configured, not that checkout is enabled or Woo credentials work; use owner diagnostics for the authenticated catalogue read.
- Owner UI: **Store connection → Run diagnostics**.
- Owner UI: **Audit log** for security/staff/shift/sale events.

## Logs

Production logs are structured JSON. They include request IDs, method, path, status, duration, and user ID where available. They must not include passwords, API keys, card numbers, or customer personal information.
