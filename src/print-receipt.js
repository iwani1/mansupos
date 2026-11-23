// Inside the Mansu POS Windows app the till prints straight to the chosen
// receipt printer (and handles its own fallbacks). In a browser, or if the
// till bridge is unavailable, use the normal print dialog.
export async function printReceipt() {
  const till = typeof window !== 'undefined' ? window.mansuTill : null;
  if (till && typeof till.printReceipt === 'function') {
    try { await till.printReceipt(); return; } catch { /* fall through to the dialog */ }
  }
  window.print();
}
