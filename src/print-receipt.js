// Inside the Mansu POS Windows app the till prints straight to the chosen
// receipt printer (and handles its own fallbacks). In a browser, or if the
// till bridge is unavailable, use the browser's printing: a print dialog
// normally, or silent printing to the default printer when the browser/app
// was started with Chrome/Edge kiosk printing (see docs/INSTALLABLE-WEB-APP.md).
const BROWSER_AUTO_PRINT_KEY = 'mansu-browser-auto-print';

const tillBridge = () => (typeof window !== 'undefined' ? window.mansuTill : null);

// True inside the Windows till, which has its own printer and auto-print menu.
export function hasTillPrinting() {
  const till = tillBridge();
  return Boolean(till && typeof till.printReceipt === 'function');
}

// Per-device web-app choice: print each just-paid sale's receipt automatically.
export function browserAutoPrintEnabled() {
  try { return window.localStorage.getItem(BROWSER_AUTO_PRINT_KEY) === 'on'; } catch { return false; }
}

export function setBrowserAutoPrint(enabled) {
  try {
    if (enabled) window.localStorage.setItem(BROWSER_AUTO_PRINT_KEY, 'on');
    else window.localStorage.removeItem(BROWSER_AUTO_PRINT_KEY);
    return true;
  } catch { return false; }
}

export async function printReceipt() {
  const till = tillBridge();
  if (till && typeof till.printReceipt === 'function') {
    try { await till.printReceipt(); return; } catch { /* fall through to the dialog */ }
  }
  window.print();
}

// Sale ids already auto-printed in this window, so a re-rendered or re-mounted
// receipt never prints twice (the Windows till keeps its own list).
const browserPrinted = new Set();

const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

// Called once when a just-paid sale's receipt appears (never for receipts
// reopened from history). The Windows till decides itself (auto-print, and
// opening the cash drawer for a cash sale, when switched on there). In a
// browser it prints only if auto-print is switched on for this device.
// Waits for the receipt to be painted before printing.
export async function autoPrintReceipt(saleId, paymentMethod) {
  if (saleId == null) return { printed: false };
  const till = tillBridge();
  if (till && typeof till.receiptReady === 'function') {
    await painted();
    try { return await till.receiptReady(String(saleId), paymentMethod); } catch { return { printed: false }; }
  }
  if (hasTillPrinting() || !browserAutoPrintEnabled()) return { printed: false };
  const key = String(saleId);
  if (browserPrinted.has(key)) return { printed: true, browser: true, repeat: true };
  browserPrinted.add(key);
  if (browserPrinted.size > 50) browserPrinted.delete(browserPrinted.values().next().value);
  await painted();
  try { window.print(); return { printed: true, browser: true }; } catch { return { printed: false }; }
}
