import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveX, Banknote, CheckCircle2, Download, Minus, Package, Plus, Printer, ReceiptText, RefreshCw, Search, ShieldCheck, Store } from 'lucide-react';
import { api, authHeaders, dateTime, money, uuid } from './api.js';
import { Badge, Empty, Modal, Notice, PageHeading, Spinner, Stat } from './components.jsx';
import './instore.css';

const statusLabels = { available: 'In stock', out_of_stock: 'No stock', review: 'Owner review required' };
const statusTones = { available: 'green', out_of_stock: 'neutral', review: 'amber' };
const toCents = value => {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(value || '').trim());
  return match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : null;
};
const pendingStorageKey = userId => `mansu-instore-cash-attempt-${userId}`;
function readPending(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
}

function InStoreReceipt({ sale, config, onClose }) {
  const [width, setWidth] = useState(config.receiptWidth || '80');
  const paper = <div className={`receipt-paper paper-${width}`}>
    <div className="receipt-brand">{(config.businessName || 'MansutRENDZGH').toUpperCase()}<span>PHYSICAL STORE · CASH RECEIPT</span></div>
    {(config.businessAddress || config.businessPhone || config.businessTaxId) && <div className="receipt-business">
      {config.businessAddress && <span>{config.businessAddress}</span>}
      {config.businessPhone && <span>Tel: {config.businessPhone}</span>}
      {config.businessTaxId && <span>Tax ID: {config.businessTaxId}</span>}
    </div>}
    <div className="receipt-rule" />
    <div className="receipt-meta"><span>Receipt</span><strong>{sale.number}</strong><span>Date</span><strong>{dateTime(sale.paidAt)}</strong><span>Cashier</span><strong>{sale.cashierName}</strong><span>Drawer shift</span><strong>{sale.shiftId}</strong></div>
    <div className="receipt-rule" />
    {sale.items.map(item => <div key={item.sku} className="receipt-item"><div><strong>{item.name}</strong><span>SKU {item.sku}</span><small>{item.quantity} × {money(item.price)} final unit price</small></div><strong>{money(item.total)}</strong></div>)}
    <div className="receipt-rule" />
    <div className="receipt-meta"><span className="receipt-total">Total · all-in GHS</span><strong className="receipt-total">{money(sale.total)}</strong><span>Cash received</span><strong>{money(sale.tendered)}</strong><span>Change</span><strong>{money(sale.changeDue)}</strong></div>
    <div className="receipt-rule" /><p className="receipt-footer">{config.receiptFooter}</p><p className="receipt-payment-note">Cash payment recorded at the physical store.</p>
  </div>;
  return <>{createPortal(<div id="print-root" aria-hidden="true">{paper}</div>, document.body)}
    <Modal title="In-store cash receipt" subtitle={`${sale.number} · paid ${dateTime(sale.paidAt)}`} onClose={onClose} className="receipt-dialog">
      <div className="modal-body receipt-body"><div className="receipt-success"><span><CheckCircle2 size={28}/></span><div><h3>Cash sale recorded</h3><p>Only the in-store POS balance was reduced. Online stock is unchanged.</p></div></div>
        <div className="receipt-controls"><label htmlFor="instore-paper-width">Paper width</label><select id="instore-paper-width" value={width} onChange={e => setWidth(e.target.value)}><option value="80">80 mm thermal</option><option value="58">58 mm thermal</option><option value="a4">A4 / standard printer</option></select></div>
        {paper}<p className="field-hint center">Check printer alignment on the actual device before accepting live sales.</p></div>
      <div className="modal-footer" role="group" aria-label="Receipt actions"><button className="button secondary" onClick={onClose}>Done</button><button className="button primary" onClick={() => window.print()}><Printer size={17}/>Print receipt</button></div>
    </Modal></>;
}

