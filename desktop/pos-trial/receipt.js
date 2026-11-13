const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const money = value => `GH₵ ${(Number(value || 0) / 100).toFixed(2)}`;

// Render only a completed LOCAL sample transaction, never draft content or
// HTML from the renderer. The printed title, top, total and bottom all say
// that it is not a receipt even if someone folds or cuts the paper.
export function trialSlip(sale) {
  if (!sale?.number?.startsWith('PRACTICE-') || sale.paymentMethod !== 'cash' ||
      !sale.status?.startsWith('paid_local_') || !Array.isArray(sale.items) ||
      !sale.items.length || sale.items.some(item => ![991001,991002].includes(item.productId))) {
    throw new Error('Only a recorded sample checkout may be printed.');
  }
  const items = sale.items.map(item => `<tr><td>${escape(item.name)}${item.label ? ` (${escape(item.label)})` : ''} × ${Number(item.quantity)}</td><td>${money(Number(item.quantity) * Number(item.price))}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; object-src 'none'"><title>NOT A RECEIPT — PRACTICE</title><style>
  body{font:15px Arial,sans-serif;width:72mm;margin:3mm;color:#111}h1{font-size:24px;border:3px solid #111;padding:7px;text-align:center}
  .warning{font-size:17px;font-weight:bold;text-align:center;border-top:3px solid #111;border-bottom:3px solid #111;padding:9px 0}
  table{width:100%;border-collapse:collapse}td{padding:5px 0;border-bottom:1px dotted #555}td:last-child{text-align:right}
  </style></head><body><h1>NOT A RECEIPT</h1><p class="warning">SIMULATED POS PRACTICE<br>NO PAYMENT ACCEPTED<br>NO GOODS RELEASED</p>
  <p>Practice number: ${escape(sale.number)}<br>${escape(sale.paidAt || sale.createdAt || '')}</p>
  <table>${items}<tr><th>SIMULATED TOTAL</th><th>${money(sale.total)}</th></tr></table>
  <p class="warning">FAKE SYNC ONLY<br>NOT VALID FOR RETURNS OR PROOF OF PURCHASE<br>NOT A RECEIPT</p></body></html>`;
}
