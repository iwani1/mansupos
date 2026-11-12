import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Minus, Plus, RefreshCw, Search, ShieldCheck, ShoppingBag, Trash2, WifiOff } from 'lucide-react';
import { api, money, uuid } from './api.js';
import { Empty, Modal, Notice, PageHeading, ProductImage } from './components.jsx';
import { available, allowsBackorders, hasKnownStock, onBackorder } from './stock.js';

// Final agreed amounts are entered in GHS but sent as integer pesewas. Never
// derive them from quantity or a catalogue discount/tier.
function agreedCents(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount >= 1 && amount <= 100000000 ? amount : null;
}
const productCanSell = (product, requireSource) => product?.type === 'variable'
  ? product.purchasable && product.stockStatus !== 'outofstock' && product.variations.some(option => available(option, requireSource))
  : available(product, requireSource);
const stockCaption = line => {
  if (onBackorder(line)) return line.backorders === 'notify' ? 'Backorder · notify buyer' : 'Available on backorder';
  if (!line.manageStock) return 'Stock not tracked';
  if (!hasKnownStock(line)) return allowsBackorders(line) ? 'Backorders allowed · stock unavailable' : 'Stock unavailable';
  return `${line.stock} available${line.stockSource === 'parent' ? ' · shared across options' : ''}`;
};