export default function InStore({ config, user, shift, onOpenShift, notify }) {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const [status, setStatus] = useState('all');
  const [visible, setVisible] = useState(48);
  const [tab, setTab] = useState('collection');
  const [cart, setCart] = useState({});
  const [tendered, setTendered] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saleError, setSaleError] = useState('');
  const key = pendingStorageKey(user.id);
  const [pending, setPending] = useState(() => readPending(key));
  const [verifiedMissing, setVerifiedMissing] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyCursor, setHistoryCursor] = useState(null);
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [days, setDays] = useState(7);
  const [reports, setReports] = useState(null);
  const [reportError, setReportError] = useState('');
  const [reportRefresh, setReportRefresh] = useState(0);
  const [counting, setCounting] = useState(null);
  const [countBusy, setCountBusy] = useState(false);
  const [countProblem, setCountProblem] = useState('');
  const [stockHistory, setStockHistory] = useState(null);
  const [stockHistoryBusy, setStockHistoryBusy] = useState(false);
  const [stockHistoryError, setStockHistoryError] = useState('');
  const stockHistoryRequest = useRef(0);

  const reloadCatalog = useCallback(async () => {
    setLoading(true);
    try { setCatalog(await api('/instore/catalog')); setError(''); }
    catch (problem) { setError(problem.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { reloadCatalog(); }, [reloadCatalog]);
  const loadHistory = useCallback(async (before = null) => {
    setHistoryBusy(true);
    try {
      const response = await api(`/instore/sales?limit=50${before ? `&before=${before}` : ''}`);
      setHistory(previous => before ? [...previous, ...response.sales] : response.sales);
      setHistoryCursor(response.nextCursor);
      setHistoryError('');
    } catch (problem) { setHistoryError(problem.message); }
    finally { setHistoryBusy(false); }
  }, []);
  useEffect(() => { if (tab === 'sales') loadHistory(); }, [tab, loadHistory]);
  useEffect(() => {
    if (tab !== 'reports' || user.role === 'cashier') return;
    let active = true;
    setReports(null); setReportError('');
    api(`/instore/reports?days=${days}`).then(data => { if (active) setReports(data); })
      .catch(problem => { if (active) setReportError(problem.message); });
    return () => { active = false; };
  }, [tab, days, user.role, reportRefresh]);

  const groups = useMemo(() => [...new Set((catalog?.items || []).map(item => item.group))].sort((a, b) => a.localeCompare(b)), [catalog]);
  const filtered = useMemo(() => (catalog?.items || []).filter(item =>
    (group === 'all' || item.group === group) && (status === 'all' || item.status === status) &&
    `${item.name} ${item.sku} ${item.barcode} ${item.group}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  [catalog, group, query, status]);
  const cartItems = useMemo(() => (catalog?.items || []).filter(item => cart[item.sku] > 0), [catalog, cart]);
  const total = cartItems.reduce((sum, item) => sum + item.priceCents * cart[item.sku], 0);
  const cashCents = toCents(tendered);
  const change = cashCents == null ? 0 : Math.max(0, cashCents - total);
  const canSell = !config.liveReadOnly && config.inStoreCashEnabled && catalog?.summary.salesEnabled && !error;
  const canRecord = canSell && shift && !busy && !pending && cartItems.length > 0 &&
    cartItems.every(item => item.status === 'available' && item.stock >= cart[item.sku]) &&
    Number.isSafeInteger(total) && total > 0 && cashCents != null && cashCents >= total && confirmed;
  const filterChange = (setter, value) => { setter(value); setVisible(48); };
  const adjustCart = (item, delta) => {
    if (!canSell || !shift || pending || item.status !== 'available') return;
    setCart(previous => {
      const next = Math.max(0, Math.min(item.stock, (previous[item.sku] || 0) + delta, 999));
      return { ...previous, [item.sku]: next };
    });
    setConfirmed(false);
  };

  const finishSale = sale => {
    sessionStorage.removeItem(key);
    setPending(null); setVerifiedMissing(false); setBusy(false); setSaleError('');
    setCart({}); setTendered(''); setNote(''); setConfirmed(false);
    setReceipt(sale); setReportRefresh(value => value + 1);
    reloadCatalog();
    notify('In-store cash sale recorded. POS-only stock deducted; receipt is ready.');
  };
  async function submitAttempt(attempt) {
    setBusy(true); setSaleError(''); setVerifiedMissing(false);
    try { const response = await api('/instore/sales', { method: 'POST', body: attempt }); finishSale(response.sale); }
    catch (problem) { setSaleError(`${problem.message} Check this attempt before starting another sale; never take cash twice.`); }
    finally { setBusy(false); }
  }
  function startSale() {
    if (!canRecord) return;
    const attempt = { idempotencyKey: uuid(), items: cartItems.map(item => ({ sku: item.sku, quantity: cart[item.sku] })),
      expectedTotal: total, tendered: cashCents, confirmed: true, note: note.trim() };
    // Persist BEFORE sending. A lost response or refresh must retry the SAME key.
    sessionStorage.setItem(key, JSON.stringify(attempt));
    setPending(attempt);
    submitAttempt(attempt);
  }
  async function recover() {
    if (!pending) return;
    setBusy(true); setSaleError('');
    try {
      const result = await api(`/instore/sales/by-key/${pending.idempotencyKey}`);
      finishSale(result.sale);
    } catch (problem) {
      setVerifiedMissing(problem.status === 404);
      setSaleError(problem.status === 404
        ? 'No receipt exists for this attempt yet. If cash was taken, keep it safe and ask the owner before discarding the attempt. You may retry the SAME key without collecting cash again.'
        : `Could not check the receipt: ${problem.message} Do not start another sale.`);
    } finally { setBusy(false); }
  }
  function discard() {
    if (!verifiedMissing || !window.confirm('Only discard after confirming there is no receipt and any cash received has been returned or handled by the owner. Discard this attempt?')) return;
    sessionStorage.removeItem(key);
    setPending(null); setVerifiedMissing(false); setSaleError(''); setConfirmed(false);
    reloadCatalog();
  }
  async function recordCount(event) {
    event.preventDefault();
    if (!counting || countBusy) return;
    const payload = counting.attempt || { idempotencyKey: uuid(), expectedQuantity: counting.item.stock,
      countedQuantity: Number(counting.counted), reason: counting.reason.trim() };
    setCounting(previous => ({ ...previous, attempt: payload }));
    setCountBusy(true); setCountProblem('');
    try {
      const result = await api(`/instore/stock/${counting.item.sku}/count`, { method: 'POST', body: payload });
      setCounting(null); await reloadCatalog();
      notify(`SKU ${result.sku} physical count recorded in the POS.`);
    } catch (problem) { setCountProblem(`${problem.message} Check the stock ledger before retrying the SAME count key.`); }
    finally { setCountBusy(false); }
  }
  async function showStockHistory(item, before = null) {
    const request = ++stockHistoryRequest.current;
    if (!before) setStockHistory({ item, movements: [], nextCursor: null, onHand: item.stock, initialQuantity: item.reportedQuantity });
    setStockHistoryBusy(true); setStockHistoryError('');
    try {
      const data = await api(`/instore/stock/${item.sku}/movements?limit=50${before ? `&before=${before}` : ''}`);
      if (request !== stockHistoryRequest.current) return;
      setStockHistory(previous => previous?.item.sku === item.sku ? { item, onHand: data.onHand, initialQuantity: data.initialQuantity,
        movements: before ? [...previous.movements, ...data.movements] : data.movements,
        nextCursor: data.nextCursor } : previous);
    } catch (problem) { if (request === stockHistoryRequest.current) setStockHistoryError(problem.message); }
    finally { if (request === stockHistoryRequest.current) setStockHistoryBusy(false); }
  }
  function closeStockHistory() {
    stockHistoryRequest.current++;
    setStockHistory(null); setStockHistoryError(''); setStockHistoryBusy(false);
  }
  async function exportReport() {
    try {
      const response = await fetch(`/api/instore/reports/export?days=${days}`, { credentials: 'same-origin', headers: authHeaders() });
      if (!response.ok) throw new Error('In-store CSV export failed. Sign in again or ask the owner.');
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = objectUrl; link.download = 'mansu-pos-instore-cash.csv'; link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      notify('Separate in-store cash report downloaded.');
    } catch (problem) { notify(problem.message, 'error'); }
  }

  return <section className="instore-page" aria-label="In-store collection">
    <PageHeading eyebrow="Physical shop · independent stock" title="In-store collection" description="Goods held at the physical shop, separate from the online WooCommerce catalogue." />
    <div className="instore-context"><Store size={20} aria-hidden="true"/><span>POS-only cash and stock. This collection never creates a WooCommerce order, changes website stock or contacts Paystack.</span></div>
    <div className="instore-tabs" role="group" aria-label="In-store sections">
      <button className={tab === 'collection' ? 'selected' : ''} aria-pressed={tab === 'collection'} onClick={() => setTab('collection')}><Package size={16}/>Collection</button>
      <button className={tab === 'sales' ? 'selected' : ''} aria-pressed={tab === 'sales'} onClick={() => setTab('sales')}><ReceiptText size={16}/>Cash receipts</button>
      {user.role !== 'cashier' && <button className={tab === 'reports' ? 'selected' : ''} aria-pressed={tab === 'reports'} onClick={() => setTab('reports')}><Banknote size={16}/>Cash reports</button>}
    </div>

    {tab === 'collection' && <>
      {(!config.inStoreCashEnabled || config.liveReadOnly) && <Notice tone="warning"><strong>Catalogue only — in-store checkout locked.</strong> No cash sale or stock deduction can be recorded in this workspace. Do not collect money or release goods using this POS.</Notice>}
      {canSell && !shift && <Notice tone="warning"><strong>Open a shift before taking cash.</strong> Sales require a counted POS drawer. <button className="text-button" onClick={onOpenShift}>Open shift</button></Notice>}
      {canSell && shift && <Notice tone="success"><strong>Cash-only register active</strong> for the physical-store stock pool. Confirm stock and final GHS total, count cash, then record the sale once. Retail/Wholesale WooCommerce checkout is separate.</Notice>}
      {pending && <Notice tone="error"><strong>An in-store cash attempt needs review.</strong> Receipt status is uncertain until checked; do not collect the cash again or start another sale.
        <div className="instore-recover-actions"><button className="button secondary small" onClick={recover} disabled={busy}>{busy ? 'Checking…' : 'Check saved attempt'}</button>{canSell && <button className="button secondary small" onClick={() => submitAttempt(pending)} disabled={busy}>Retry same attempt</button>}{verifiedMissing && <button className="button secondary small" onClick={discard} disabled={busy}>Discard after cash review</button>}</div>
        {saleError && <p className="instore-error-detail">{saleError}</p>}</Notice>}
      {!pending && saleError && <Notice tone="error">{saleError}</Notice>}
      {error && <Notice tone="error">{error} Online stock and checkout are unaffected. Do not use a previous balance as the current count.</Notice>}
      {loading && !catalog && <Spinner label="Loading the in-store stock report…" />}
      {catalog && <>
        <div className="stats-grid four instore-stats">
          <Stat label="Listed goods" value={catalog.summary.items} detail="Client product export" />
          <Stat label="In stock" value={catalog.summary.available} detail={catalog.summary.importedAt ? 'POS balances' : 'PDF snapshot · no checkout'} />
          <Stat label="No stock" value={catalog.summary.outOfStock} detail="Unavailable for sale" />
          <Stat label="Needs owner review" value={catalog.summary.needsReview} detail="Quarantined from checkout" />
        </div>
        <div className="instore-source surface"><ShieldCheck size={19} aria-hidden="true"/><p><strong>Source:</strong> {catalog.summary.source} · final client-reported GHS unit prices. {catalog.summary.importedAt ? `Imported into the POS ledger ${dateTime(catalog.summary.importedAt)}. Balances include POS sales and owner counts.` : 'Quantities are a read-only source snapshot, not a live POS balance.'} No usable tax rate is supplied, so cash receipts show gross totals only. Most goods have no barcode; search by name or SKU.</p><button className="button secondary small" onClick={reloadCatalog} disabled={loading} aria-label="Refresh in-store balances"><RefreshCw size={15}/>Refresh</button></div>
        <div className={canSell ? 'instore-workspace' : 'instore-readonly'}>
          <div className="surface instore-list">
            <div className="instore-toolbar">
              <label className="search-field compact"><Search size={18} aria-hidden="true"/><input aria-label="Search in-store goods" placeholder="Search name, SKU or group…" value={query} onChange={event => filterChange(setQuery, event.target.value)} /></label>
              <label><span className="sr-only">In-store product group</span><select className="select" aria-label="In-store product group" value={group} onChange={event => filterChange(setGroup, event.target.value)}><option value="all">All groups</option>{groups.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
              <label><span className="sr-only">In-store stock filter</span><select className="select" aria-label="In-store stock filter" value={status} onChange={event => filterChange(setStatus, event.target.value)}><option value="all">All statuses</option><option value="available">In stock</option><option value="out_of_stock">No stock</option><option value="review">Needs review</option></select></label>
            </div>
            <div className="instore-results" aria-live="polite">Showing {Math.min(visible, filtered.length)} of {filtered.length} matching items</div>
            {!filtered.length ? <Empty icon={ArchiveX} title="No matching in-store items">Try another name, SKU, group or status.</Empty> :
              <div className="instore-rows" role="list" aria-label="In-store goods">{filtered.slice(0, visible).map(item => <div role="listitem" className="instore-row" key={item.key}>
                <div className="instore-item-icon"><Package size={21} aria-hidden="true"/></div>
                <div className="instore-details"><strong>{item.name || 'Unnamed item'}</strong><small>{item.group} · {item.sku ? `SKU ${item.sku}` : 'No SKU'}{item.barcode ? ` · Barcode ${item.barcode}` : ''}</small>{item.reviewReasons.length > 0 && <small className="instore-review-reason">{item.reviewReasons.join(' ')}</small>}</div>
                <div className="instore-price"><span>Final unit price</span><strong>{item.priceCents == null ? 'Check price' : money(item.priceCents)}</strong></div>
                <div className="instore-quantity"><Badge tone={statusTones[item.status]}>{statusLabels[item.status]}</Badge><small>{item.status === 'review' ? item.reportedQuantity == null ? 'PDF quantity unknown · not sellable' : `PDF reports ${item.reportedQuantity} · not sellable` : `${item.stock} ${catalog.summary.importedAt ? 'POS' : 'reported'} ${item.stock === 1 ? 'unit' : 'units'}`}</small></div>
                {item.status !== 'review' && ((canSell && (item.status === 'available' || user.role === 'owner')) || (catalog.summary.importedAt && user.role !== 'cashier')) && <div className="instore-item-actions">{canSell && item.status === 'available' && shift && !pending && <button className="button secondary small" onClick={() => adjustCart(item, 1)} disabled={cart[item.sku] >= item.stock}>Add</button>}{canSell && user.role === 'owner' && item.status !== 'review' && <button className="text-button" onClick={() => { setCounting({ item, counted: String(item.stock), reason: '', attempt: null }); setCountProblem(''); }} disabled={Boolean(pending)}>Record count</button>}{catalog.summary.importedAt && user.role !== 'cashier' && item.status !== 'review' && <button className="text-button" onClick={() => showStockHistory(item)}>Stock history</button>}</div>}
              </div>)}</div>}
            {visible < filtered.length && <div className="instore-more"><button className="button secondary" onClick={() => setVisible(count => count + 48)}>Show more items</button></div>}
          </div>
          {canSell && <aside className="surface instore-cart" aria-label="In-store cash cart"><div className="section-heading"><div><h2>Cash cart</h2><p>Only physical-store goods · GHS</p></div><Banknote size={20}/></div>
            {!cartItems.length ? <Empty icon={Package} title="Cart is empty">Add eligible goods from the collection after opening a shift.</Empty> : <div className="instore-cart-items">{cartItems.map(item => <div key={item.sku} className="instore-cart-line"><div><strong>{item.name}</strong><small>SKU {item.sku} · {money(item.priceCents)} each</small></div><div className="instore-stepper" role="group" aria-label={`Quantity for ${item.name}`}><button aria-label={`Remove one ${item.name}`} onClick={() => adjustCart(item, -1)} disabled={busy || Boolean(pending)}><Minus size={15}/></button><span>{cart[item.sku]}</span><button aria-label={`Add one ${item.name}`} onClick={() => adjustCart(item, 1)} disabled={busy || Boolean(pending) || cart[item.sku] >= item.stock}><Plus size={15}/></button></div><strong>{money(item.priceCents * cart[item.sku])}</strong></div>)}</div>}
            <div className="instore-cart-total"><span>Final amount · all-in</span><strong>{money(total)}</strong></div>
            <div className="instore-cart-form"><label>Cash received (GH₵)<input className="input" type="text" inputMode="decimal" placeholder={(total / 100).toFixed(2)} value={tendered} onChange={event => { setTendered(event.target.value); setConfirmed(false); }} disabled={busy || Boolean(pending)} /></label><div className="instore-change"><span>Change due</span><strong>{money(change)}</strong></div><label>Sale note (optional)<textarea className="input" maxLength={250} value={note} onChange={event => { setNote(event.target.value); setConfirmed(false); }} disabled={busy || Boolean(pending)} /></label><label className="instore-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy || Boolean(pending)} /><span>I have counted the full cash amount, confirmed the final total and checked the physical goods.</span></label><button className="button primary instore-pay" onClick={startSale} disabled={!canRecord}>{busy ? 'Recording…' : 'Record cash sale & deduct POS stock'}</button><p className="field-hint">This records cash already received; it does not process a payment. Only a confirmed paid receipt deducts this POS stock. Do not collect cash twice if a response is lost.</p></div>
          </aside>}
        </div>
        <Notice><strong>Held out of checkout:</strong> negative counts, missing or malformed units, missing SKU, and three prices with fractional pesewas. Owner review is needed before any corrected source is imported; a physical count cannot unlock these items.</Notice>
      </>}
    </>}

    {tab === 'sales' && <section className="surface instore-history"><div className="section-heading"><div><h2>In-store cash receipts</h2><p>POS-only payments. Website orders and Wholesale are not shown here.</p></div><button className="button secondary small" onClick={() => loadHistory()} disabled={historyBusy}><RefreshCw size={15}/>Refresh</button></div>{historyError && <Notice tone="error">{historyError}</Notice>}{historyBusy && !history.length && <Spinner label="Loading in-store receipts…"/>}
      {!historyBusy && !history.length && !historyError && <Empty icon={ReceiptText} title="No in-store cash receipts">Sales appear here only after full cash is recorded in an approved POS trading ledger.</Empty>}
      {history.length > 0 && <><div className="instore-history-rows">{history.map(sale => <div className="instore-history-row" key={sale.id}><div><strong>{sale.number}</strong><small>{dateTime(sale.paidAt)} · {sale.cashierName} · {sale.items.reduce((sum, item) => sum + item.quantity, 0)} units</small></div><Badge tone="green">Paid cash</Badge><strong>{money(sale.total)}</strong><button className="button secondary small" onClick={() => setReceipt(sale)}><ReceiptText size={15}/>Receipt</button></div>)}</div>{historyCursor && <div className="instore-more"><button className="button secondary" onClick={() => loadHistory(historyCursor)} disabled={historyBusy}>{historyBusy ? 'Loading…' : 'Load older receipts'}</button></div>}</>}
    </section>}

    {tab === 'reports' && user.role !== 'cashier' && <><div className="instore-report-actions"><label>Reporting period<select className="select" value={days} onChange={event => setDays(Number(event.target.value))}><option value={1}>Today</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></label><button className="button secondary" onClick={exportReport}><Download size={16}/>Export in-store CSV</button></div>{reportError ? <Notice tone="error">{reportError}</Notice> : !reports ? <Spinner label="Loading separate in-store report…"/> : <><div className="stats-grid four instore-stats"><Stat label="Gross cash collected" value={money(reports.total)} detail="POS-only · no tax breakdown" tone="featured"/><Stat label="Paid cash receipts" value={reports.orders} detail="No online or Wholesale orders"/><Stat label="Units sold" value={reports.units} detail="Only in-store inventory"/><Stat label="Average cash sale" value={money(reports.average)} detail="Per paid receipt"/></div><section className="surface"><div className="section-heading"><div><h2>Daily cash totals</h2><p>Physical-store POS receipts only · Ghana time (UTC)</p></div></div><div className="instore-report-days">{reports.daily.map(day => <div key={day.date}><span>{day.date} · {day.count} {day.count === 1 ? 'receipt' : 'receipts'}</span><strong>{money(day.total)}</strong></div>)}</div></section><section className="surface"><div className="section-heading"><div><h2>Most sold in-store goods</h2><p>Units and final gross amounts, without online sales.</p></div></div>{!reports.topProducts.length ? <Empty icon={Package} title="No paid in-store sales">Cash sales will appear after a reviewed rollout.</Empty> : <div className="instore-report-days">{reports.topProducts.map(item => <div key={item.sku}><span>{item.name} · SKU {item.sku} · {item.quantity} units</span><strong>{money(item.total)}</strong></div>)}</div>}</section><Notice>{reports.scope} Returns/refunds are not available in this collection; ask the owner to handle corrections before promising a refund.</Notice></>}</>}

    {counting && <Modal title="Record physical stock count" subtitle={`${counting.item.name} · SKU ${counting.item.sku}`} onClose={() => !countBusy && setCounting(null)} busy={countBusy}><form onSubmit={recordCount}><div className="modal-body form-stack"><Notice tone="warning">This changes only the POS balance for an identified, eligible item. It cannot clear quarantined goods or change online stock. Record the actual shelf count and a reason.</Notice><label>Current POS units<input className="input" readOnly value={counting.item.stock} /></label><label>Counted units<input className="input" type="number" required min="0" max="1000000" step="1" value={counting.counted} onChange={event => setCounting(previous => ({ ...previous, counted: event.target.value }))} disabled={Boolean(counting.attempt) || countBusy} /></label><label>Reason for correction<input className="input" required minLength={5} maxLength={250} value={counting.reason} onChange={event => setCounting(previous => ({ ...previous, reason: event.target.value }))} disabled={Boolean(counting.attempt) || countBusy} placeholder="Physical recount or received delivery" /></label>{countProblem && <Notice tone="error">{countProblem}</Notice>}</div><div className="modal-footer" role="group" aria-label="Stock count actions"><button className="button secondary" type="button" onClick={() => setCounting(null)} disabled={countBusy}>Close</button><button className="button primary" disabled={countBusy || !counting.reason.trim() || counting.counted === '' || Number(counting.counted) === counting.item.stock}>{countBusy ? 'Recording…' : counting.attempt ? 'Retry same count' : 'Save counted units'}</button></div></form></Modal>}
    {stockHistory && <Modal title="In-store stock history" subtitle={`${stockHistory.item.name} · SKU ${stockHistory.item.sku}`} onClose={closeStockHistory} wide><div className="modal-body"><Notice><strong>POS balance: {stockHistory.onHand} units.</strong> Original eligible report quantity: {stockHistory.initialQuantity}. Sales and owner counts affect only this in-store ledger.</Notice>{stockHistoryError && <Notice tone="error">{stockHistoryError}</Notice>}{stockHistoryBusy && !stockHistory.movements.length && <Spinner label="Loading stock movements…"/>}{!stockHistoryBusy && !stockHistory.movements.length && !stockHistoryError && <p className="muted">No movements for this zero-quantity source row yet.</p>}<div className="instore-movement-list">{stockHistory.movements.map(entry => <div key={entry.id}><span>{dateTime(entry.occurredAt)} · {entry.kind === 'import' ? 'Verified source import' : entry.kind === 'sale' ? `Cash sale ${entry.receiptNumber}` : 'Owner physical count'}{entry.reason && <small>{entry.reason}</small>}</span><strong>{entry.delta > 0 ? '+' : ''}{entry.delta} · {entry.balanceAfter} left</strong></div>)}</div>{stockHistory.nextCursor && <button className="button secondary" onClick={() => showStockHistory(stockHistory.item, stockHistory.nextCursor)} disabled={stockHistoryBusy}>{stockHistoryBusy ? 'Loading…' : 'Load older movements'}</button>}</div><div className="modal-footer" role="group" aria-label="Stock history actions"><button className="button primary" onClick={closeStockHistory}>Close history</button></div></Modal>}
    {receipt && <InStoreReceipt sale={receipt} config={config} onClose={() => setReceipt(null)} />}
  </section>;
}
