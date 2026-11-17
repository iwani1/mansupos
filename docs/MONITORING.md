# Uptime alert for the POS

Nothing on the server tells you when the POS stops working. A free external monitor fixes that in about ten minutes: it checks the POS every few minutes from the internet and emails (or texts, or pushes to your phone) when it fails.

## What to watch

| Check | Address | Healthy when |
|---|---|---|
| POS ready | `https://pos.mansutrendzgh.com/api/ready` | HTTP 200 **and** the reply contains `"ok":true` |
| Website (optional, recommended) | `https://www.mansutrendzgh.com/` | HTTP 200 |

`/api/ready` returns 503 when the POS database is unavailable or the live settings are wrong, so it catches more than "server is off". It needs no sign-in and shows no private data. Because the POS cannot sell when WooCommerce is down (see [ADR 0001](adr/0001-woocommerce-owns-stock.md)), watching the website matters too.

## Set it up (UptimeRobot, free plan; any similar service works)

1. Create an account at uptimerobot.com with the owner's email.
2. **Add New Monitor** → type **Keyword**.
   - URL: `https://pos.mansutrendzgh.com/api/ready`
   - Keyword: `"ok":true` — alert when the keyword **does not exist**.
   - Interval: 5 minutes.
3. Alert contacts: your email, plus the mobile app (push) if you install it. SMS on free plans is limited; push or email is usually enough.
4. Add a second **HTTP(s)** monitor for `https://www.mansutrendzgh.com/`.
5. Test it: on the server, `systemctl stop mansu-pos-live-trading`, wait for the alert (within ~10 minutes), then `systemctl start mansu-pos-live-trading` and wait for the "up" message. Do this outside shop hours.

## When an alert arrives

1. Open `https://pos.mansutrendzgh.com/api/ready` in a browser. If it shows `"ok":false`, the `issues` list says why.
2. On the server: `systemctl status mansu-pos-live-trading` and `journalctl -u mansu-pos-live-trading -n 50 --no-pager`.
3. If the website is also down, the problem is WordPress or the server, not the POS.
4. While it is down, write sales in the paper sales book (item, price, cash taken, time) and enter them when the POS is back.

## Also worth watching (later)

- **Disk space.** A full disk stops backups and sales. Check weekly: `df -h /var/lib`.
- **Backups.** `ls -lt /var/lib/mansu-pos-live-trading/backups | head` should show a file from the last hour.