export default function Wholesale({ catalog, config, user, checkoutScope, refresh, notify, onPrepared, onOpenSales, shift, onOpenShift }) {
  const [buyerName, setBuyerName] = useState('');
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedOption, setSelectedOption] = useState(null);
  const [note, setNote] = useState('');
  const [step, setStep] = useState('compose');
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const checkoutKey = useRef(uuid());
  const storageKey = `mansu-wholesale-checkout-${checkoutScope}`;
  const products = useMemo(() => catalog?.products || [], [catalog]);
  const namedBuyer = buyerName.trim().replace(/\s+/g, ' ');
  const validBuyerName = !namedBuyer || (namedBuyer.length >= 2 && [...buyerName].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
  const requireSource = config.mode !== 'demo';
  const shiftRequired = config.requireShift && config.mode !== 'demo' && !config.liveReadOnly;
  const catalogueTotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
  const total = lines.reduce((sum, line) => sum + (agreedCents(line.priceInput) || 0) * line.quantity, 0);
  const validPrices = lines.length > 0 && lines.every(line => agreedCents(line.priceInput) !== null);
  const quoteReady = Boolean(validBuyerName && validPrices && total > 0 && total <= 100000000);
  const locked = !online || config.liveReadOnly || !config.wholesaleWritesEnabled || (shiftRequired && !shift);
  const filtered = products.filter(product => {
    const text = query.trim().toLowerCase();
    return !text || `${product.name} ${product.sku || ''} ${product.barcode || ''} ${(product.variations || []).map(option => `${option.label} ${option.sku} ${option.barcode}`).join(' ')}`.toLowerCase().includes(text);
  });
  const fingerprint = useMemo(() => JSON.stringify({ saleType: 'wholesale', buyerName: namedBuyer, note: note.trim(),
    items: [...lines].sort((a, b) => a.productId - b.productId || a.variationId - b.variationId)
      .map(line => ({ productId: line.productId, variationId: line.variationId, quantity: line.quantity,
        agreedUnitPrice: agreedCents(line.priceInput) ?? line.priceInput })),
  }), [namedBuyer, note, lines]);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => {
    try {
      const previous = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      checkoutKey.current = previous?.fingerprint === fingerprint && previous.key ? previous.key : uuid();
      setError(previous?.uncertain && previous.fingerprint === fingerprint
        ? 'A previous order for this quote may exist. Retry with the same key or review Sales before changing it.' : '');
    } catch { checkoutKey.current = uuid(); setError(''); }
  }, [fingerprint, storageKey]);

  function invalidate() { setApproved(false); setError(''); }
  function addLine(product, option = null) {
    const stock = option || product;
    if (!productCanSell(product, requireSource) || !available(stock, requireSource)) return;
    const key = `${product.id}:${option?.id || 0}`;
    const existing = lines.find(line => line.key === key);
    const next = (existing?.quantity || 0) + 1;
    const otherOptions = lines.filter(line => line.productId === product.id && line.key !== key);
    const shared = stock.stockSource === 'parent' ? otherOptions.filter(line => line.stockSource === 'parent') : [];
    const pool = next + shared.reduce((sum, line) => sum + line.quantity, 0);
    if (next > 999 || product.soldIndividually && next + otherOptions.reduce((sum, line) => sum + line.quantity, 0) > 1) {
      notify('This product cannot be added in that quantity.', 'error'); return;
    }
    if ([stock, ...shared.map(line => product.variations.find(v => v.id === line.variationId) || line)]
      .some(source => source.manageStock && hasKnownStock(source) && !allowsBackorders(source) && pool > source.stock)) {
      notify('Not enough stock for this option or its shared product stock. Refresh the catalogue.', 'error'); return;
    }
    const line = { key, productId: product.id, variationId: option?.id || 0, name: product.name,
      label: option?.label || '', image: stock.image || product.image, sku: stock.sku || product.sku,
      price: stock.price, priceInput: existing?.priceInput ?? '', quantity: next, stockSource: stock.stockSource };
    setLines(previous => existing ? previous.map(item => item.key === key ? line : item) : [...previous, line]);
    invalidate(); notify(`${product.name}${option ? ` · ${option.label}` : ''} added to the quote.`);
  }
  function changeQuantity(line, amount) {
    if (amount > 0) {
      const product = products.find(item => item.id === line.productId);
      const option = product?.variations.find(item => item.id === line.variationId);
      if (!product || line.variationId && !option) { notify('This product option is no longer available. Refresh before continuing.', 'error'); return; }
      addLine(product, option);
    } else {
      setLines(previous => previous.map(item => item.key === line.key ? { ...item, quantity: item.quantity - 1 } : item).filter(item => item.quantity > 0));
      invalidate();
    }
  }
  function resetDraft() {
    if (!window.confirm('Clear this unsubmitted wholesale quote? Review Sales first if an order may already have been created.')) return;
    setBuyerName(''); setLines([]); setNote(''); setQuery(''); setStep('compose'); setApproved(false);
  }
  async function prepare() {
    if (!quoteReady || !approved || locked || busy) return;
    setBusy(true); setError('');
    try { sessionStorage.setItem(storageKey, JSON.stringify({ key: checkoutKey.current, fingerprint, uncertain: false })); } catch {}
    try {
      const { sale } = await api('/sales/prepare', { method: 'POST', body: {
        idempotencyKey: checkoutKey.current, saleType: 'wholesale', ...(namedBuyer ? { buyerName: namedBuyer } : {}), wholesaleApproved: true,
        items: lines.map(line => ({ productId: line.productId, variationId: line.variationId, quantity: line.quantity,
          agreedUnitPrice: agreedCents(line.priceInput) })), note,
      } });
      try { sessionStorage.removeItem(storageKey); } catch {}
      if (sale.status !== 'awaiting_payment') {
        notify('This order has already been paid. Check Sales before releasing goods or taking another payment.', 'error');
        onOpenSales(); return;
      }
      setBuyerName(''); setLines([]); setNote(''); setStep('compose'); setApproved(false);
      onPrepared(sale); refresh();
    } catch (err) {
      const uncertain = !err.status || err.status >= 500 || ['RECONCILIATION_REQUIRED', 'SALE_BUSY'].includes(err.code);
      if (uncertain) {
        try { sessionStorage.setItem(storageKey, JSON.stringify({ key: checkoutKey.current, fingerprint, uncertain: true })); } catch {}
      }
      setError(uncertain ? `${err.message} Do not create another order or take payment until the original order is checked in Sales.` : err.message);
    } finally { setBusy(false); }
  }

  return <div className="wholesale-page">
    <PageHeading eyebrow="Negotiated order · full payment" title="Wholesale" description="Add goods, agree final tax-inclusive prices, approve the quote, then record full payment before release. Buyer name is optional.">
      <button className="button secondary" onClick={onOpenSales}>View sales history <ArrowRight size={16} /></button>
    </PageHeading>
    <ol className="wholesale-steps" aria-label="Wholesale order steps" tabIndex={0}><li className={step === 'review' ? 'done' : 'current'}>1 <span>Goods & prices</span></li><li className={step === 'review' ? 'current' : ''}>2 <span>Review & approve</span></li><li>3 <span>Full payment</span></li></ol>
    {!online && <Notice tone="warning" icon={WifiOff}>You’re offline. You may review a draft, but cannot prepare an order or record payment.</Notice>}
    {config.liveReadOnly ? <Notice tone="warning">Live catalogue pilot only. Negotiated amounts cannot be verified against WooCommerce tax here; no quote can be approved, no order can be created, and no payment can be recorded. Do not release goods.</Notice> : !config.wholesaleWritesEnabled && <Notice tone="warning">Wholesale writes are separately locked. An owner must approve the separate Wholesale acceptance plan and live use; Retail approval alone does not unlock it.</Notice>}
    {shiftRequired && !shift && <Notice tone="warning">Open a shift before preparing an order. <button className="text-button" onClick={onOpenShift}>Open shift</button></Notice>}
    <div className="wholesale-layout"><div className="wholesale-flow">
      {step === 'compose' ? <>
        <section className="surface wholesale-panel" aria-labelledby="wholesale-goods-title">
          <div className="wholesale-panel-heading"><span className="wholesale-step-number">01</span><div><span className="eyebrow">Start with the goods</span><h2 id="wholesale-goods-title">Add goods & agree prices</h2><p>Enter a final tax-inclusive unit price for each product or option. No buyer selection is needed.</p></div><ShoppingBag size={21} aria-hidden="true" /></div>
          <div className="wholesale-product-search"><Search size={18} aria-hidden="true" /><input className="input" aria-label="Search wholesale products" placeholder="Search by product, SKU or barcode" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" className="button secondary small" onClick={() => refresh(true)} aria-label="Refresh wholesale catalogue"><RefreshCw size={16} /></button></div>
          <div className="wholesale-products" role="region" aria-label="Available wholesale products" tabIndex={0}>{!filtered.length ? <Empty icon={Search} title="No matching goods">Try a different product name or SKU.</Empty> : filtered.map(product => {
            const canSell = productCanSell(product, requireSource);
            return <button type="button" key={product.id} className="wholesale-product" disabled={!canSell} onClick={() => product.type === 'variable' ? (setSelectedProduct(product), setSelectedOption(product.variations.find(option => available(option, requireSource)) || null)) : addLine(product)}><ProductImage src={product.image} name={product.name} /><span><strong>{product.name}</strong><small>{product.sku || 'No SKU'} · {canSell ? product.type === 'variable' ? 'Choose an option' : stockCaption(product) : 'Unavailable'}</small></span><span className="wholesale-reference">{product.type === 'variable' ? 'Options' : money(product.price)}<Plus size={16} aria-hidden="true" /></span></button>;
          })}</div>
        </section>
        <section className="surface wholesale-panel" aria-labelledby="wholesale-lines-title"><div className="wholesale-panel-heading"><span className="wholesale-step-number">01</span><div><span className="eyebrow">Negotiated for this order</span><h2 id="wholesale-lines-title">The agreed lines</h2><p>Catalogue amounts below are references only. There are no quantity tiers.</p></div></div>
          {!lines.length ? <div className="wholesale-empty-lines"><ShoppingBag size={24} aria-hidden="true" /><p>Add one or more goods above, then enter the negotiated price for each.</p></div> : <div className="wholesale-lines">{lines.map(line => {
            const agreed = agreedCents(line.priceInput);
            return <div className="wholesale-line" key={line.key}><ProductImage src={line.image} name={line.name} /><div className="wholesale-line-detail"><div className="wholesale-line-heading"><div><h3>{line.name}</h3><small>{line.label || 'Standard'} · Catalogue {money(line.price)}</small></div><button type="button" aria-label={`Remove ${line.name}${line.label ? ` ${line.label}` : ''} from quote`} onClick={() => { setLines(previous => previous.filter(entry => entry.key !== line.key)); invalidate(); }}><Trash2 size={17} /></button></div><div className="wholesale-line-fields"><div><span className="field-label">Quantity</span><div className="quantity-control"><button type="button" aria-label={`Decrease ${line.name}`} onClick={() => changeQuantity(line, -1)}><Minus size={14} /></button><span>{line.quantity}</span><button type="button" aria-label={`Increase ${line.name}`} onClick={() => changeQuantity(line, 1)}><Plus size={14} /></button></div></div><div><label className="field-label" htmlFor={`wholesale-price-${line.productId}-${line.variationId}`}>Agreed unit · tax included (GH₵)</label><input className="input" id={`wholesale-price-${line.productId}-${line.variationId}`} type="text" inputMode="decimal" maxLength={10} placeholder="0.00" aria-label={`Agreed unit price for ${line.name}${line.label ? ` · ${line.label}` : ''} (GH₵, tax included)`} aria-invalid={Boolean(line.priceInput && agreed === null)} value={line.priceInput} onChange={event => { setLines(previous => previous.map(item => item.key === line.key ? { ...item, priceInput: event.target.value } : item)); invalidate(); }} />{line.priceInput && agreed === null && <small className="wholesale-price-error">Enter a positive amount with at most two decimals.</small>}</div><div className="wholesale-line-total"><span>Line total</span><strong>{agreed === null ? 'Enter price' : money(agreed * line.quantity)}</strong></div></div></div></div>;
          })}</div>}
          <div className="wholesale-optional-buyer"><label className="field-label" htmlFor="wholesale-buyer-name">Buyer name (optional)</label><input className="input" id="wholesale-buyer-name" value={buyerName} maxLength={120} autoComplete="off" placeholder="Leave blank if not needed" aria-invalid={!validBuyerName} aria-describedby="wholesale-buyer-hint" onChange={event => { setBuyerName(event.target.value); invalidate(); }} /><small id="wholesale-buyer-hint" className={!validBuyerName ? 'wholesale-price-error' : ''}>{validBuyerName ? 'No selection required. If entered, the name appears on the order, receipt and reports.' : 'Use at least two characters and one line, or leave this blank.'}</small></div>
          <label className="wholesale-note" htmlFor="wholesale-note">Order note (sent to WooCommerce; optional)<textarea className="input" id="wholesale-note" value={note} maxLength={250} onChange={event => { setNote(event.target.value); invalidate(); }} placeholder="Avoid sensitive details or payment terms" /></label>
        </section>
      </> : <section className="surface wholesale-panel wholesale-review" aria-labelledby="wholesale-review-title"><div className="wholesale-panel-heading"><span className="wholesale-step-number">02</span><div><span className="eyebrow">Before creating an order</span><h2 id="wholesale-review-title">Review & approve the quote</h2><p>Verify every line and the all-in amount before preparing this order.</p></div></div>
        <div className="wholesale-review-buyer"><span>Buyer name</span><strong>{namedBuyer || 'Not provided'}</strong><span>Approving manager / owner</span><strong>{user.name}</strong></div>
        <ol className="wholesale-review-lines">{lines.map(line => <li key={line.key}><div><strong>{line.name}{line.label ? ` · ${line.label}` : ''}</strong><small>{line.quantity} × {money(agreedCents(line.priceInput))} tax included · Catalogue {money(line.price)}</small></div><strong>{money(agreedCents(line.priceInput) * line.quantity)}</strong></li>)}</ol>
        {note && <p className="wholesale-review-note">WooCommerce order note: {note}</p>}
        <div className="wholesale-review-total"><span>Final agreed amount · no extra tax</span><strong>{money(total)}</strong></div>
        <Notice tone="warning">WooCommerce must reproduce the agreed tax-inclusive total for each line and the order. This quote does not authorize dispatch on credit. Verify and record <strong>full payment before goods leave</strong>.</Notice>
        <label className="wholesale-approve"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} disabled={busy} /><span>I, {user.name}, approve these final tax-inclusive prices for this order{namedBuyer ? ` (${namedBuyer})` : ''} only.</span></label>
        {error && <Notice tone="error">{error} <button className="text-button" type="button" onClick={onOpenSales}>Review Sales</button></Notice>}
        <div className="wholesale-review-actions"><button type="button" className="button secondary" onClick={() => { setStep('compose'); setApproved(false); }} disabled={busy}>Edit quote</button><button type="button" className="button primary" onClick={prepare} disabled={!quoteReady || !approved || locked || busy}><ShieldCheck size={17} />{busy ? 'Preparing order…' : 'Prepare wholesale order'}</button></div>
      </section>}
    </div><aside className="surface wholesale-summary" aria-label="Wholesale quote summary"><span className="eyebrow">Order overview</span><h2>{namedBuyer || 'Wholesale quote'}</h2><p>{step === 'review' ? 'Ready for explicit approval' : 'Add goods and agree prices; buyer name is optional'}</p><div><span>Goods</span><strong>{lines.reduce((sum, line) => sum + line.quantity, 0)} items</strong></div><div><span>Catalogue reference</span><strong>{money(catalogueTotal)}</strong></div><div><span>Agreed amount · tax included</span><strong>{money(total)}</strong></div><small>{config.mode === 'demo' ? 'No demo tax is added. No live payments or orders.' : config.liveReadOnly ? 'Pilot only · tax and totals are not verified and no order is created.' : 'WooCommerce verifies included tax and the final amount before payment.'}</small>{step === 'compose' && <button className="button primary" type="button" disabled={!quoteReady || config.liveReadOnly} onClick={() => { setApproved(false); setStep('review'); }}>Review quote <ArrowRight size={16} /></button>}{step === 'compose' && lines.length > 0 && !validPrices && <span className="wholesale-summary-hint">Enter every agreed unit price to continue.</span>}{step === 'compose' && !validBuyerName && <span className="wholesale-summary-hint">Enter a valid buyer name or leave it blank.</span>}{total > 100000000 && <span className="wholesale-summary-hint">The agreed total must not exceed GH₵1,000,000.00.</span>}{(lines.length > 0 || buyerName || note) && <button type="button" className="wholesale-clear" onClick={resetDraft} disabled={busy}>Clear this draft</button>}</aside></div>
    {selectedProduct && <Modal title={`Choose an option · ${selectedProduct.name}`} subtitle="Availability is checked again before the order is prepared." onClose={() => setSelectedProduct(null)}><div className="modal-body"><div className="wholesale-variant-list" role="group" aria-label="Product options">{selectedProduct.variations.map(option => <button key={option.id} type="button" aria-pressed={selectedOption?.id === option.id} disabled={!available(option, requireSource)} className={selectedOption?.id === option.id ? 'selected' : ''} onClick={() => setSelectedOption(option)}><span><strong>{option.label || option.sku || `Option #${option.id}`}</strong><small>{stockCaption(option)}</small></span><span>{money(option.price)}</span>{selectedOption?.id === option.id && <Check size={16} />}</button>)}</div></div><div className="modal-footer" role="group" aria-label="Dialog actions"><button type="button" className="button secondary" onClick={() => setSelectedProduct(null)}>Cancel</button><button type="button" className="button primary" disabled={!selectedOption} onClick={() => { addLine(selectedProduct, selectedOption); setSelectedProduct(null); }}>Add to quote</button></div></Modal>}
  </div>;
}
