# Last-unit stock hold (shop and website)

**Problem it fixes:** before this, if the shop and the website sold the same last item within a second or two, both sales could go through.

**How:** the website checkout already *holds* stock while a customer pays: WooCommerce keeps it in its reserved-stock table and refuses another checkout for the same units. The small plugin **Mansu POS Stock Hold** lets the POS do the same for its unpaid till orders, using WooCommerce's own code. The POS holds the stock right after it creates the order and again just before payment.

- If the website (or another till) is already holding the last unit, the POS cancels its new order and says so. Do not take cash.
- If the POS holds it first, a website customer cannot check out that unit until the till order is paid or cancelled.
- WooCommerce releases the hold when the order is paid, completed or cancelled. Unpaid till orders are cancelled after 120 minutes and the hold lasts a little longer than that.
- If the POS cannot confirm the hold (plugin off, store unreachable), it refuses the sale rather than risk selling twice.

The plugin changes no stock quantities and only works on orders the POS created (`_mansu_pos_channel = mansu-pos`) that are still unpaid. It uses the POS's existing WooCommerce API key; nothing else is needed.

## Install

1. Download `mansu-pos-stock-hold.zip` (or zip the folder `woocommerce/mansu-pos-stock-hold`).
2. WordPress → **Plugins → Add New → Upload Plugin** → choose the zip → **Install Now** → **Activate**.
3. On the POS server, add `POS_STOCK_HOLD_ENABLED=true` to `/etc/mansu-pos-live-trading/pos.env` and restart: `sudo systemctl restart mansu-pos-live-trading`.
4. Sign in to the POS as the owner, open **Settings & connection** and run the diagnostics. **Last-unit stock hold plugin** should be green.
5. **Test once with an item that has exactly 1 in stock:** prepare it at the till (do not pay), then try to buy it on the website. The website should say there is not enough stock. Cancel the till order; the website can then buy it.

## Switch off

Set `POS_STOCK_HOLD_ENABLED=false` and restart. The POS goes back to the earlier check (refusing a last unit held by a recent unpaid order). Deactivating the plugin while the switch is on makes the till refuse sales, so switch the POS off first.
