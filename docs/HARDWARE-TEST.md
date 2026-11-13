# Windows counter hardware check — TEST ONLY

This is a **separate, non-selling application** from MansutRENDZGH POS. It does not require the trading server, a Woo account, a password, stock, or network access. It cannot create a sale, send an order, store a barcode, send a drawer-kick command, or install the Woo reservation plugin. It is only a keyboard-scanner and Windows-driver print check. It does **not** establish that the offline POS is ready for live sales.

## Download and safety

An explicitly requested CI run may attach a short-lived `hardware-check-TEST-ONLY-Windows-x64-…` **Actions artifact**, containing an **unsigned** Windows x64 setup EXE, `SHA256.txt`, and this guide. An Actions artifact is **not a GitHub Release**; this repository is public, so do not put credentials or private business information in the test app or artifact. The CI job also verifies that the installer is unsigned and that its packaged app contains only four local files plus its dependency-free manifest—not the live POS, its ledger, Woo client, or updater. The artifact is retained for three days, then GitHub deletes it.

1. Download the ZIP from the linked CI run's **Artifacts** section and extract it on the intended Windows PC. Use the `MansutRENDZGH-Hardware-Check-0.1.0-Windows-Setup.exe` inside it; do **not** use the existing POS installer or an old Release. The installer is a separate per-user application and should not replace the old POS.
2. Verify the SHA-256 before opening the file. In PowerShell, from the extracted directory run `Get-FileHash '.\MansutRENDZGH-Hardware-Check-0.1.0-Windows-Setup.exe' -Algorithm SHA256` and compare the hash with `SHA256.txt` **and** the hash printed by the CI verification step. If it differs, stop.
3. The QA executable has **no code-signing certificate**. Windows SmartScreen or company policy may block it; do not override a warning casually or turn off antivirus. If you are not comfortable installing an unsigned test app, **stop and wait for a signed build**. Do not install with administrator privileges or enter any real POS credentials.
4. This test must not collect money, fulfill goods, or touch the live store. Close or uninstall the test app after checking hardware. If the artifact expires, request a fresh test build; do not use a stale download.

## Test the one Windows counter PC

- **Scanner:** first scan a known label into Notepad. Confirm that its exact code appears and Enter moves to a new line. In Hardware Check, click **Barcode or SKU test** (or press **F2**), scan, and compare the displayed code to the label. If nothing appears, configure the scanner for USB/Bluetooth **HID keyboard** mode with an **Enter/Return suffix**. This test does not verify that Woo has that SKU or stock.
- **Printer:** install the manufacturer's trusted Windows driver, choose your **Xprinter XP-80T** (if that is the actual printer) in the print dialog, and set **80 mm** paper with minimal margins and no scaling. Click **Print TEST ONLY slip**. Check left/right alignment, text legibility, paper feed, and cutting. The slip says **NOT A RECEIPT**, has no price, and is not a paid receipt. Do not infer that the offline POS receipts have passed acceptance from this slip.
- **Drawer (if present):** connect its compatible cable to the printer's drawer port, not the computer. There is **no direct drawer support** or ESC/POS pulse in this app or the current offline POS. The printer driver may be configured to open a drawer on print; only report it as working if that happens consistently on the actual PC. Otherwise record **unsupported**.

Report back: Windows version and whether it is x64; scanner model, displayed code and Enter result; printer driver, paper width, readability and cut result; drawer opened/stayed closed/not present. Do not share staff passwords, card details, customer data, or the barcode of a private item.

## What this does not approve

The real offline POS has a separate, still-locked Woo stock reservation flow and is **not distributed** by this artifact. With no staging store, installing the Woo plugin, changing the live store, enabling sales, and a genuine last-unit/Paystack test each need an owner-reviewed backup and **separate approval**. A hardware pass alone does not authorize cash collection, public GitHub Releases, or a claim that the Windows POS is ready.
