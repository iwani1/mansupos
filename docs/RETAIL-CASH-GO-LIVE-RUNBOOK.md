# Cash-only Retail go-live on Contabo — runbook

**Fastest path:** `sudo bash deploy/golive-retail-cash.sh` performs steps 1–6 below in one run (prompts privately for keys, stops on any problem, never touches Nginx). Then continue at step 8.

Owner decision (16 Nov 2026): go live with **cash-only Retail**, orders written straight to WooCommerce, **no WordPress plugin**. Wholesale, MoMo/card and offline tills stay locked.

What this changes:

- The separate trading service (`mansu-pos-live-trading`, port 3188, its own ledger) is started with the drop-in `deploy/mansu-pos-live-trading.retail-cash.conf`.
- `pos.mansutrendzgh.com` is pointed from the read-only pilot (port 3187) to the trading service. The pilot keeps running as the rollback target.

What it does **not** change: WordPress, WooCommerce settings, Paystack and the other app on port 3000.

Safeguards in this release:

- Stock is re-read from WooCommerce right before the order is created and again right before it is marked paid.
- A sale that would take the **last units** of an item is refused while an unpaid website or POS order from the last 60 minutes holds the same item. If the order list can't be read, the sale is refused too.
- The live till shows a "Live till · cash-only retail" banner and a last-unit warning on cart lines.

Remaining risk the owner accepted: two sales of the same last unit in the same one or two seconds are not prevented. Staff should check WooCommerce before handing over a last item.

## 0. Have these ready

- Root SSH access to the Contabo VPS.
- A **new WooCommerce Read/Write API key**: WooCommerce → Settings → Advanced → REST API → Add key, description `Mansu POS trading`, permissions Read/Write. Keep the page open; never paste the key into chat or GitHub.
- An approval reference of 8 or more characters, for example `owner-2026-11-16-cash-retail`.
- A temporary owner password of 12 or more characters, used once and changed at first sign-in.
- Receipt details: business name, address and phone (tax ID only if you have one).
- About an hour, at a quiet time in the shop.
- **Real stock counts in WooCommerce** for every item you will sell in the shop. Each size needs **Manage stock** turned on and the counted quantity entered. The live till refuses items without a stock count. As of 16 Nov many products show placeholder numbers (10 or 39); recount those before selling them.

Do steps 1–3 **before** making the GitHub repository private. The server downloads the code from GitHub. After the repository is private, future updates need a GitHub deploy key (see step 12).

## 1. Look before changing anything (read-only)

```bash
systemctl status --no-pager mansu-pos-live-pilot mansu-pos-live-trading 2>&1 | grep -E "●|Active:"
```

```bash
ls -la /opt/mansu-pos-live-trading /etc/mansu-pos-live-trading /var/lib/mansu-pos-live-trading 2>&1 | head -40
```

```bash
grep -rl "pos.mansutrendzgh.com" /etc/nginx/ 2>/dev/null
```

```bash
node -v && curl -s http://127.0.0.1:3187/api/health && echo && curl -s http://127.0.0.1:3188/api/health
```

Keep the output (paste it to Claude with any keys removed). The `grep` prints the Nginx file used in step 8. If it prints more than one file, stop and ask.

## 2. Back up what is running now

```bash
mkdir -p /root/mansu-golive-backup && cd /root/mansu-golive-backup
```

```bash
nginx -T > nginx-full-before.txt 2>&1 && for f in $(grep -rl "pos.mansutrendzgh.com" /etc/nginx/); do cp -a "$f" "./$(echo "$f" | tr / _).before"; done && ls -la
```

```bash
tar -czf pilot-data-$(date +%F).tgz /var/lib/mansu-pos-live-pilot /etc/mansu-pos-live-pilot && ls -la
```

## 3. Install or update the trading code

**If `/opt/mansu-pos-live-trading` did NOT exist in step 1**, create the service user and folders, then download the code:

