# Refunds and returns — written procedure

**Status:** Proposed — in force once the owner signs below.

> **Shop (POS) sales:** use **Operations → Customer returns** in the POS instead. It does steps 3–5 for you: the WooCommerce refund, the Cash out on your shift, and the restock decision. See `CUSTOMER-RETURNS.md`. The manual steps below remain for **website orders**, **taxed sales**, and when returns are switched off.

The POS does not issue refunds. A refund is done in WooCommerce, and the cash that leaves the drawer is recorded separately as a **Cash out** on the shift. Both steps are always needed: a WooCommerce refund alone does **not** reduce the drawer's expected cash.

## Who may refund

- **Owner or manager** only. A cashier may take the item and the receipt, but must call the owner or manager to approve and carry out the refund.
- Refund only against a POS or website order you can find. No receipt or order number → no cash refund; offer an exchange or ask the owner.

## Steps (cash sale, same or later day)

1. **Find the sale.** POS → Sales → search by order number from the receipt. Check the item, price and date.
2. **Inspect the item.** Decide whether it goes back on sale or is damaged. Agree the amount (full or part).
3. **Refund in WooCommerce.** WooCommerce admin → Orders → open the order → **Refund**.
   - Enter the quantity and amount.
   - Tick **Restock refunded items** only if the item is fit to sell again.
   - In *Reason for refund* write: `POS return — <reason> — approved by <name>`.
   - Choose the **manual** refund (the money is paid in cash, not through a gateway).
4. **Pay the cash and record it.** Give the customer the cash, then POS → Shifts → **Record cash movement**:
   - Movement: **Cash out**
   - Amount: the cash actually paid
   - Reason: `Refund order #<number> — <reason>`
   Record it on the shift that is **open now**, the one the money physically leaves, even if the original sale was on an earlier day. Never change a closed shift.
5. **Damaged goods.** If the item was not restocked, put it aside, label it with the order number and date, and tell the owner. Write it off in WooCommerce stock only after the owner decides.
6. **Check.** Within a minute or two, the POS Sales screen shows the order as refunded or partly refunded, and reports show the refund separately.

## Exchanges

Treat an exchange as a refund (steps 1–4) followed by a new sale. This keeps the cash, stock and reports correct.

## Reasons to use

`Wrong size` · `Faulty` · `Damaged in shop` · `Changed mind` · `Price error` · `Other (write it)`

## Not allowed

- Refunding with no WooCommerce refund and no cash-out record.
- A cash-out larger than the cash in the drawer (the POS refuses it; use the owner's float or a later shift).
- Refunding to a different person than the buyer without the owner's approval.
- Backdating anything into a closed shift.

## Owner review

Each week, compare WooCommerce refunds with the shifts' **Cash out** entries that start with `Refund order`. Every cash refund should appear in both places with the same amount.

## Sign-off

Owner: ______________________ Date: ____________
