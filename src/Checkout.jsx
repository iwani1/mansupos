import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCircle2, Printer, ShieldCheck, LoaderCircle } from 'lucide-react';
import { api, money, dateTime, methodLabel } from './api.js';
import { Modal, Notice, PaymentIcon } from './components.jsx';

export function WholesaleQuoteDetails({ sale }) {
  return <section className="wholesale-payment-quote" aria-label="Approved wholesale quote"><div><strong>Wholesale{sale.buyerName ? ` · ${sale.buyerName}` : ' · buyer not recorded'}</strong><small>Approved by {sale.wholesaleApprovedByName} · {dateTime(sale.wholesaleApprovedAt)}</small></div>
    {sale.items.map(item => <div key={`${item.productId}:${item.variationId}`} className="wholesale-quote-line"><span>{item.name || `Product #${item.productId}`}{item.label ? ` · ${item.label}` : ''}<small>{item.quantity} × {money(item.agreedUnitPrice)}{Number(sale.tax) > 0 ? ' · tax included' : ''} · Catalogue {item.cataloguePrice == null ? 'not captured' : money(item.cataloguePrice)}</small></span><strong>{money(item.agreedLineTotal)}</strong></div>)}
    <div className="wholesale-quote-total"><span>Final agreed amount{Number(sale.tax) > 0 ? ' · tax included' : ''}</span><strong>{money(sale.agreedTotal)}</strong></div></section>;
}

