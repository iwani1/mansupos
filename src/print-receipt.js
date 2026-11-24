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

// Called once when a just-paid sale's receipt appears. Only the Windows till
// acts on it (auto-print, and opening the cash drawer for a cash sale, when
// switched on there); in a browser it does nothing. Waits for the receipt to be painted before printing.
export async function autoPrintReceipt(saleId, paymentMethod) {
  const till = typeof window !== 'undefined' ? window.mansuTill : null;
  if (!till || typeof till.receiptReady !== 'function' || saleId == null) return { printed: false };
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try { return await till.receiptReady(String(saleId), paymentMethod); } catch { return { printed: false }; }
}
