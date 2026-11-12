import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search, ScanLine, RefreshCw, Plus, Minus, Trash2, ShoppingBag, ArrowRight, X, Pause, Play, UserRound, StickyNote, Check, WifiOff, LayoutGrid, List, Banknote, ShieldCheck } from 'lucide-react';
import { api, money, uuid } from './api.js';
import { IconButton, Badge, ProductImage, Empty, Modal, Notice, PageHeading, NoResults } from './components.jsx';
import { available, physicallyInStock, allowsBackorders, hasKnownStock, stockUnknown, ownershipUnknown, onBackorder } from './stock.js';

const parentAllowsSale = p => Boolean(p?.purchasable && p.stockStatus !== 'outofstock');
const productAvailable = (p, requireSource = false) => Boolean(p && (p.type === 'variable' ? parentAllowsSale(p) && p.variations.some(v => available(v, requireSource)) : available(p, requireSource)));
const productInStock = (p, requireSource = false) => Boolean(p && (p.type === 'variable' ? parentAllowsSale(p) && p.variations.some(v => physicallyInStock(v, requireSource)) : physicallyInStock(p, requireSource)));
const sizesOnly = p => p.variations.length > 0 && p.variations.every(v => v.attributes?.length === 1 && /^(?:pa_)?size$/i.test((v.attributes[0].name || '').trim()));
const optionStockText = (line, requireSource = false) => {
  if (line.stockStatus === 'outofstock') return 'Out of stock';
  if (stockUnknown(line, requireSource)) return !ownershipUnknown(line, requireSource) && allowsBackorders(line) ? 'Backorders allowed · stock unavailable' : 'Stock unavailable';
  if (!available(line, requireSource)) return 'Unavailable';
  if (onBackorder(line)) return line.backorders === 'notify' ? 'Backorder · notify customer' : 'Available on backorder';
  if (!line.manageStock) return 'Stock not tracked';
  return `${line.stock} available${line.stockSource === 'parent' ? ' · shared across options' : ''}`;
};
export default function Register({ active = true, catalog, config, checkoutScope, refresh, notify, onPrepared, onOpenSales, savedCarts, setSavedCarts, setHelp, shift, onOpenShift }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All products');
  const [stockOnly, setStockOnly] = useState(false);
  const [view, setView] = useState('grid');
  const [cart, setCart] = useState([]);
  const [variantProduct, setVariantProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [variantQty, setVariantQty] = useState(1);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scanner, setScanner] = useState(false);
  const [scanValue, setScanValue] = useState('');
  const [heldOpen, setHeldOpen] = useState(false);
  const [mobileCart, setMobileCart] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const searchRef = useRef(null);
  const cartDetailsRef = useRef(null);
  const cartPanelRef = useRef(null);
  const checkoutKey = useRef(uuid());
  const checkoutStorageKey = `mansu-checkout-${checkoutScope || `${config.mode}-anonymous`}`;
  const scanBuffer = useRef({ value: '', time: 0 });
  const products = useMemo(() => catalog?.products || [], [catalog]);
  const requireStockSource = config.mode !== 'demo';
  const categories = ['All products', ...new Set(products.map(p => p.category))];
  // Demo variations each own their stock; live variations can share parent stock, so do not add them up.
  const productStock = p => p.type === 'variable' ? (config.mode === 'demo' ? p.variations.reduce((sum,v) => sum + (v.manageStock ? Math.max(0, v.stock || 0) : 0),0) : null) : p.stock;
  const filtered = useMemo(() => products.filter(p => {
    const q = query.trim().toLowerCase();
    return (category === 'All products' || p.category === category || p.categories?.includes(category)) && (!stockOnly || productInStock(p, requireStockSource)) && (!q || `${p.name} ${p.sku} ${p.barcode} ${p.variations.map(v => `${v.sku} ${v.barcode} ${v.label}`).join(' ')}`.toLowerCase().includes(q));
  }), [products, query, category, stockOnly, requireStockSource]);
  const scanExample = config.mode === 'demo' ? products.flatMap(p => (p.type === 'variable' ? p.variations : [p]).map(line => ({ product: p, line }))).find(({ product, line }) => productAvailable(product) && available(line) && line.barcode?.startsWith('DEMO-')) : null;
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const count = cart.reduce((sum,item) => sum + item.quantity, 0);

  useEffect(() => { const on = () => setOnline(true), off = () => setOnline(false); window.addEventListener('online', on); window.addEventListener('offline', off); return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); }; }, []);
  useEffect(() => { if (error && cartDetailsRef.current) cartDetailsRef.current.scrollTop = cartDetailsRef.current.scrollHeight; }, [error]);
  useEffect(() => {
    if (!mobileCart) return;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = e => {
      if (document.querySelector('.modal-backdrop')) return;
      if (e.key === 'Escape') { e.preventDefault(); setMobileCart(false); }
      if (e.key !== 'Tab') return;
      const controls = [...(cartPanelRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') || [])].filter(el => el.getClientRects().length);
      if (!controls.length) return;
      if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0].focus(); }
    };
    document.addEventListener('keydown', onKey);
    cartPanelRef.current?.querySelector('[aria-label="Close cart"]')?.focus();
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [mobileCart]);
  const cartFingerprint = useMemo(() => JSON.stringify({ note: note.trim(),
    items: [...cart].sort((a,b) => a.productId - b.productId || a.variationId - b.variationId)
      .map(({productId,variationId,quantity}) => ({ productId, variationId, quantity })),
  }), [cart, note]);
  useEffect(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(checkoutStorageKey) || 'null');
      if (stored?.fingerprint === cartFingerprint && stored.key) checkoutKey.current = stored.key;
      else checkoutKey.current = uuid();
    } catch { checkoutKey.current = uuid(); }
    setError('');
  }, [cartFingerprint, checkoutStorageKey]);
  useEffect(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(checkoutStorageKey) || 'null');
      if (stored?.uncertain && stored.fingerprint === cartFingerprint) setError('A previous checkout for this cart was interrupted. Retry safely with the same checkout key, or review Sales before starting another order.');
    } catch {}
    // Mount-only recovery notice for the initial cart fingerprint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const key = e => {
      if (!active) return;
      const tag = document.activeElement?.tagName;
      const editing = ['INPUT','TEXTAREA','SELECT'].includes(tag) || document.activeElement?.isContentEditable;
      if (e.key === 'F2') { e.preventDefault(); setScanner(true); return; }
      if (e.key === '/' && !editing && !document.querySelector('[role="dialog"]')) { e.preventDefault(); searchRef.current?.focus(); }
      if (editing || scanner || variantProduct || heldOpen || document.querySelector('[role="dialog"]')) return;
      const time = Date.now();
      if (time - scanBuffer.current.time > 100) scanBuffer.current.value = '';
      scanBuffer.current.time = time;
      if (e.key === 'Enter' && scanBuffer.current.value.length >= 4) { e.preventDefault(); scan(scanBuffer.current.value); scanBuffer.current.value = ''; }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) scanBuffer.current.value += e.key;
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  function addLine(product, variant = null, quantity = 1) {
    const source = variant || product;
    if (!productAvailable(product, requireStockSource) || !available(source, requireStockSource)) { notify('This item is unavailable or out of stock.', 'error'); return false; }
    const key = `${product.id}:${variant?.id || 0}`;
    const existing = cart.find(i => i.key === key);
    const nextQty = (existing?.quantity || 0) + quantity;
    if (!Number.isInteger(quantity) || quantity < 1) return false;
    const otherOptions = cart.filter(i => i.productId === product.id && i.key !== key);
    if (product.soldIndividually && nextQty + otherOptions.reduce((sum, i) => sum + i.quantity, 0) > 1) { notify('This product is limited to one per sale.', 'error'); return false; }
    const sharedOptions = source.stockSource === 'parent' ? otherOptions.map(i => ({ item: i, source: product.variations.find(v => v.id === i.variationId) || i })).filter(({ source: s }) => s.stockSource === 'parent') : [];
    const poolQty = nextQty + sharedOptions.reduce((sum, entry) => sum + entry.item.quantity, 0);
    const limit = [source, ...sharedOptions.map(entry => entry.source)].find(s => s.manageStock && hasKnownStock(s) && !allowsBackorders(s) && poolQty > s.stock);
    if (limit) {
      notify(`Only ${limit.stock} available ${source.stockSource === 'parent' ? 'across these options' : 'for this item'}.`, 'error'); return false;
    }
    const optionLabel = variant ? (sizesOnly(product) ? `Size ${variant.label}` : variant.attributes?.map(a => [a.name?.replace(/^pa_/i, ''), a.option].filter(Boolean).join(': ')).filter(Boolean).join(' · ') || variant.label) : '';
    const line = { key, productId: product.id, variationId: variant?.id || 0, name: product.name, label: variant?.label || '', optionLabel, sku: source.sku, barcode: source.barcode, image: source.image, price: source.price, stock: source.stock, stockSource: source.stockSource, stockStatus: source.stockStatus, manageStock: source.manageStock, backorders: source.backorders, backordersAllowed: source.backordersAllowed, quantity: nextQty };
    setCart(previous => existing ? previous.map(i => i.key === key ? line : i) : [...previous, line]);
    notify(`${product.name}${variant ? ` · ${variant.label}` : ''} added`);
    return true;
  }
  function selectProduct(p) {
    if (!productAvailable(p, requireStockSource)) { notify('This product has no available options.', 'error'); return; }
    if (p.type === 'variable') { setVariantProduct(p); setSelectedVariant(p.variations.find(v => available(v, requireStockSource)) || null); setVariantQty(1); }
    else addLine(p);
  }
  function scan(code) {
    const value = code.trim().toLowerCase();
    if (!value) return;
    for (const p of products) {
      if ([p.sku,p.barcode,String(p.id)].some(v => v?.toLowerCase() === value)) { selectProduct(p); setScanner(false); setScanValue(''); return; }
      const variant = p.variations.find(v => [v.sku,v.barcode,String(v.id)].some(x => x?.toLowerCase() === value));
      if (variant) { addLine(p, variant); setScanner(false); setScanValue(''); return; }
    }
    notify(`No exact SKU/barcode match for “${code.trim()}”. Search by name instead.`, 'error');
  }
  function searchSubmit(e) {
    e.preventDefault();
    const exact = products.find(p => [p.sku,p.barcode,String(p.id)].some(v => v?.toLowerCase() === query.trim().toLowerCase()));
    if (exact) { selectProduct(exact); setQuery(''); }
    else { const vMatch = products.flatMap(p => p.variations.map(v => ({ p,v }))).find(({v}) => [v.sku,v.barcode,String(v.id)].some(x => x?.toLowerCase() === query.trim().toLowerCase())); if (vMatch) { addLine(vMatch.p,vMatch.v); setQuery(''); } else if (filtered.length === 1) selectProduct(filtered[0]); else if (!filtered.length) notify('No matching product or SKU.', 'error'); }
  }
  function changeQty(key, delta) {
    const item = cart.find(i => i.key === key);
    if (delta > 0) {
      const p = products.find(p => p.id === item.productId); const v = p?.variations.find(v => v.id === item.variationId);
      if (!p || (item.variationId && !v)) { notify('This option is no longer in the catalogue. Remove it or refresh before checkout.', 'error'); return; }
      if (!addLine(p,v,1)) return;
    } else { setCart(previous => previous.map(i => i.key === key ? { ...i, quantity: i.quantity - 1 } : i).filter(i => i.quantity > 0)); }
  }
  function hold() {
    if (!cart.length) return;
    setSavedCarts(previous => [...previous, { id: uuid(), cart, note, created: new Date().toISOString() }]);
    setCart([]); setNote(''); notify('Sale held on this device. No order or payment has been created.');
  }
  async function checkout() {
    if (!cart.length || busy) return;
    setBusy(true); setError('');
    const attempt = { key: checkoutKey.current, fingerprint: cartFingerprint, uncertain: false };
    try { sessionStorage.setItem(checkoutStorageKey, JSON.stringify(attempt)); } catch {}
    try {
      const { sale } = await api('/sales/prepare', { method: 'POST', body: {
        idempotencyKey: checkoutKey.current,
        items: cart.map(({productId,variationId,quantity}) => ({productId,variationId,quantity})), note,
      } });
      try { sessionStorage.removeItem(checkoutStorageKey); } catch {}
      onPrepared(sale); setCart([]); setNote(''); setMobileCart(false); refresh();
    } catch (e) {
      const uncertain = !e.status || e.status >= 500 || e.code === 'RECONCILIATION_REQUIRED' || e.code === 'SALE_BUSY';
      if (uncertain) {
        try { sessionStorage.setItem(checkoutStorageKey, JSON.stringify({ ...attempt, uncertain: true })); } catch {}
        setError(e.code === 'RECONCILIATION_REQUIRED' ? e.message : 'Checkout was interrupted. Retry safely with the same checkout key, or review Sales before creating another order.');
        if (e.code === 'RECONCILIATION_REQUIRED') onOpenSales();
      } else {
        try { sessionStorage.removeItem(checkoutStorageKey); } catch {}
        checkoutKey.current = uuid();
        setError(e.message);
      }
    }
    finally { setBusy(false); }
  }
  function cartBackorder(item) {
    const product = products.find(p => p.id === item.productId);
    const source = (item.variationId ? product?.variations.find(v => v.id === item.variationId) : product) || item;
    const quantity = source.stockSource === 'parent' && product ? cart.filter(i => i.productId === product.id && (product.variations.find(v => v.id === i.variationId)?.stockSource ?? i.stockSource) === 'parent').reduce((sum, i) => sum + i.quantity, 0) : item.quantity;
    const mayBeBackordered = onBackorder(source) || (source.manageStock && allowsBackorders(source) && (!hasKnownStock(source) || quantity > source.stock));
    return mayBeBackordered ? (source.backorders === 'notify' ? 'Backorder · notify customer' : 'Backorder') : '';
  }
  const shiftRequired = config.requireShift && config.mode !== 'demo' && !config.liveReadOnly;
  const checkoutDisabled = !cart.length || busy || !online || (config.mode !== 'demo' && !config.writesEnabled) || (shiftRequired && !shift);
  return <div className="register-page">
    <div className="register-layout">
      <section className="catalog-panel" inert={mobileCart}>
        <PageHeading eyebrow="In-store · MansutRENDZGH" title="Point of sale" description="Search, scan or select products.">
          <button className="button secondary held-button" onClick={() => setHeldOpen(true)}><Pause size={16} />Held sales <span className="count-pill">{savedCarts.length}</span></button>
        </PageHeading>
        {config.liveReadOnly && <Notice tone="warning">Live WooCommerce catalogue. Cart amounts are references, not verified payable totals. Checkout and payment recording are disabled; do not collect money or release goods through this POS.</Notice>}
        {!online && <Notice tone="warning" icon={WifiOff}>You’re offline. Checkout is disabled; no offline payment queue is stored. Reconnect and refresh before selling.</Notice>}
        {shiftRequired && !shift && <Notice tone="warning" icon={Banknote}>Open a shift before selling. This keeps cash, refunds, and day-end totals accountable. <button className="text-button" onClick={onOpenShift}>Open shift</button></Notice>}
        {shiftRequired && shift && <div className="shift-strip"><Banknote size={16}/><span>Shift open · {shift.userName} · opening float {money(shift.openingFloat)}</span><button className="text-button" onClick={onOpenShift}>Manage shift</button></div>}
        <div className="catalog-search-row"><form className="search-field" onSubmit={searchSubmit}><Search size={20} /><input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Name or SKU" aria-label="Search by product name, SKU or barcode" />{query ? <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button> : <kbd>/</kbd>}</form><button className="button secondary scanner-button" aria-label="Scan product F2" title="Scan product (F2)" onClick={() => setScanner(true)}><ScanLine size={18} /><span>Scan product{' '}</span><kbd>F2</kbd></button><IconButton icon={RefreshCw} label="Refresh catalogue" onClick={refresh} /></div>
        <div className="category-tabs" role="group" aria-label="Filter products by category">{categories.map(c => <button aria-pressed={category === c} className={category === c ? 'active' : ''} key={c} onClick={() => setCategory(c)}>{c}{c === 'All products' && <span>{products.length}</span>}</button>)}</div>
        <div className="catalog-meta"><span><strong>{filtered.length}</strong> products <span className="muted">· {config.mode === 'demo' ? 'Sample catalogue' : 'WooCommerce catalogue'}</span></span><div><label className="check-label"><input type="checkbox" checked={stockOnly} onChange={e => setStockOnly(e.target.checked)} />In stock only</label><div className="view-switch"><IconButton icon={LayoutGrid} label="Grid view" aria-pressed={view === 'grid'} className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} /><IconButton icon={List} label="List view" aria-pressed={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} /></div></div></div>
        <h2 className="sr-only">Products</h2>
        {!filtered.length ? <NoResults clear={() => { setQuery(''); setCategory('All products'); setStockOnly(false); }} /> : <div className={`product-grid ${view === 'list' ? 'list-view' : ''}`}>{filtered.map((p, index) => {
          const inStock = productAvailable(p, requireStockSource); const qty = productStock(p); const inCart = cart.filter(i => i.productId === p.id).reduce((n,i) => n + i.quantity,0);
          const unknown = p.type === 'variable' ? p.variations.some(v => stockUnknown(v, requireStockSource)) : stockUnknown(p, requireStockSource);
          const stockText = !inStock ? unknown && p.stockStatus !== 'outofstock' ? 'Stock unavailable' : 'Out of stock' : p.type === 'variable' && requireStockSource ? 'See option availability' : p.type !== 'variable' && unknown ? 'Backorders allowed · stock unavailable' : onBackorder(p) ? 'Available on backorder' : !p.manageStock || qty == null ? 'Stock not tracked' : config.mode === 'demo' ? `${qty} in demo stock` : `${qty} in stock`;
          return <button key={p.id} className={`product-card ${!inStock ? 'unavailable' : ''}`} style={{ '--i': Math.min(index, 5) }} onClick={() => selectProduct(p)} disabled={!inStock}>
            <span className="sr-only">Add to sale: </span>
            <div className="product-photo-wrap" aria-hidden="true"><ProductImage src={p.image} name={p.name} />{config.mode === 'demo' && <span className="image-credit">Demo image</span>}{p.type === 'variable' && <span className="variant-tag">{p.variations.length} {sizesOnly(p) ? 'sizes' : 'options'}</span>}{inCart > 0 && <span className="in-cart-tag"><Check size={12} />{inCart} in sale</span>}{!inStock && <span className="sold-out-overlay">{stockText}</span>}</div>
            <div className="product-info"><span className="product-category">{p.category}</span><h3>{p.name}</h3><div className="product-bottom"><strong>{money(p.price)}</strong><span className="product-add" aria-hidden="true"><Plus size={18} /></span></div><div className={`stock-caption ${!inStock ? 'unavailable' : qty !== null && qty <= config.lowStockThreshold ? 'low' : ''}`}><span className="status-dot" aria-hidden="true" />{stockText}</div></div>
          </button>;
        })}</div>}
        <div className="catalog-footer"><ShieldCheck size={15} /><span>{config.mode === 'demo' ? 'Store product details. Illustrative demo images and sample stock. No live changes.' : 'Inventory is owned by WooCommerce. No separate product database.'}</span><button onClick={setHelp}>Quick guide <ArrowRight size={13} /></button></div>
      </section>
      <div ref={cartPanelRef} className={`cart-panel ${mobileCart ? 'mobile-open' : ''}`} role={mobileCart ? 'dialog' : 'complementary'} aria-modal={mobileCart || undefined} aria-label="Current sale">
        <div className="cart-header"><div><h2>Current sale <span className="count-pill">{count}</span></h2><span className="cart-order-label">New sale · Walk-in</span></div><IconButton icon={X} label="Close cart" className="mobile-only" onClick={() => setMobileCart(false)} /><Badge tone={config.liveReadOnly ? 'amber' : 'green'} dot>{config.liveReadOnly ? 'Read-only' : config.mode === 'demo' ? 'Demo' : config.mode === 'live' ? 'Live' : 'Staging'}</Badge></div>
        <div className="customer-strip"><span className="customer-avatar"><UserRound size={18} /></span><div><strong>Walk-in customer</strong><span>No customer account required</span></div><ShoppingBag size={17} /></div>
        <div className="cart-items" role="region" aria-label="Items in current sale" tabIndex={0}>{!cart.length ? <Empty icon={ShoppingBag} title="A fresh start">Add products to begin a new sale.<br />Search, tap, or scan to get started.</Empty> : cart.map(item => <div className="cart-item" key={item.key}><ProductImage src={item.image} name={item.name} /><div className="cart-item-content">
            <div className="cart-item-title"><h3>{item.name}</h3><button aria-label={`Remove ${item.name}`} onClick={() => setCart(previous => previous.filter(i => i.key !== item.key))}><Trash2 size={14} /></button></div>
            <p>{item.optionLabel || item.label || 'Standard'} <span>· {money(item.price)}</span></p>
            {cartBackorder(item) && <p className="cart-backorder">{cartBackorder(item)}</p>}
            <div className="cart-item-bottom"><div className="quantity-control"><button aria-label={`Decrease ${item.name}`} onClick={() => changeQty(item.key,-1)}><Minus size={13} /></button><span>{item.quantity}</span><button aria-label={`Increase ${item.name}`} onClick={() => changeQty(item.key,1)}><Plus size={13} /></button></div><strong>{money(item.price * item.quantity)}</strong></div>
          </div></div>)}</div>
        <div className="cart-bottom"><div className="cart-details" ref={cartDetailsRef} role="region" aria-label="Sale summary" tabIndex={0}>
          <div className="cart-tools"><button onClick={() => setShowNote(!showNote)}><StickyNote size={15} />{note ? 'Edit note' : 'Add note'}</button><button disabled={!cart.length} onClick={hold}><Pause size={15} />Hold sale</button><button disabled={!cart.length} onClick={() => { if (window.confirm('Clear this unsubmitted sale? No order has been created.')) { setCart([]); setNote(''); } }}><Trash2 size={15} />Clear</button></div>
          {showNote && <textarea className="sale-note" aria-label="Sale note" placeholder="Internal note for this order…" value={note} maxLength={250} onChange={e => setNote(e.target.value)} />}
          <div className="cart-totals"><div><span>Subtotal <small>({count} {count === 1 ? 'item' : 'items'})</small></span><strong>{money(total)}</strong></div><div><span>Tax</span><span className="muted">{config.mode === 'demo' ? 'Not applied in demo' : 'Calculated by WooCommerce'}</span></div><div className="grand-total"><span>Total</span><strong key={total}>{money(total)}</strong></div></div>
          {config.mode !== 'demo' && <p className="total-disclaimer">{config.liveReadOnly?'Reference amount only. Tax and the final total have not been checked by WooCommerce.':'Estimated total. WooCommerce confirms the final amount before payment.'}</p>}
          {error && <Notice tone="error">{error}</Notice>}
          {config.mode !== 'demo' && !config.writesEnabled && <Notice tone="warning">{config.liveReadOnly?'This read-only catalogue cannot take payments or create orders; trading requires a separate reviewed deployment.':'Checkout is locked until the owner approves this environment.'}</Notice>}
          </div><div className="cart-checkout"><button className="charge-button" onClick={checkout} disabled={checkoutDisabled}><span>{busy ? 'Preparing order…' : config.liveReadOnly ? 'Checkout locked' : 'Prepare order'}<ArrowRight size={19} /></span><strong>{money(total)}</strong></button><div className="cart-secure"><ShieldCheck size={13} />{config.mode === 'demo' ? 'Demo checkout · No real payments' : config.liveReadOnly ? 'Live catalogue only · No POS payments' : 'Payments collected outside this app'}</div></div>
        </div>
      </div>
    </div>
    <button className="mobile-cart-bar" inert={mobileCart} onClick={() => setMobileCart(true)}><ShoppingBag size={19} /><span>View sale · {count} items</span><strong>{money(total)}</strong></button>
    {variantProduct && <Modal title={sizesOnly(variantProduct) ? 'Choose a size' : 'Choose an option'} subtitle="Availability is shown for each option." onClose={() => setVariantProduct(null)} className="variant-modal"><div className="variant-product"><ProductImage src={variantProduct.image} name={variantProduct.name} /><div><span className="eyebrow">{variantProduct.category}</span><h3>{variantProduct.name}</h3><strong>{money(selectedVariant?.price ?? variantProduct.price)}</strong></div></div><div className="modal-body"><div className="field-label" id="variant-option-label">{sizesOnly(variantProduct) ? 'Size' : 'Option'}</div><div className="size-options" role="group" aria-labelledby="variant-option-label">{variantProduct.variations.map(v => <button key={v.id} type="button" aria-pressed={selectedVariant?.id === v.id} disabled={!available(v, requireStockSource)} className={selectedVariant?.id === v.id ? 'selected' : ''} onClick={() => { setSelectedVariant(v); setVariantQty(1); }}><strong>{v.label}</strong><span>{optionStockText(v, requireStockSource)}</span>{selectedVariant?.id === v.id && <Check size={15} />}</button>)}</div><div className="variant-quantity"><span>Quantity</span><div className="quantity-control"><button aria-label="Decrease quantity" disabled={variantQty <= 1} onClick={() => setVariantQty(q => q - 1)}><Minus size={15} /></button><span>{variantQty}</span><button aria-label="Increase quantity" disabled={selectedVariant?.manageStock && hasKnownStock(selectedVariant) && !allowsBackorders(selectedVariant) && variantQty >= selectedVariant.stock} onClick={() => setVariantQty(q => q + 1)}><Plus size={15} /></button></div></div>{config.mode === 'demo' && <p className="field-hint">Availability shown here is demo data, not live store stock.</p>}</div><div className="modal-footer" role="group" aria-label="Dialog actions"><button className="button secondary" onClick={() => setVariantProduct(null)}>Cancel</button><button className="button primary" disabled={!selectedVariant} onClick={() => { if (addLine(variantProduct,selectedVariant,variantQty)) setVariantProduct(null); }}><Plus size={17} />Add to sale · {money((selectedVariant?.price ?? variantProduct.price) * variantQty)}</button></div></Modal>}
    {scanner && <Modal title="Scan a product" subtitle="Use a USB/Bluetooth keyboard scanner or type a SKU." onClose={() => { setScanner(false); setScanValue(''); }}><form onSubmit={e => { e.preventDefault(); scan(scanValue); }}><div className="modal-body"><div className="scanner-illustration"><ScanLine size={46} strokeWidth={1.2} /><span>Ready for your scanner</span></div><label className="field-label" htmlFor="scan-input">Barcode or SKU</label><input id="scan-input" className="input" autoFocus value={scanValue} onChange={e => setScanValue(e.target.value)} placeholder="Scan or enter an exact code" autoComplete="off" /><p className="field-hint">A matching option is added directly. A parent product opens the option picker.</p>{scanExample && <Notice>Try <button type="button" className="text-button" onClick={() => setScanValue(scanExample.line.barcode)}>{scanExample.line.barcode}</button> — a demo-only alias for {scanExample.product.name}{scanExample.line.label ? ` · ${scanExample.line.label}` : ''}. It is not a real product barcode.</Notice>}</div><div className="modal-footer" role="group" aria-label="Dialog actions"><button type="button" className="button secondary" onClick={() => setScanner(false)}>Cancel</button><button className="button primary" disabled={!scanValue.trim()}><Search size={17} />Find product</button></div></form></Modal>}
    {heldOpen && <Modal title="Held sales" subtitle="Saved on this browser only. No order or stock change yet." onClose={() => setHeldOpen(false)}><div className="modal-body">{!savedCarts.length ? <Empty icon={Pause} title="No held sales">Use “Hold sale” to pause a cart and serve the next customer.</Empty> : savedCarts.map((held,i) => <div className="held-sale" key={held.id}><div><strong>Sale {i + 1}</strong><p>{held.cart.reduce((n,c) => n + c.quantity,0)} items · {money(held.cart.reduce((n,c) => n + c.price*c.quantity,0))}</p><small>{new Date(held.created).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</small></div><button className="button primary small" onClick={() => { if (cart.length && !window.confirm('Replace the current cart? The current cart is not held.')) return; const next = cart.length ? [...savedCarts.filter(h => h.id !== held.id), {id:uuid(),cart,note,created:new Date().toISOString()}] : savedCarts.filter(h => h.id !== held.id); setSavedCarts(next); setCart(held.cart); setNote(held.note); setHeldOpen(false); refresh(); }}><Play size={14} />Resume</button><IconButton icon={Trash2} label="Discard held sale" onClick={() => { if (window.confirm('Discard this held cart?')) setSavedCarts(previous => previous.filter(h => h.id !== held.id)); }} /></div>)}</div></Modal>}
  </div>;
}
