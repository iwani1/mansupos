# Mansu POS for Windows (online till)

> **Version 2 (multi-shop):** one installer for every Mansu POS shop. On first launch the till asks *Which shop is this till for?*; type the shop address (`amaboutique` = `amaboutique.mansupos.com`, or the MansutRENDZGH address `pos.mansutrendzgh.com`). It checks the shop is live, saves it, and from then on opens **only that shop** — every other site and shop is blocked. *POS → Change shop…* works only when the shop owner is signed in on that till; it signs everyone out, clears held sales, keeps printer and drawer settings, and restarts to the picker. *Help → Check for updates* (and a daily check) reads the release notice the platform publishes (`npm run platform -- till-release …`) and offers the download; nothing installs by itself until releases are code-signed. The rest of this page still applies.


**What it is:** an installable Windows x64 app (`Mansu POS`) that opens the live POS at **https://pos.mansutrendzgh.com/** in its own window. It is the same POS as the web app: staff sign in with their named POS account and sell, open and close shifts, take returns, manage stock and run reports according to their role. Every sale is made on the POS server, which creates the WooCommerce order and lowers website stock at that moment. It replaces the [read-only pilot](WINDOWS-ONLINE-PILOT.md), which no longer opens because live is no longer read-only. The [offline till design](WINDOWS-OFFLINE-DESIGN.md) is superseded and is not this app.

**Status:** unsigned QA build. It has been tested on Linux in the real Electron shell (live sign-in screen loads with nothing blocked; on a local demo server a cash sale, receipt, export and connection loss/recovery all work; silent printing was tested to a CUPS test printer, including the missing-printer warning, the test slip and auto-print once per sale; the cash-drawer pulse was checked byte-for-byte through CUPS, and CI checks it through the real Windows print spooler). It has **not yet been installed and used on the shop's Windows PC** — see the acceptance checklist below.

## How it behaves

- **Online only.** Nothing is stored for later. Before opening, the app checks `/api/health` on the pinned HTTPS host and requires a healthy `live` POS. If it cannot reach it, it says so and offers *Try again* / *Close*; it never shows an old or cached till.
- **Connection lost while open:** every 15 seconds the app re-checks the POS. If it fails, a red bar appears across the top and the window title changes to *CONNECTION LOST · do not take payment*. The sale on screen is kept; the bar clears by itself when the POS answers again. If the connection dropped just after **Confirm**, the sale may already be recorded: check **Sales history** before trying again (the POS's own lost-response recovery also does this).
- **What the server says goes.** Permissions (cashier / manager / owner), cash-only payment, and switches such as stock control, product editing and returns are all enforced by the POS server, exactly as in the browser. If the server is ever put into read-only mode the app still opens and its title says sales are switched off.
- **Receipts print silently** to the chosen receipt printer: pressing **Print receipt** sends it straight to the printer, no dialog. Choose the printer once from the **Receipt printer** menu (*Choose receipt printer…*), then use *Print a test receipt* to check the paper width and alignment. Until a printer is chosen, the normal Windows print dialog appears instead. If the chosen printer is missing or reports an error, the app says so and offers **Print with dialog** so a receipt can always be printed. Double presses only print once. The choices are saved on that PC (`%APPDATA%\mansu-pos-online-till\till-settings.json`). The paper width on the receipt screen (80 mm / 58 mm / A4) must match the printer; the printer's own driver sets the paper size and cutting.
- **Auto-print after each sale (optional):** tick *Receipt printer → Print automatically after each sale* (available once a printer is chosen). The receipt then prints as soon as the sale is paid, and the receipt screen says *Receipt sent to the printer automatically*. It prints once per sale; reopening a receipt from Sales history never prints by itself (use **Print receipt** for a copy). Auto-print never opens the print dialog on its own; if the printer fails, the usual warning with **Print with dialog** appears.
- **Cash drawer:** plug the drawer's RJ11 cable into the receipt printer's drawer port (not the computer). The till opens it by sending the printer the standard ESC/POS drawer pulse. *Cash drawer → Open after each cash sale* opens it once when a **cash** sale is paid (never for reopened receipts, and never for MoMo/card); *Open cash drawer now…* (Ctrl+Shift+D, asks to confirm) opens it for change or a cash count. If it does not open, switch *Drawer cable on pin 2 / pin 5*. Every opening (and failure) is recorded with time and reason in `%APPDATA%\mansu-pos-online-till\drawer-log.txt`; *Show drawer log* lists the latest. Use **either** this or the printer driver's own "open drawer when printing" option, not both. Anyone at the till can use *Open cash drawer now*; the log is local to that PC, not on the server.
- **Barcode scanners** that type like a keyboard work (`F2` to scan).
- **Exports** (reports, stock, purchasing CSVs) open a Windows *Save As* dialog, defaulting to Downloads. Only exports from the POS can be saved.
- **Stays signed in across restarts** for the POS's normal session length; held sales and screen preferences are kept on that PC, as in the browser. The app never caches POS pages or data and refuses the web app's offline service worker.
- **Menu:** *POS → Reload (Ctrl+R), Full screen (F11), Larger / Smaller / Normal text (Ctrl + = / − / 0), Close*; *Receipt printer → Choose receipt printer…, Print a test receipt, Print automatically after each sale*; *Cash drawer → Open cash drawer now…, Open after each cash sale, pin 2 / pin 5, Show drawer log*; *Help → About*.
- **Locked down:** only the POS host and the store's product photos (`/wp-content/uploads/`) can load. No other website, pop-up, frame, camera/microphone/location permission, or the offline-till enrolment/sync routes. The window has no access to the PC's files or Node.js; its only bridge is `printReceipt()` and `receiptReady(saleId)` (for auto-print), accepted only from the POS page itself. There are no WooCommerce, WordPress or payment credentials in the installer, and no auto-update.

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
- [ ] *Receipt printer → Choose receipt printer…* picks the receipt printer; *Print a test receipt* comes out centred and not cut off.
- [ ] If wanted, tick *Print automatically after each sale*; the next sale's receipt prints with no button press, and reopening it from Sales history does not print again.
- [ ] Drawer cable in the printer's drawer port; *Cash drawer → Open cash drawer now…* opens it (try pin 5 if not). Tick *Open after each cash sale*: the next cash sale opens it once; *Show drawer log* lists both.
- [ ] Scan a known real SKU with the USB scanner (`F2`).
- [ ] One small, real cash sale: order appears in WooCommerce, website stock drops by one, pressing **Print receipt** prints it on the receipt printer with no dialog.
- [ ] Unplug the network during an idle cart: red bar and title appear within ~15 s; reconnect: they clear, cart still there.
- [ ] Export a report CSV and open it in Excel.
- [ ] Close the shift; counted cash matches expected.
- [ ] Close and reopen the app; still signed in (within session time), held sales kept.
- [ ] Uninstall and reinstall works; uninstalling does not affect sales on the server.

## Still to do for a full release

- **Code signing certificate** (removes the SmartScreen warning) and a decision on how updates are delivered (today: install a newer build over the top).
- Silent and automatic receipt printing need the **updated web app on the live server** (this commit's `src/print-receipt.js`). Until the server is updated, the till still prints, but through the print dialog.
- Optional: restrict *Open cash drawer now* to managers and record openings on the server (today: anyone at the till, logged on the PC).
- The known POS limit still applies: two sales of the same last unit (shop and website) within a second or two are not prevented.