```bash
id mansu-pos-trading || useradd --system --user-group --home-dir /var/lib/mansu-pos-live-trading --shell /usr/sbin/nologin mansu-pos-trading
```

```bash
install -d -o mansu-pos-trading -g mansu-pos-trading -m 0700 /var/lib/mansu-pos-live-trading && install -d -o mansu-pos-trading -g mansu-pos-trading -m 0755 /opt/mansu-pos-live-trading
```

```bash
sudo -u mansu-pos-trading -H git clone --single-branch --branch claude/gifted-ramanujan-wt9kjc https://github.com/iwani1/mansupos.git /opt/mansu-pos-live-trading
```

**If it already existed**, stop that service and switch its code to this release instead:

```bash
systemctl stop mansu-pos-live-trading 2>/dev/null; sudo -u mansu-pos-trading -H git -C /opt/mansu-pos-live-trading fetch origin claude/gifted-ramanujan-wt9kjc && sudo -u mansu-pos-trading -H git -C /opt/mansu-pos-live-trading checkout -B live-retail-cash FETCH_HEAD
```

**Either way**, build it. This takes a few minutes:

```bash
sudo -u mansu-pos-trading -H sh -c 'cd /opt/mansu-pos-live-trading && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && npm run build:live && test ! -e dist/demo && npm prune --omit=dev' && sudo -u mansu-pos-trading -H git -C /opt/mansu-pos-live-trading rev-parse --short HEAD
```

Note the commit hash it prints.

## 4. Private settings file

Create it only if it doesn't exist yet:

```bash
install -d -m 0700 /etc/mansu-pos-live-trading && test -f /etc/mansu-pos-live-trading/pos.env || install -m 0600 /opt/mansu-pos-live-trading/.env.live-trading.example /etc/mansu-pos-live-trading/pos.env
```

Show the store address the working pilot uses, so you can copy it exactly:

```bash
grep '^WOO_BASE_URL=' /etc/mansu-pos-live-pilot/pos.env
```

```bash
nano /etc/mansu-pos-live-trading/pos.env
```

Set these lines and leave everything else as it is. The drop-in overrides the gate values anyway.

- `WOO_BASE_URL=` the exact value the pilot uses.
- `WOO_CONSUMER_KEY=` and `WOO_CONSUMER_SECRET=` from the **new Read/Write** key. Never reuse the pilot's key.
- `POS_OWNER_APPROVAL_REFERENCE=` your reference from step 0.
- `POS_OWNER_USERNAME=owner` and `POS_OWNER_PASSWORD=` your temporary password. This only takes effect if the ledger has no owner yet.
- `POS_BUSINESS_NAME=`, `POS_BUSINESS_ADDRESS=`, `POS_BUSINESS_PHONE=`, plus `POS_BUSINESS_TAX_ID=` only if you have one.
- `POS_WEBSITE_HOLD_MINUTES=60`, matching WooCommerce's Hold stock setting.

Save with Ctrl+O, Enter, then exit with Ctrl+X. Then:

```bash
chmod 0600 /etc/mansu-pos-live-trading/pos.env && chown root:root /etc/mansu-pos-live-trading/pos.env
```

## 5. Install the service with cash-only Retail switched on

```bash
cd /opt/mansu-pos-live-trading && install -m 0644 deploy/mansu-pos-live-trading.service deploy/mansu-pos-live-trading-backup.service deploy/mansu-pos-live-trading-backup.timer /etc/systemd/system/ && install -d /etc/systemd/system/mansu-pos-live-trading.service.d && install -m 0644 deploy/mansu-pos-live-trading.retail-cash.conf /etc/systemd/system/mansu-pos-live-trading.service.d/retail-cash.conf && systemctl daemon-reload
```

```bash
systemctl enable --now mansu-pos-live-trading && sleep 3 && systemctl status --no-pager mansu-pos-live-trading | head -15
```

