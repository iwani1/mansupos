# Purchasing: suppliers, purchase orders, deliveries and stock value

Owners and managers: **Catalogue → Purchasing**.

## How it fits the rest of the system

WooCommerce keeps the one stock count for the website and the shop (see `docs/adr/0001-woocommerce-owns-stock.md`). Purchasing never keeps a second count:
- **Ordering** something does not change stock. It shows as **incoming** until it arrives.
- **Receiving** a delivery adds the good units to the WooCommerce quantity through Stock control, so it appears on the website and at the till at once, with a movement such as `PO-00012 · GRN-00031 · inv 4471` in Stock control → Movement history.
- **Damaged units** on a delivery are recorded on the receipt but not added to stock.
- **Costs** (what you paid) stay in the POS. They are never sent to the website.

## Suppliers

**Suppliers → Add supplier**: name, phone, email, address, your account number with them, and notes. Untick **Active** to stop using a supplier on new orders; old orders keep it.

## Purchase orders

1. **New purchase order** (or tick items on the **Reorder** tab and press **Create order**).
2. Choose the supplier, search and add items, enter quantity and unit cost. The last price you paid fills in automatically. Optional expected date and note.
3. **Save draft**. A draft can still be edited.
4. Approval:
   - A manager presses **Submit for approval**; an owner then presses **Approve**.
   - An owner can approve their own draft straight away.
5. **Mark as sent** when you send it to the supplier (optional).
6. **Cancel order** works until goods have been received.

| Status | Meaning |
|---|---|
| Draft | Being prepared; can be edited |
| Awaiting approval | Submitted by a manager, waiting for an owner |
| Approved / Sent to supplier | Waiting for goods; counted as incoming |
| Partly received | Some goods in; the rest still incoming |
| Received | Everything in, or closed short |
| Cancelled | No goods will come |

## Receiving a delivery

1. Open the order and press **Receive delivery**.
2. For each line enter the **good units** that arrived and any **damaged** units. Correct the unit cost if the invoice differs.
3. Enter the supplier's invoice or delivery-note number.
4. **Post delivery**.

- **Partial deliveries** are fine: the order becomes *Partly received* and the rest stays incoming. Receive again when the rest arrives.
- **More than ordered:** the POS asks you to confirm the extra units first.
- **Never twice:** pressing Post again (double tap, bad connection) never adds the stock a second time.
- **If WooCommerce refuses a line** (e.g. the website is down), the other lines are still posted; the screen lists the failed lines and **Post delivery** again retries only those.
- **Supplier won't send the rest:** press **Close short**. The outstanding units stop counting as incoming.
- Posted receipts cannot be edited or deleted. To correct a mistake, use **Stock control → Remove** (or Count) with a reason.

## Reorder list

The **Reorder** tab lists tracked items whose stock **plus stock already on order** is at or below the low-stock level (`POS_LOW_STOCK_THRESHOLD`, default 5).

**Suggested quantity** = target − in stock − on order, where target = the larger of:
- twice the low-stock level;
- 1.5 × the shop units sold in the last 30 days (about 45 days of shop sales).

Website sales are not in the 30-day figure, so check fast online sellers yourself. Tick items and press **Create order** to start a purchase order with those quantities.

## Stock value (cost)

- **Average cost** is updated on every delivery (weighted average): (units already in stock × old average + units received × delivery cost) ÷ total units. The first delivery of an item sets its cost.
- Items bought before purchasing was used have no cost. The owner can enter one with **Set cost**, and later deliveries average it in.
- **Value at cost** = units in stock × average cost. The header also compares cost and retail value for costed items (gross margin).
- **Export CSV** downloads the full list for your accountant.

## Permissions

| | Owner | Manager | Cashier |
|---|---|---|---|
| Suppliers, draft orders, receive deliveries | ✓ | ✓ | – |
| Approve purchase orders | ✓ | – | – |
| Set a cost by hand | ✓ | – | – |

Receiving needs Stock control writes to be on (`POS_INVENTORY_WRITES_APPROVED=true`), because it changes website stock. The read-only live pilot hides Purchasing.

## Records

- New tables: `suppliers`, `purchase_orders`, `purchase_order_items`, `goods_receipts`, `goods_receipt_items` (append-only), `inventory_costs`. They are created automatically on start-up and included in backups. The v9 ledger version does not change.
- Audit log entries: `supplier.created/updated`, `purchase_order.saved/submit/approve/mark_ordered/cancel/close`, `goods_receipt.posted`, `inventory.cost_set`.
