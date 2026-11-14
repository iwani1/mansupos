# Daily operations

**Not for the live catalogue pilot or an approval to deploy Phase 1.** [CONTABO-LIVE-PILOT.md](CONTABO-LIVE-PILOT.md) connects to the real store with a Read-only Woo key: checkout, payments and cash shifts are disabled. The steps below apply only after a separately reviewed trading deployment and acceptance. The pilot's local owner/session/audit/catalogue cache still needs a verified backup. See the [Phase 1 reliability draft](PHASE1-RELIABILITY.md) for the proposed v9 identity, backup, recovery and unresolved refund rules; none have been installed on the pilot.

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

The deployed pilot shows this collection **read-only** and cannot open a cash shift or sell. **The former POS-only stock/cash workflow below is historical and retired for the owner's shared-Woo-stock target; it cannot be enabled in non-test services.** Do not use it as a future rollout checklist or sell these goods from a second stock pool. See [SHARED-WOO-STOCK.md](SHARED-WOO-STOCK.md) and [INSTORE-COLLECTION.md](INSTORE-COLLECTION.md). For historical receipt review only, the former workflow was:

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

Record ordinary cash in/out against the open shift with a reason. Cash out cannot exceed expected drawer cash; a Woo refund is **not** itself a cash-out. MoMo and Card are not drawer cash. A cash-refund payout and any later-shift treatment need the owner's separate decision; do not backdate a movement into a closed shift.

## Closing the shift

1. Resolve pending or interrupted sales.
2. Count the physical drawer.
3. Enter closing cash and a note.
4. Review the variance. The shift records expected cash, counted cash, and variance.
5. Export or review the day’s reports. Woo Retail/Wholesale history is separate from physical In-store cash reports; the counted drawer includes both cash pools. Unpaid and under-review Woo quotes remain in Woo Sales history, not paid totals.

## Refunds

For Woo-backed Retail/Wholesale, a WooCommerce refund can be observed by POS reconciliation and changes **net-sales reporting**, but it is **not evidence that cash was paid out**. The POS does not issue payment refunds. Do not use a Woo refund to infer an original- or later-shift drawer deduction; closed shifts remain frozen, and open shifts count gross cash received unless an actual movement is separately recorded. **The owner has not decided the authorization, proof and shift attribution for a cash payout, particularly after the sale shift closes.** Preserve the physical count and Woo/POS evidence; do not use the generic cash-out button as an approved refund rule until the owner has documented one. See [PHASE1-RELIABILITY.md](PHASE1-RELIABILITY.md). **Physical In-store collection has no return/refund/void flow**; do not issue a Woo refund for a POS-only historical receipt or revive its retired cash gate.

## Backups

```bash
npm run backup -- /private/backup/directory
```

On the **isolated Phase 1 code**, this creates a consistent SQLite `.db` snapshot and a matching `.db.manifest.json` with identity, integrity and SHA-256 metadata. Preserve **both files together**. It backs up the POS ledger **only when the command has the correct `POS_MODE`/`POS_DATA_DIR` and live-pilot/trading service flags**. The already-installed pilot's older backup program has not been upgraded by this draft; do not follow these commands on that service without an approved identity/migration plan. On host-Nginx Contabo installations, private settings live in systemd EnvironmentFiles rather than the Git checkout: after a future separately approved rollout, use the role-specific backup unit, not a bare `npm run backup` with demo defaults. WordPress files/database require separate host-level backups. Encrypt/store backups off-host, restrict access and perform an isolated restore drill. The generic `deploy/backup.sh` wrapper now retains local snapshots by default; its optional positive `RETENTION_DAYS` deletes **manifested pairs only** and must not be set before an owner-reviewed off-host/retention policy. The role-specific backup units invoke `server/backup.js` directly and do not prune. No backup retention/pruning policy is approved by Phase 1; monitor storage rather than silently discarding historical backups.

## Restore

**Reference for an approved, isolated restore drill only; do not run this on the current pilot or future trading ledger without a separate owner-reviewed recovery plan.** Stop the intended POS service and verify the environment, snapshot and matching manifest first. In the isolated environment:

```bash
npm run restore -- /private/backup/pos-live-DATE.db --confirm-restore
```

The repaired **isolated** Phase 1 tool checks integrity, checksum, required schema, service class and ledger UUID, and refuses a running POS on the same data volume. It stages the verified image, but **refuses replacement when active protected rows differ from backup rows in either direction**: changed/newer records or backup-only deleted/revoked accounts, receipts and other protected history. There is no force option. If comparison passes, it makes a **verified safety copy plus manifest** before replacement; all backed-up sessions are cleared. **Real restored users and their old password hashes are disabled in the restored image, even when the target was empty. The service will not start until a separately approved stopped-service owner recovery using a NEW private temporary password.** Do not just restart and expect staff to sign in. Follow the numbered [offline recovery procedure](PHASE1-RELIABILITY.md#offline-owner-recovery-after-an-approved-restore--not-normal-startup); reauthorize other staff individually after reset and reconcile outstanding business effects first. A different-UUID ledger is not a valid target. On Contabo, a bare checkout command does **not** inherit the private systemd environment; a reviewed administrator must use the intended protected mode/data directory/service flags. This local comparison cannot discover Woo-only orders, external payment events or actual cash payouts; verify them independently and preserve the backup and safety copy. Do not use restore to clear an uncertain sale or bypass a refusal. Historical POS-only physical receipts/stock (if any) also require separate reconciliation; never merge their stock into Woo by a second deduction. These are **instructions for an approved isolated drill**, not permission to restore the pilot or a live ledger.

## Health checks

- `GET /api/health`: process liveness.
- `GET /api/ready`: database readiness and configuration issues. In the live catalogue pilot, a 200 means the **read-only** process is configured, not that checkout is enabled or Woo credentials work; use owner diagnostics for the authenticated catalogue read.
- Owner UI: **Store connection → Run diagnostics**.
- Owner UI: **Audit log** for security/staff/shift/sale events.

## Logs

Production logs are structured JSON. They include request IDs, method, path, status, duration, and user ID where available. They must not include passwords, API keys, card numbers, or customer personal information.
