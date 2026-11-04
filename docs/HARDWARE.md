# Counter hardware profile

Observed from owner-supplied photos on 4 November 2026. **Identification is not acceptance.** Every device still needs a physical pass/fail test on the actual counter before live trading.

| Device | Observed identification | POS compatibility | Status |
|---|---|---|---|
| Barcode scanner | Wired handheld scanner, brand appears to be **SKYSIMA**; exact model not visible. Assumed USB HID keyboard-wedge scanner. | Compatible if it types the barcode/SKU into the focused field and sends Enter/Return. Mansu POS matches exact SKU/barcode; `F2` opens the scan dialog. | Not tested |
| Receipt printer | **Xprinter XP-80T**, 80 mm thermal receipt printer, 200 mm/s, ESC/POS command support. Photo shows a USB cable connected; label also lists an additional interface. Cash-drawer output: 24 V. | Compatible through the operating-system printer driver and browser print dialog. Use the POS **80 mm** receipt width. Mansu POS prints HTML receipts; it does not send raw ESC/POS commands. | Not tested |
| POS terminal | Dual-screen Windows-based POS terminal; exact model and Windows version not visible. Existing POS software is running in the photos. | Compatible if a modern Chromium browser can reach the hosted POS URL. Use the cashier-facing screen for Mansu POS. | Not tested |
| Customer display | Second screen on the dual-screen terminal. | Not implemented. Mansu POS does not currently drive a separate customer-facing display. | Unsupported |
| Cash drawer | Not visible as a separate device; printer has a 24 V drawer-kick output. | Not directly controlled by Mansu POS. A drawer may open only if the printer driver/printer firmware is configured to kick on print. Otherwise treat as unsupported. | Unsupported unless driver-triggered and tested |
| Card terminal | Not shown. | Use the acquirer’s approved standalone terminal. Mansu POS records the externally verified approval/merchant reference; it does not process card payments. | Not tested |

## Recommended counter setup

1. **Terminal/browser**
   - Use the cashier-facing screen.
   - Install/currently use a supported Chromium browser such as Chrome or Edge.
   - Open the hosted POS URL and sign in with a named cashier account.
   - Do not run the old POS and Mansu POS against the same live WooCommerce store at the same time during migration unless a controlled reconciliation plan exists.

2. **Scanner**
   - Connect by USB.
   - Open Notepad or another plain text field and scan a known product barcode.
   - Expected result: the exact code appears and the cursor moves to a new line.
   - If there is no new line, configure the scanner for **keyboard/HID mode** and add an **Enter/Return suffix** using the manufacturer’s configuration barcodes.
   - In Mansu POS, press `F2` or focus the product search field, then scan.
   - Test both a simple-product SKU/barcode and a variation SKU/barcode.

3. **Printer**
   - Install the official Xprinter XP-80T driver for the terminal OS.
   - Prefer USB for the first acceptance test unless network printing is already managed.
   - Set the driver paper size to **80 mm** / 3.15 in receipt paper.
   - In the POS receipt dialog, select **80 mm thermal**.
   - In the browser print dialog: disable headers/footers, use minimal/no margins, and avoid fit-to-page scaling if it shrinks the receipt.
   - Print a demo receipt and verify text readability, alignment, total/payment lines, and cutting.

4. **Cash drawer**
   - If present, connect the drawer RJ11 cable to the printer’s drawer-kick port, not to the computer.
   - Mansu POS does not send a drawer-kick command.
   - Only mark cash drawer support as passed if the printer driver/firmware reliably opens the drawer during the tested receipt workflow and the owner accepts that behavior.

5. **Customer display**
   - Leave unsupported for now.
   - Do not promise a customer-facing total/advert screen unless a separate customer-display feature is implemented and tested.

## Physical acceptance evidence

Record in `docs/ACCEPTANCE.md`:

- Date, tester, terminal model/OS/browser.
- Scanner model/interface, suffix configuration, simple SKU pass/fail, variation SKU pass/fail.
- Printer driver/version, interface, paper width, alignment/readability/cut pass/fail.
- Cash drawer behavior: unsupported, driver-triggered pass, or fail.
- Customer display: unsupported.
- Receipt business details approved by owner.
- No real customer payment was processed during hardware testing.
