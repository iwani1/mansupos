# Inventory management (Stock control)

The shop and the website sell from **one stock count**: the WooCommerce quantity.

- A website order lowers WooCommerce stock (WooCommerce does this itself).
- A POS sale creates a WooCommerce order, which lowers the same stock.
- **Stock control** (new) lets owners and managers change that quantity and the retail price from the POS. The website shows the change straight away.

There is no second, POS-only stock count to keep in sync.

## Who can do what

| Action | Owner | Manager | Cashier |
| --- | --- | --- | --- |
| View stock levels, history, export CSV | ✓ | ✓ | – |
| Receive stock (delivery, return, transfer in, found, correction) | ✓ | ✓ | – |
| Remove stock (damaged, lost, theft, transfer out, staff use, sample, correction) | ✓ | ✓ | – |
| Stock count (single line or a whole count sheet) | ✓ | ✓ | – |
| Start tracking stock on an item WooCommerce does not count | ✓ | ✓ | – |
| Change regular / sale price | ✓ | – | – |

Cashiers keep the read-only **Inventory** page.

## Using it

Open **Catalogue → Stock control**.

- **Stock levels**: one row per stock pool. Search, or filter by status (needs reorder, out, low, not tracked, missing SKU) and category. Each row shows the POS units sold in the last 30 days and roughly how many days of stock are left at that rate. Website sales are not in that figure.
  - **Receive** / **Remove** add or take off units, with a reason and an optional note (for example a supplier invoice number).
  - **Count** sets the quantity to what is on the shelf.
  - **Price** (owner only) sets the regular price and an optional sale price.
  - **History** shows every change to that item.
- **Stock count**: a count sheet. Type the counted quantity for the lines you counted and leave the others empty, then save. Lines that match WooCommerce are recorded as "Count confirmed" and nothing is written. Lines that differ are written to WooCommerce. Use the filters to count one category or rail at a time (at most 200 lines per save).
- **Movement history**: every stock change and price change made from the POS, plus POS sales. Website orders are not listed. They show up in the live quantity.
- **Export CSV**: the current stock list, for a spreadsheet or the accountant.

When the options of a product share one quantity in WooCommerce (stock managed on the parent product), they appear as a single "All options · shared stock" row. Change that row, not the individual sizes.

## How it stays safe

- **Fresh read before every write.** The POS reads the current WooCommerce quantity just before it saves. A receive or remove is applied to that number, not to the one on screen. If a website order sold an item a moment ago, a delivery of 5 is still added correctly.
- **Counts refuse moving targets.** If the quantity changed between loading the sheet and saving a count (for example a website sale), that line is refused, not overwritten. Re-check the shelf and enter it again.
- **No negative stock.** You cannot remove more than is in stock.
- **No double entries.** Each change carries a request key. If the same request is sent twice (double-click, retry after a dropped connection), it is applied only once.
- **Unconfirmed writes are flagged.** If WooCommerce does not answer, the change is recorded as "Unconfirmed — check stock" and the same request cannot be retried blindly. Refresh, check the quantity, then enter a new change if one is still needed.
- **One write at a time.** Stock writes from this POS service are queued, so two staff members cannot overwrite each other.
- **Append-only record.** Movements are stored in the POS's existing audit journal. It cannot be edited or deleted, and it is included in backups and checked by restore.

**Known limit:** WooCommerce's REST API can only *set* a quantity, not add to it. If a website order completes in the fraction of a second between the POS's fresh read and its write, the quantity can be 1 unit too high. The next count corrects it. This matches the known limit already listed for sales in the main README.

## Switching it on

| Service | Stock control writes |
| --- | --- |
| Demo | On. Changes affect the local sample stock only. Prices cannot be edited. |
| Staging | On whenever staging Woo writes are approved (`POS_STAGING_APPROVED=true`). |
| Read-only live pilot | Always off (view only). Refused at start-up if switched on. |
| Live trading | Off until `POS_INVENTORY_WRITES_APPROVED=true` **and** live Woo writes are already approved (the cash-retail gate). |
| Reservation bridge profile | Always off. |

To turn it on for the live trading service:

1. Add `POS_INVENTORY_WRITES_APPROVED=true` to the private settings file `/etc/mansu-pos-live-trading/pos.env`. The systemd drop-in does not override it.
2. Restart: `sudo systemctl restart mansu-pos-live-trading`.
3. Sign in as the owner and open **Stock control**. The yellow "View only" notice should be gone.
4. Test it on one item: **Receive 1**, check the product page on the website shows the new quantity, then **Remove 1** with the reason "Correction".

The WooCommerce API key already needs Read/Write access for POS orders, so nothing changes in WooCommerce.

To switch it off again, set the value to `false` (or remove it) and restart. Stock levels and history stay visible.