```bash
curl -s http://127.0.0.1:3188/api/health; echo; curl -s http://127.0.0.1:3188/api/ready; echo
```

Expect `"mode":"live","liveReadOnly":false` and `"ok":true`. If the service failed, show the reason (it prints no keys):

```bash
journalctl -u mansu-pos-live-trading -n 40 --no-pager
```

## 6. Turn on and test ledger backups

```bash
systemctl start mansu-pos-live-trading-backup && journalctl -u mansu-pos-live-trading-backup -n 15 --no-pager && systemctl enable --now mansu-pos-live-trading-backup.timer && ls -la /var/lib/mansu-pos-live-trading/backups
```

These backups stay on the same server. Copy them off the server regularly, for example by downloading them to your own computer each week.

## 7. Check the website is still fine

Open `https://www.mansutrendzgh.com` and view a product page. Nothing on WordPress has changed, so it should look normal.

## 8. Point pos.mansutrendzgh.com at the trading service

Use the single file the `grep` in step 1 printed. Replace `PATH_FROM_STEP_1` below with that path:

```bash
F=PATH_FROM_STEP_1; grep -n "proxy_pass http://127.0.0.1:3187" "$F"
```

This must show the line(s) to change. Then switch them and test the config before reloading:

```bash
sed -i 's#proxy_pass http://127.0.0.1:3187#proxy_pass http://127.0.0.1:3188#' "$F" && nginx -t && systemctl reload nginx
```

If `nginx -t` fails, nothing is reloaded. Copy the `.before` file from step 2 back and ask for help.

```bash
curl -s https://pos.mansutrendzgh.com/api/health; echo
```

Expect `"liveReadOnly":false`.

## 9. First sign-in (owner)

1. Open `https://pos.mansutrendzgh.com` and sign in as `owner` with the temporary password, then set a new password.
2. Check that the Register shows the **"Live till · cash-only retail"** banner.
3. Owner → Settings → **Run diagnostics**: every check should pass.
4. Remove the temporary password from the settings file, then restart:

```bash
sed -i 's/^POS_OWNER_PASSWORD=.*/POS_OWNER_PASSWORD=/' /etc/mansu-pos-live-trading/pos.env && systemctl restart mansu-pos-live-trading
```

## 10. Supervised first real sale

1. Test the barcode scanner and receipt printer on the shop computer.
2. Open a shift with the counted opening float.
3. Choose one low-risk item that has **more than one** unit in stock. Scan it and prepare the sale.
4. Check that the WooCommerce total matches the shelf price (tax is off on your store).
5. Count the customer's cash, record it, and print the receipt.
6. Release the item only when the POS shows **Paid**.
7. Send Claude the order number. Claude checks, read-only through the WordPress connector, that it is paid, the total is right, stock went down by one, and the product page shows the new quantity.

**Stop rule:** if anything differs from the above, don't take more sales; do the rollback in step 11 and reconcile.

## 11. Rollback (about one minute)

Point the domain back at the read-only pilot:

```bash
F=PATH_FROM_STEP_1; sed -i 's#proxy_pass http://127.0.0.1:3188#proxy_pass http://127.0.0.1:3187#' "$F" && nginx -t && systemctl reload nginx
```

Lock the trading service as well, keeping all its sales history:

```bash
rm /etc/systemd/system/mansu-pos-live-trading.service.d/retail-cash.conf && systemctl daemon-reload && systemctl restart mansu-pos-live-trading
```

Never restore an old POS database over the trading ledger. Unpaid POS orders can be cancelled in WooCommerce. Paid ones are real sales; keep them.

## 12. After a successful first sale

- Create staff accounts (Owner → Staff). Staff change their temporary password at first sign-in.
- Make the GitHub repository private. For future updates, add a read-only **deploy key** for the server under GitHub → repository → Settings → Deploy keys. Claude can walk you through it.
- Close every shift with a counted cash total each day.
