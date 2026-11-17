# Customer returns

Owners and managers: **Operations → Customer returns**. Use this for items bought **in the shop (POS sales)**. Website orders are still refunded in WooCommerce (see `REFUND-PROCEDURE.md`).

## What one return does

1. **Refund on the WooCommerce order.** A manual (cash) refund is added to the original order, with a reason such as `POS return RTN-00012 — Wrong size — by Ama`. WooCommerce's own "restock" is **switched off**, so stock is never added twice.
2. **Cash out on your shift.** For a cash sale, the refund is recorded as a Cash out on **your open shift**, the drawer the money leaves. It then appears in the shift's expected cash.
3. **What happens to each item**, which you choose per line:

| Choice | Effect |
|---|---|
| **Back on sale** | Added to website and shop stock now (Stock control history: *Customer return*) |
| **Check first** | Kept aside, not in stock; listed under **Awaiting decision** |
| **Damaged** | Kept aside, not in stock; listed under **Awaiting decision** |
| **Write off** | Not sellable; recorded only |
| **Return to supplier** | Recorded for sending back to the supplier |

Under **Awaiting decision**, each item later gets one decision: **Back on sale** (adds to stock), **Write off**, or **To supplier**.

## Steps

1. Open **Customer returns → New return**. Search the receipt or order number (e.g. `4001`), or pick a recent sale, and press **Return items**.
2. For each item coming back, choose **how many** and **what happens to it**.
3. Choose the **reason** (Wrong size, Faulty, Damaged in shop, Changed mind, Price error, Other with a note).
4. Check the refund amount, then press **Complete return** and confirm.
5. Pay the customer. The screen shows the return number (`RTN-00001`).

**Exchanges:** do a return (the item goes **Back on sale** if it's fine), then sell the new item as a normal sale.

## Safety rules

- **Never more than was sold.** You can't return more of an item than the sale had, counting earlier returns.
- **Refund amount** = what the customer actually paid per unit (the agreed price for wholesale sales). It never exceeds the amount not yet refunded.
- **Open shift first** for cash sales, and the drawer must hold enough cash. Otherwise the POS refuses before refunding anything. Use **Cash in** or the owner's float first.
- **Taxed sales** are refused here. Refund them in WooCommerce so the tax splits correctly, then record the Cash out.
- **Never twice.** If the connection drops, press **Complete return** again. The POS first checks the WooCommerce order for this return's refund and continues from there; it never refunds, pays out or restocks twice.
- **If WooCommerce rejects the refund**, nothing is refunded, paid or restocked, and the items stay returnable.
- **If the refund went through but the Cash out could not be recorded** (e.g. the shift closed), the return shows **Cash out not recorded**. Record the Cash out by hand on an open shift.
- Returns can't be deleted, and each kept-aside item can be decided only once.
- Payment reconciliation no longer flags a cash refund as "payout unverified" when a POS return recorded its Cash out. Refunds made directly in WooCommerce are still flagged.

## Switching it on (live trading service)

Add `POS_RETURNS_APPROVED=true` to `/etc/mansu-pos-live-trading/pos.env`, then run `systemctl restart mansu-pos-live-trading`. Returns also need Stock control writes (`POS_INVENTORY_WRITES_APPROVED=true`), which you already have. Without the switch the screen is view-only.

## Records

- Tables `customer_returns` and `customer_return_items` are created automatically, included in backups, and can't be deleted.
- Sale event `return.refunded` on the sale.
- Audit entries: `return.started`, `return.refunded`, `return.failed`, `return.refund_unconfirmed`, `return.cash_unrecorded`, `return.item_restock/write_off/supplier_return`.
