# Mansu POS for Windows (online till)

**What it is:** an installable Windows x64 app (`Mansu POS`) that opens the live POS at **https://pos.mansutrendzgh.com/** in its own window. It is the same POS as the web app: staff sign in with their named POS account and sell, open and close shifts, take returns, manage stock and run reports according to their role. Every sale is made on the POS server, which creates the WooCommerce order and lowers website stock at that moment. It replaces the [read-only pilot](WINDOWS-ONLINE-PILOT.md), which no longer opens because live is no longer read-only. The [offline till design](WINDOWS-OFFLINE-DESIGN.md) is superseded and is not this app.

**Status:** unsigned QA build. It has been tested on Linux in the real Electron shell (live sign-in screen loads with nothing blocked; on a local demo server a cash sale, receipt, export and connection loss/recovery all work). It has **not yet been installed and used on the shop's Windows PC** — see the acceptance checklist below.

## How it behaves

- **Online only.** Nothing is stored for later. Before opening, the app checks `/api/health` on the pinned HTTPS host and requires a healthy `live` POS. If it cannot reach it, it says so and offers *Try again* / *Close*; it never shows an old or cached till.
- **Connection lost while open:** every 15 seconds the app re-checks the POS. If it fails, a red bar appears across the top and the window title changes to *CONNECTION LOST · do not take payment*. The sale on screen is kept; the bar clears by itself when the POS answers again. If the connection dropped just after **Confirm**, the sale may already be recorded: check **Sales history** before trying again (the POS's own lost-response recovery also does this).
- **What the server says goes.** Permissions (cashier / manager / owner), cash-only payment, and switches such as stock control, product editing and returns are all enforced by the POS server, exactly as in the browser. If the server is ever put into read-only mode the app still opens and its title says sales are switched off.
- **Receipts** use Windows' normal print dialog and the printer's installed driver (58/80 mm or A4), as in the browser. **Barcode scanners** that type like a keyboard work (`F2` to scan).
- **Exports** (reports, stock, purchasing CSVs) open a Windows *Save As* dialog, defaulting to Downloads. Only exports from the POS can be saved.
- **Stays signed in across restarts** for the POS's normal session length; held sales and screen preferences are kept on that PC, as in the browser. The app never caches POS pages or data and refuses the web app's offline service worker.
- **Menu:** *POS → Reload (Ctrl+R), Full screen (F11), Larger / Smaller / Normal text (Ctrl + = / − / 0), Close*; *Help → About*.
- **Locked down:** only the POS host and the store's product photos (`/wp-content/uploads/`) can load. No other website, pop-up, frame, camera/microphone/location permission, or the offline-till enrolment/sync routes. The window has no access to the PC's files or Node.js. There are no WooCommerce, WordPress or payment credentials in the installer, and no auto-update.

## Get the installer

1. A push whose commit message contains `[online-qa]` makes CI build it on Windows. Open that run's **online-till-package** job on GitHub Actions and download the `mansu-pos-ONLINE-Windows-x64-…` artifact (kept 7 days). Inside: `Mansu-POS-ONLINE-<version>-Windows-Setup.exe`, `SHA256.txt` and this file.
2. In PowerShell: `Get-FileHash .\Mansu-POS-ONLINE-*-Windows-Setup.exe -Algorithm SHA256` must match `SHA256.txt`. If not, stop.
3. The build is **unsigned**, so Windows SmartScreen may warn (*More info → Run anyway*). Do not turn off Windows protection globally.
4. Install (per-user). A **Mansu POS** shortcut appears on the desktop and Start menu. It installs beside, not over, the old read-only pilot; uninstall the pilot from *Settings → Apps* once this one is accepted.

Build locally on a trusted Windows PC: `npm ci`, `node node_modules/electron/install.js`, `npm run dist:online:win` → `desktop/online/release/`.

## Acceptance on the shop PC (before daily use)

Tick each with the owner present:

- [ ] Installer hash matches; app installs and opens to the live sign-in screen.
- [ ] Cashier account signs in; owner-only screens are hidden for the cashier.
- [ ] Open a shift with the float.
- [ ] Scan a known real SKU with the USB scanner (`F2`).
- [ ] One small, real cash sale: order appears in WooCommerce, website stock drops by one, receipt prints on the receipt printer.
- [ ] Unplug the network during an idle cart: red bar and title appear within ~15 s; reconnect: they clear, cart still there.
- [ ] Export a report CSV and open it in Excel.
- [ ] Close the shift; counted cash matches expected.
- [ ] Close and reopen the app; still signed in (within session time), held sales kept.
- [ ] Uninstall and reinstall works; uninstalling does not affect sales on the server.

## Still to do for a full release

- **Code signing certificate** (removes the SmartScreen warning) and a decision on how updates are delivered (today: install a newer build over the top).
- Optional silent printing to a chosen receipt printer (today the normal print dialog is shown).
- The known POS limit still applies: two sales of the same last unit (shop and website) within a second or two are not prevented.