export function Checkout({ sale, config, onClose, onPaid, notify }) {
  const [method, setMethod] = useState('cash');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [hold, setHold] = useState(null);
  const [holdError, setHoldError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const itemCount = sale.items.reduce((count, item) => count + item.quantity, 0);
  const wholesale = sale.saleType === 'wholesale';
  const paymentMethods = config.paymentMethods || (config.mode === 'live' ? ['cash'] : ['cash', 'momo', 'card']);
  const quoteVerified = !wholesale || (sale.status === 'awaiting_payment' && config.wholesaleWritesEnabled && sale.wholesaleApprovedById &&
    sale.items.length > 0 && sale.agreedTotal === sale.total && sale.items.every(item => Number.isInteger(item.agreedUnitPrice) && item.agreedLineTotal === item.agreedUnitPrice * item.quantity));
  const amount = Math.round(Number(tendered || 0) * 100);
  const onlineBridge = config.onlineBridgeLocalTest === true && sale.onlineBridge === true;
  const wrongCheckout = config.onlineBridgeLocalTest === true && !sale.onlineBridge;
  // Listing a sale is not reservation proof. Fetch a fresh, read-only Woo
  // observation on opening this dialog; the server repeats it before custody.
  useEffect(() => {
    if (!onlineBridge) return;
    let active = true;
    api(`/sales/${sale.id}/online-status`).then(result => {
      if (active) { setHold(result.bridge); setHoldError(''); }
    }).catch(() => { if (active) setHoldError('Woo hold cannot be checked. Reconcile this original sale before any cash collection.'); });
    return () => { active = false; };
  }, [onlineBridge, sale.id]);
  useEffect(() => {
    if (!onlineBridge) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [onlineBridge]);
  const reservationValid = !onlineBridge || hold?.cashCollectionAllowed === true && hold.state === 'reserved' &&
    Number.isFinite(Date.parse(hold.expiresAt)) && Date.parse(hold.expiresAt) - clock >= 100000;
  const valid = !uncertain && !wrongCheckout && reservationValid && (config.mode === 'demo' || config.writesEnabled) && paymentMethods.includes(method) && quoteVerified && confirmed && (method === 'cash' ? Number.isFinite(amount) && amount >= sale.total : reference.trim().length > 0);
  async function pay() {
    if (!valid || busy) return;
    setBusy(true); setError('');
    try {
      if (onlineBridge) {
        const current = await api(`/sales/${sale.id}/online-status`);
        setHold(current.bridge);
        if (current.sale.status !== 'awaiting_payment' || current.bridge.cashCollectionAllowed !== true ||
            current.bridge.state !== 'reserved' || Date.parse(current.bridge.expiresAt) - Date.now() < 100000) {
          throw new Error('The original Woo stock hold is no longer payable. Reconcile this sale without collecting cash.');
        }
      }
      const result = await api(`/sales/${sale.id}/pay`, { method: 'POST', body: { method, reference: reference.trim(), ...(method === 'cash' ? { tendered: amount } : {}), confirmed } });
      if (onlineBridge && (result.sale?.onlineBridge !== true || result.sale.status !== 'paid' || !result.sale.paidAt)) {
        throw new Error('Woo paid evidence was not returned. Reconcile this sale; do not issue a receipt.');
      }
      onPaid(result.sale);
    } catch (e) {
      setError(e.message);
      if (onlineBridge) setUncertain(true);
      if (e.code === 'RECONCILIATION_REQUIRED' || onlineBridge) notify('Check Sales and reconcile this original order. Do not collect cash again or start another checkout.', 'error');
    }
    finally { setBusy(false); }
  }
  return <Modal title="Complete payment" subtitle={`${sale.number} · ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`} onClose={onClose} busy={busy} className="checkout-modal"><div className="modal-body"><div className="amount-due"><span>{config.mode === 'demo' ? 'Demo total' : config.mode === 'desktop' ? 'Offline local total' : 'WooCommerce order total'}</span><strong>{money(sale.total)}</strong>{Number(sale.tax) > 0 && <small>Includes {money(sale.tax)} tax · authoritative store total</small>}</div>
      {wholesale && <WholesaleQuoteDetails sale={sale} />}
      {!quoteVerified && <Notice tone="error">The approved wholesale quote cannot be verified. Do not collect payment or release goods; reconcile this order in Sales.</Notice>}
      {onlineBridge && <Notice tone="warning"><strong>Isolated local development fixture only.</strong> No real money, real customer, live Woo order, or live receipt is authorized. This test records synthetic cash custody against a temporary local Woo hold.</Notice>}
      {wrongCheckout && <Notice tone="error">This older sale cannot use the separately gated online bridge. Review it without taking cash.</Notice>}
      {onlineBridge && !reservationValid && <Notice tone="error">{holdError || 'The original Woo stock reservation is loading, expiring or not verified.'} Do not collect cash or release goods; reconcile this sale in Sales. Do not start another checkout to clear an uncertain payment.</Notice>}
      {config.mode !== 'demo' && !config.writesEnabled && <Notice tone="error">Checkout writes are locked. Do not collect payment or release goods; ask the owner to review Sales.</Notice>}
      <div className="field-label" id="payment-method-label">How was payment collected?</div><div className={`payment-options${paymentMethods.length === 1 ? ' single-method' : ''}`} role="group" aria-labelledby="payment-method-label">{paymentMethods.map(m => <button type="button" key={m} className={method === m ? 'selected' : ''} aria-pressed={method === m} onClick={() => { if (method !== m) { setMethod(m); setTendered(''); setReference(''); setConfirmed(false); setError(''); } }} disabled={busy}><PaymentIcon method={m} size={24} /><strong>{m === 'momo' ? 'MoMo' : methodLabel[m]}</strong>{method === m && <Check size={14} className="option-check" />}</button>)}</div>
      {method === 'cash' ? <><label className="field-label" htmlFor="cash-received">Cash received (GH₵)</label><input id="cash-received" className="input money-input" type="number" min={sale.total/100} step="0.01" inputMode="decimal" placeholder={(sale.total/100).toFixed(2)} value={tendered} onChange={e => setTendered(e.target.value)} disabled={busy} /><div className="quick-cash">{[...new Set([sale.total, Math.ceil(sale.total/10000)*10000, Math.ceil(sale.total/50000)*50000])].map(value => <button key={value} onClick={() => setTendered((value/100).toFixed(2))} disabled={busy}>{value === sale.total ? 'Exact amount' : money(value)}</button>)}</div><div className="change-row"><span>Change due</span><strong>{money(Math.max(0,amount-sale.total))}</strong></div></> : <><label className="field-label" htmlFor="payment-reference">{method === 'momo' ? 'MoMo transaction reference' : 'Terminal approval / merchant reference'}</label><input id="payment-reference" className="input" value={reference} onChange={e => setReference(e.target.value)} placeholder={method === 'momo' ? 'Reference from the merchant SMS or app' : 'Reference from the terminal receipt'} maxLength={80} disabled={busy} /><p className="field-hint">Never enter a card number, PIN, CVV, or customer password.</p></>}
      <Notice tone="warning">{config.mode === 'demo' ? 'Demo only. No money moves and no live WooCommerce order is created.' : onlineBridge ? 'Test fixture: only a verified original Woo hold may accept simulated cash. The POS records custody once, then checks Woo payment and stock. A lost response blocks a receipt; reconcile the original attempt without collecting again.' : config.mode === 'desktop' ? method === 'momo' ? <><strong>UNVERIFIED MoMo notice.</strong> Record the reference only; this is not a paid receipt. Hold the goods until an owner verifies payment outside the POS. Sync will leave the Woo order unpaid.</> : <>Count the cash. This sale, reserved-stock movement and sync event commit together on this computer. A local receipt does not mean the Woo order has synced yet.</> : <>This app <strong>records</strong> payment; it does not charge anything. {method === 'cash' ? 'Count the cash received.' : `Verify ${method === 'momo' ? 'the MoMo merchant notification' : 'the approved terminal receipt'} outside this app before confirming.`}{config.mode === 'live' && ' Live POS sales are cash-only; online Paystack checkout is separate.'}</>}{wholesale && <strong> Never release wholesale goods before the full amount is verified and the order shows Paid.</strong>}</Notice>
      <label className="payment-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy} /><span>{onlineBridge ? 'I entered synthetic test tender only; no real cash or customer transaction is involved.' : config.mode === 'desktop' ? method === 'momo' ? 'I understand this MoMo reference is UNVERIFIED; no goods may be released and no paid receipt is issued.' : wholesale ? 'I received and counted the full approved wholesale cash amount. The local sale will await Woo sync.' : 'I received and counted this cash. The local sale will await Woo sync.' : wholesale ? config.mode === 'demo' ? 'I understand this full wholesale payment is a demo record only.' : method === 'cash' ? 'I received and counted the full agreed cash amount for this wholesale order.' : 'I verified the full agreed wholesale payment outside the POS.' : config.mode === 'demo' ? 'I understand this is a demo payment record.' : method === 'cash' ? 'I have received and counted the cash for this order.' : 'I verified that this payment was successfully collected outside the POS.'}</span></label>
      {error && <Notice tone="error">{error}{onlineBridge && ' The attempt outcome may be uncertain. Do not retry here, collect cash, release goods or issue a receipt; close and reconcile the original sale in Sales.'}</Notice>}
    </div><div className="modal-footer" role="group" aria-label="Dialog actions"><button className="button secondary" onClick={onClose} disabled={busy}>{uncertain && onlineBridge ? 'Close · review original sale' : config.mode === 'demo' && !wholesale ? 'Cancel' : 'Leave unpaid'}</button><button className="button primary" onClick={pay} disabled={!valid || busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <ShieldCheck size={17} />}{busy ? 'Recording…' : onlineBridge ? 'Record simulated cash & verify Woo' : config.mode === 'desktop' ? method === 'momo' ? 'Record UNVERIFIED MoMo' : 'Commit local cash sale' : wholesale ? config.mode === 'demo' ? 'Complete demo wholesale sale' : 'Record full verified payment' : config.mode === 'demo' ? 'Complete demo sale' : 'Record verified payment'}</button></div></Modal>;
}

export function Receipt({ sale, config, onClose }) {
  const [width, setWidth] = useState(config.receiptWidth || '80');
  return <>{createPortal(<div id="print-root" aria-hidden="true"><ReceiptPaper sale={sale} config={config} width={width} /></div>, document.body)}<Modal title="Sale receipt" subtitle={config.onlineBridgeLocalTest && sale.onlineBridge ? 'Synthetic local test only · not proof of a live purchase.' : 'Ready to print or keep for your records.'} onClose={onClose} className="receipt-dialog"><div className="modal-body receipt-body"><div className="receipt-success"><span><CheckCircle2 size={28} /></span><div><h3>{config.onlineBridgeLocalTest && sale.onlineBridge ? 'Synthetic fixture complete' : config.mode === 'demo' ? 'Demo sale complete' : config.mode === 'desktop' && sale.paymentMethod === 'momo' ? 'MoMo UNVERIFIED — hold goods' : 'Payment recorded'}</h3><p>{config.onlineBridgeLocalTest && sale.onlineBridge ? 'Local synthetic Woo order only. No real cash, goods or live receipt are authorised.' : config.mode === 'demo' ? 'Inventory updated in the demo workspace only.' : config.mode === 'desktop' ? sale.paymentMethod === 'momo' ? 'This is a reference notice, not proof of payment or permission to release goods.' : `Cash recorded locally. ${sale.syncState === 'acked' ? 'Woo sync acknowledged.' : 'Woo synchronization is still pending.'}` : 'Order saved to WooCommerce. Stock is managed by the store.'}</p></div></div><div className="receipt-controls"><label htmlFor="paper-width">Paper width</label><select id="paper-width" value={width} onChange={e => setWidth(e.target.value)}><option value="80">80 mm thermal</option><option value="58">58 mm thermal</option><option value="a4">A4 / standard printer</option></select></div><ReceiptPaper sale={sale} config={config} width={width} /><p className="field-hint center">Printing uses the system printer driver. Test paper size and alignment on the actual Windows printer before accepting live sales.</p></div><div className="modal-footer" role="group" aria-label="Dialog actions"><button className="button secondary" onClick={onClose}>Done</button><button className="button primary" onClick={() => window.print()} disabled={config.onlineBridgeLocalTest && sale.onlineBridge}><Printer size={17} />{config.onlineBridgeLocalTest && sale.onlineBridge ? 'Printing locked for local test' : 'Print receipt'}</button></div></Modal></>;
}

function ReceiptPaper({ sale, config, width }) {
  return <div className={`receipt-paper paper-${width}`}>
    {config.mode === 'demo' && <div className="receipt-demo">DEMO — NOT A PAYMENT RECEIPT</div>}
    {config.onlineBridgeLocalTest && sale.onlineBridge && <div className="receipt-demo">SYNTHETIC LOCAL TEST — NOT A LIVE RECEIPT — NO REAL CASH</div>}
    {config.mode === 'desktop' && <div className="receipt-demo">{sale.paymentMethod === 'momo' ? 'PAYMENT UNVERIFIED — NOT A PAID RECEIPT — HOLD GOODS' : sale.syncState === 'acked' ? 'LOCAL CASH RECEIPT — WOO SYNC ACKNOWLEDGED' : 'LOCAL CASH RECEIPT — WOO SYNC PENDING'}</div>}
    <div className="receipt-brand">{(config.businessName || 'MansutRENDZGH').toUpperCase()}<span>IN-STORE COLLECTION</span></div>{(config.businessAddress || config.businessPhone || config.businessTaxId) && <div className="receipt-business">{config.businessAddress && <span>{config.businessAddress}</span>}{config.businessPhone && <span>Tel: {config.businessPhone}</span>}{config.businessTaxId && <span>Tax ID: {config.businessTaxId}</span>}</div>}<div className="receipt-rule" /><div className="receipt-meta"><span>Receipt</span><strong>{sale.number}</strong><span>Date</span><strong>{dateTime(sale.paidAt || sale.createdAt)}</strong><span>Cashier</span><strong>{sale.cashierName}</strong>{sale.saleType === 'wholesale' && <><span>Sale type</span><strong>Wholesale</strong>{sale.buyerName && <><span>Buyer</span><strong>{sale.buyerName}</strong></>}<span>Agreed prices</span><strong>{Number(sale.tax) > 0 ? 'Tax included' : 'Final price'} · approved by {sale.wholesaleApprovedByName}</strong></>}{sale.wooOrderId && <><span>WooCommerce</span><strong>#{sale.wooOrderId}</strong></>}</div><div className="receipt-rule" />
    {sale.items.map((item,i) => <div className="receipt-item" key={i}><div><strong>{item.name}</strong>{item.label && <span>Option: {item.label}</span>}<small>{item.quantity} × {money(sale.saleType === 'wholesale' ? item.agreedUnitPrice : item.price)}{sale.saleType === 'wholesale' && Number(sale.tax) > 0 ? ' · tax included' : ''}</small></div><strong>{money(sale.saleType === 'wholesale' ? item.agreedLineTotal : (item.total ?? item.price * item.quantity))}</strong></div>)}
    <div className="receipt-rule" /><div className="receipt-meta"><span>{sale.saleType === 'wholesale' && Number(sale.tax) > 0 ? 'Net before tax' : 'Subtotal'}</span><strong>{money(sale.subtotal)}</strong>{Number(sale.tax) > 0 && <><span>{sale.saleType === 'wholesale' ? 'Included tax' : 'Tax'}</span><strong>{money(sale.tax)}</strong></>}<span className="receipt-total">Total</span><strong className="receipt-total">{money(sale.total)}</strong><span>Payment</span><strong>{methodLabel[sale.paymentMethod] || 'Unpaid'}</strong>{sale.paymentMethod === 'cash' ? <><span>Cash received</span><strong>{money(sale.tendered)}</strong><span>Change</span><strong>{money(sale.changeDue)}</strong></> : sale.paymentReference ? <><span>External ref.</span><strong className="receipt-reference">{sale.paymentReference}</strong></> : null}</div><div className="receipt-rule" /><p className="receipt-footer">{config.receiptFooter}</p>{config.mode !== 'demo' && <p className="receipt-payment-note">{config.onlineBridgeLocalTest && sale.onlineBridge ? 'Synthetic local development only. No real money or goods moved; not a customer receipt.' : config.mode === 'desktop' ? sale.paymentMethod === 'momo' ? 'UNVERIFIED MoMo reference. No payment is confirmed; do not release goods.' : 'Cash counted on this computer. Keep this receipt until Woo synchronization is acknowledged.' : sale.paymentMethod === 'cash' ? 'Cash payment recorded at the counter.' : 'Payment collected externally; recorded in POS.'}</p>}<p className="receipt-thanks">Made for your everyday style.</p>
  </div>;
}
