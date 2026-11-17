import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, Download, PackagePlus, PackageMinus, ClipboardCheck, History, Tag, Boxes, Globe, Store, LockKeyhole } from 'lucide-react';
import { api, money, dateTime, authHeaders, uuid } from './api.js';
import { PageHeading, Stat, Empty, Badge, ProductImage, Modal, Notice, Spinner, TableRegion } from './components.jsx';
import './stock-control.css';

const STATUS = {
  ok: { label: 'In stock', tone: 'green' }, low: { label: 'Low stock', tone: 'amber' }, out: { label: 'Out of stock', tone: 'red' },
  untracked: { label: 'Not tracked', tone: 'neutral' }, unknown: { label: 'Needs review', tone: 'neutral' },
};
const TYPE_COPY = {
  receive: { title: 'Receive stock', verb: 'Add', icon: PackagePlus, help: 'Goods that arrived or came back. The units are added to the shared website + shop quantity.' },
  remove: { title: 'Remove stock', verb: 'Remove', icon: PackageMinus, help: 'Goods that left without a sale (damaged, lost, given out). The units are taken off the shared quantity.' },
  count: { title: 'Set counted quantity', verb: 'Set to', icon: ClipboardCheck, help: 'Replace the quantity with what is physically on the shelf. Use this after counting.' },
};
const pesewas = value => { const text = String(value ?? '').trim(); return /^\d{1,7}(\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null; };

export default function StockControl({ user, notify, refreshCatalog }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('levels');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [category, setCategory] = useState('all');
  const [editor, setEditor] = useState(null);
  const [priceEditor, setPriceEditor] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try { const next = await api(`/inventory${refresh ? '?refresh=1' : ''}`); setData(next); setError(''); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const afterChange = useCallback(async () => { await load(true); refreshCatalog?.(true); }, [load, refreshCatalog]);

  const categories = useMemo(() => [...new Set((data?.lines || []).map(l => l.category))].sort(), [data]);
  const visible = useMemo(() => (data?.lines || []).filter(line =>
    (filter === 'all' || line.status === filter || (filter === 'attention' && ['low', 'out'].includes(line.status)) || (filter === 'nosku' && !line.sku)) &&
    (category === 'all' || line.category === category) &&
    `${line.name} ${line.label} ${line.sku}`.toLowerCase().includes(query.trim().toLowerCase())), [data, filter, category, query]);

  async function exportCsv() {
    try {
      const response = await fetch('/api/inventory/export', { credentials: 'same-origin', headers: authHeaders() });
      if (!response.ok) throw new Error('Export failed. Please sign in again.');
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a'); a.href = url; a.download = `mansu-stock-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('Stock list downloaded.');
    } catch (e) { notify(e.message, 'error'); }
  }

  const writes = data?.writes;
  const canWrite = Boolean(writes?.enabled) && !data?.stale && !data?.error;
  const summary = data?.summary;
  return <div className="stock-control">
    <PageHeading eyebrow="Catalogue / shared stock" title="Stock control" description="One stock count for the website and the shop. Receive deliveries, write off damage, count shelves and update prices — every change goes straight to WooCommerce.">
      <button className="button secondary" onClick={exportCsv} disabled={!data}><Download size={16} />Export CSV</button>
      <button className="button secondary" onClick={() => load(true)} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} />Refresh</button>
    </PageHeading>
    <div className="stock-sync-strip" aria-label="How stock is shared">
      <span><Globe size={16} />Website orders</span><span className="stock-sync-arrow" aria-hidden="true">→</span>
      <strong><Boxes size={16} />WooCommerce stock</strong><span className="stock-sync-arrow" aria-hidden="true">←</span>
      <span><Store size={16} />POS sales &amp; stock changes</span>
    </div>
    {error && <Notice tone="error">{error} <button className="text-button" onClick={() => load(true)}>Try again</button></Notice>}
    {!data && !error ? <Spinner label="Loading stock…" /> : data && <>
      {writes && !writes.enabled && <Notice tone="warning" icon={LockKeyhole}><strong>View only.</strong> {writes.reason}</Notice>}
      {writes?.demo && <Notice>{writes.reason}</Notice>}
      {data.stale && <Notice tone="warning">Showing saved stock because WooCommerce could not be reached. Changes are disabled until a refresh succeeds.</Notice>}
      {!data.complete && <Notice tone="warning">The WooCommerce catalogue did not load completely. Totals cover the loaded products only.</Notice>}
      <div className="stats-grid four">
        <Stat label="Units on hand" value={summary.unitsOnHand.toLocaleString()} detail={`${summary.stockLines} stock lines · ${summary.products} products`} />
        <Stat label="Stock value (retail)" value={money(summary.retailValue)} detail="Tracked units × current price" tone="featured" />
        <Stat label="Low or out of stock" value={summary.low + summary.out} detail={`${summary.out} out · ${summary.low} at or below ${summary.threshold}`} tone="warm" />
        <Stat label="Not tracked" value={summary.untracked + summary.unknown} detail="Woo does not count these — set a count to start" />
      </div>
      <div className="stock-tabs" role="tablist" aria-label="Stock control sections">
        {[['levels', 'Stock levels', Boxes], ['count', 'Stock count', ClipboardCheck], ['history', 'Movement history', History]].map(([id, label, Icon]) =>
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}
      </div>
      {tab !== 'history' && <div className="surface stock-filters">
        <label className="search-field compact"><Search size={18} aria-hidden="true" /><input aria-label="Search stock" placeholder="Product, option or SKU…" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <select className="select" aria-label="Filter by stock status" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">All stock ({data.lines.length})</option>
          <option value="attention">Needs reorder ({summary.low + summary.out})</option>
          <option value="out">Out of stock ({summary.out})</option>
          <option value="low">Low stock ({summary.low})</option>
          <option value="untracked">Not tracked ({summary.untracked})</option>
          <option value="nosku">Missing SKU ({summary.missingSku})</option>
        </select>
        <select className="select" aria-label="Filter by category" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="all">All categories</option>{categories.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>}
      {tab === 'levels' && <StockLevels lines={visible} total={data.lines.length} canWrite={canWrite} canPrice={canWrite && writes.priceEditing && user.role === 'owner'}
        onAdjust={(line, type) => setEditor({ line, type })} onPrice={line => setPriceEditor(line)} onHistory={line => setHistoryFor(line)} clear={() => { setQuery(''); setFilter('all'); setCategory('all'); }} />}
      {tab === 'count' && <StockCount lines={visible} canWrite={canWrite} notify={notify} onDone={afterChange} />}
      {tab === 'history' && <MovementHistory key="all" notify={notify} />}
    </>}
    {editor && <AdjustModal {...editor} reasons={data.reasons} labels={data.reasonLabels} onClose={() => setEditor(null)} notify={notify} onDone={afterChange} />}
    {priceEditor && <PriceModal line={priceEditor} onClose={() => setPriceEditor(null)} notify={notify} onDone={afterChange} />}
    {historyFor && <Modal title="Stock history" subtitle={`${historyFor.name} · ${historyFor.label}`} wide onClose={() => setHistoryFor(null)}>
      <div className="modal-body"><MovementHistory line={historyFor} notify={notify} compact /></div>
      <div className="modal-footer"><button className="button primary" onClick={() => setHistoryFor(null)}>Close</button></div>
    </Modal>}
  </div>;
}

function StockLevels({ lines, total, canWrite, canPrice, onAdjust, onPrice, onHistory, clear }) {
  if (!lines.length) return <section className="surface"><Empty icon={Boxes} title={total ? 'No matching stock' : 'No stock lines yet'} action={total ? <button className="button secondary" onClick={clear}>Clear filters</button> : null}>{total ? 'Try another search, status or category.' : 'Refresh to load products from WooCommerce.'}</Empty></section>;
  return <section className="surface records-surface">
    <TableRegion label="Stock levels"><table className="responsive-table stock-table"><thead><tr>
      <th>Product</th><th>Option</th><th>SKU</th><th className="right">Price</th><th className="right">In stock</th><th>Status</th><th className="right">POS sold · 30 d</th><th className="right">Actions</th>
    </tr></thead><tbody>{lines.map(line => {
      const state = STATUS[line.status];
      return <tr key={line.key}>
        <td data-label="Product"><div className="table-product"><ProductImage src={line.image} name={line.name} /><div><strong className="table-primary">{line.name}</strong><small>{line.category}</small></div></div></td>
        <td data-label="Option">{line.label}</td>
        <td data-label="SKU"><span className="sku-cell">{line.sku || '—'}</span></td>
        <td data-label="Price" className="right tabular">{money(line.price)}</td>
        <td data-label="In stock" className="right"><strong className="stock-qty">{line.manageStock && line.stock != null ? line.stock : '—'}</strong></td>
        <td data-label="Status"><Badge dot tone={state.tone}>{state.label}</Badge>{line.daysOfCover != null && line.manageStock && <small className="stock-cover">≈ {line.daysOfCover} days left</small>}</td>
        <td data-label="POS sold · 30 d" className="right tabular">{line.posSold30}</td>
        <td data-label="Actions"><div className="row-actions stock-actions">
          {line.manageStock ? <>
            <button className="button secondary small" disabled={!canWrite} onClick={() => onAdjust(line, 'receive')}><PackagePlus size={14} />Receive</button>
            <button className="button secondary small" disabled={!canWrite || !(line.stock > 0)} onClick={() => onAdjust(line, 'remove')}><PackageMinus size={14} />Remove</button>
            <button className="button secondary small" disabled={!canWrite} onClick={() => onAdjust(line, 'count')}><ClipboardCheck size={14} />Count</button>
          </> : <button className="button secondary small" disabled={!canWrite || line.status === 'unknown'} onClick={() => onAdjust(line, 'count')}><ClipboardCheck size={14} />Start tracking</button>}
          {canPrice && line.priceEditable && <button className="button secondary small" onClick={() => onPrice(line)}><Tag size={14} />Price</button>}
          <button className="text-button" onClick={() => onHistory(line)}>History</button>
        </div></td>
      </tr>;
    })}</tbody></table></TableRegion>
    <div className="table-footer"><span>{lines.length} of {total} stock lines</span><span>Options that share one product quantity appear as a single “shared stock” line.</span></div>
  </section>;
}

function AdjustModal({ line, type: initialType, reasons, labels, onClose, notify, onDone }) {
  const [type, setType] = useState(initialType);
  const [quantity, setQuantity] = useState(initialType === 'count' && line.stock != null ? String(line.stock) : '');
  const [reason, setReason] = useState(reasons[initialType][0]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key] = useState(uuid);
  const untracked = !line.manageStock;
  const qty = /^\d{1,7}$/.test(quantity.trim()) ? Number(quantity) : null;
  const current = line.stock ?? 0;
  const result = qty == null ? null : type === 'count' ? qty : type === 'receive' ? current + qty : current - qty;
  const invalid = qty == null || (type !== 'count' && qty < 1) || result < 0;
  function choose(next) { setType(next); setReason(reasons[next][0]); setError(''); if (next === 'count') setQuantity(line.stock != null ? String(line.stock) : ''); else setQuantity(''); }
  async function submit(event) {
    event.preventDefault();
    if (invalid || busy) return;
    setBusy(true); setError('');
    try {
      const res = await api('/inventory/adjust', { method: 'POST', body: { key, productId: line.productId, variationId: line.variationId, type, quantity: qty, reason, note: note.trim(),
        expectedStock: line.manageStock ? line.stock : null, enableTracking: untracked } });
      const m = res.movement;
      notify(m.written === false ? `Count confirmed: ${line.name} still has ${m.after}.` : `${line.name}: stock ${m.before ?? 'untracked'} → ${m.after}. Website and shop updated.`);
      onClose(); onDone();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const copy = TYPE_COPY[type];
  return <Modal title={copy.title} subtitle={`${line.name} · ${line.label}`} onClose={onClose} busy={busy}>
    <form onSubmit={submit}><div className="modal-body form-stack">
      {!untracked && <div className="stock-type-switch" role="group" aria-label="Type of change">
        {Object.entries(TYPE_COPY).map(([id, c]) => <button type="button" key={id} aria-pressed={type === id} className={type === id ? 'selected' : ''} onClick={() => choose(id)} disabled={busy || (id === 'remove' && !(line.stock > 0))}><c.icon size={15} />{c.title.split(' ')[0]}</button>)}
      </div>}
      <p className="field-hint">{untracked ? 'WooCommerce is not counting this item yet. Enter the quantity on hand to start tracking it on the website and in the shop.' : copy.help}</p>
      <div className="stock-preview"><div><span>Now</span><strong>{line.manageStock ? line.stock : '—'}</strong></div><div aria-hidden="true">→</div><div><span>After</span><strong className={result != null && result <= 0 ? 'danger' : ''}>{result ?? '—'}</strong></div></div>
      <label>{type === 'count' ? 'Counted quantity' : `Units to ${type === 'receive' ? 'add' : 'remove'}`}<input className="input" inputMode="numeric" autoFocus required value={quantity} onChange={e => setQuantity(e.target.value.replace(/[^\d]/g, ''))} disabled={busy} /></label>
      {type !== 'count' && <label>Reason<select className="select" value={reason} onChange={e => setReason(e.target.value)} disabled={busy}>{reasons[type].map(r => <option key={r} value={r}>{labels[r]}</option>)}</select></label>}
      <label>Note <span className="muted">(optional)</span><input className="input" maxLength={200} placeholder={type === 'receive' ? 'e.g. supplier invoice number' : 'Short reason for the record'} value={note} onChange={e => setNote(e.target.value)} disabled={busy} /></label>
      {result != null && result < 0 && <Notice tone="error">You cannot remove more than the {current} in stock.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </div><div className="modal-footer" role="group" aria-label="Stock change actions">
      <button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button>
      <button className="button primary" disabled={busy || invalid}>{busy ? 'Saving…' : untracked ? 'Start tracking' : `${copy.verb} ${type === 'count' ? (qty ?? '') : qty ?? ''}`.trim()}</button>
    </div></form>
  </Modal>;
}

function PriceModal({ line, onClose, notify, onDone }) {
  const [regular, setRegular] = useState((line.price / 100).toFixed(2));
  const [sale, setSale] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key] = useState(uuid);
  const regularCents = pesewas(regular);
  const saleCents = sale.trim() === '' ? null : pesewas(sale);
  const invalid = !regularCents || (sale.trim() !== '' && (saleCents == null || saleCents >= regularCents));
  async function submit(event) {
    event.preventDefault();
    if (invalid || busy) return;
    setBusy(true); setError('');
    try {
      await api('/inventory/price', { method: 'POST', body: { key, productId: line.productId, variationId: line.variationId, regularPrice: (regularCents / 100).toFixed(2), salePrice: saleCents == null ? '' : (saleCents / 100).toFixed(2), note: note.trim() } });
      notify(`${line.name}: price updated on the website and in the POS.`);
      onClose(); onDone();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <Modal title="Change retail price" subtitle={`${line.name} · ${line.label}`} onClose={onClose} busy={busy}>
    <form onSubmit={submit}><div className="modal-body form-stack">
      <Notice>The new price shows on the website and at the till straight away. Wholesale prices and past sales are not affected.</Notice>
      <div className="connection-rows"><div><span>Current selling price</span><strong>{money(line.price)}</strong></div></div>
      <label>Regular price (GH₵)<input className="input" inputMode="decimal" required value={regular} onChange={e => setRegular(e.target.value)} disabled={busy} /></label>
      <label>Sale price (GH₵) <span className="muted">(optional, leave blank for none)</span><input className="input" inputMode="decimal" value={sale} onChange={e => setSale(e.target.value)} disabled={busy} /></label>
      <label>Note <span className="muted">(optional)</span><input className="input" maxLength={200} value={note} onChange={e => setNote(e.target.value)} disabled={busy} /></label>
      {sale.trim() !== '' && saleCents != null && regularCents && saleCents >= regularCents && <Notice tone="error">The sale price must be lower than the regular price.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </div><div className="modal-footer" role="group" aria-label="Price actions">
      <button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button>
      <button className="button primary" disabled={busy || invalid}>{busy ? 'Saving…' : 'Save price'}</button>
    </div></form>
  </Modal>;
}

function StockCount({ lines, canWrite, notify, onDone }) {
  const [counts, setCounts] = useState({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [key, setKey] = useState(uuid);
  const countable = lines.filter(l => l.status !== 'unknown');
  const entered = countable.filter(l => /^\d{1,7}$/.test(counts[l.key] ?? ''));
  const differences = entered.filter(l => Number(counts[l.key]) !== (l.manageStock ? l.stock : null));
  async function submit() {
    if (!entered.length || busy) return;
    if (entered.length > 200) { notify('Submit at most 200 lines at a time. Filter by category to split the count.', 'error'); return; }
    if (!window.confirm(`Save ${entered.length} counted ${entered.length === 1 ? 'line' : 'lines'}? ${differences.length} will change the website and shop quantity.`)) return;
    setBusy(true);
    try {
      const res = await api('/inventory/count', { method: 'POST', body: { key, note: note.trim(), lines: entered.map(l => ({ productId: l.productId, variationId: l.variationId,
        counted: Number(counts[l.key]), expectedStock: l.manageStock ? l.stock : null, enableTracking: !l.manageStock })) } });
      setResults(res);
      setCounts(previous => { const next = { ...previous }; res.results.filter(r => r.ok).forEach(r => { delete next[`${r.productId}:${r.variationId}`]; }); return next; });
      setKey(uuid());
      notify(res.failed ? `${res.applied} saved, ${res.failed} need attention.` : `Stock count saved for ${res.applied} ${res.applied === 1 ? 'line' : 'lines'}.`, res.failed ? 'error' : 'success');
      onDone();
    } catch (e) { notify(e.message, 'error'); }
    finally { setBusy(false); }
  }
  const failures = results?.results.filter(r => !r.ok) || [];
  return <section className="surface records-surface">
    <div className="section-heading"><div><h2>Count the shelves</h2><p>Type what you physically count. Leave a line empty to skip it. Only lines that differ change WooCommerce.</p></div>
      <span className="records-count">{entered.length} counted · {differences.length} different</span></div>
    {failures.length > 0 && <div className="stock-count-failures"><Notice tone="warning"><strong>{failures.length} {failures.length === 1 ? 'line was' : 'lines were'} not saved.</strong> Refresh, re-check the shelf and enter them again.<ul>{failures.map(f => { const l = lines.find(x => x.productId === f.productId && x.variationId === f.variationId); return <li key={`${f.productId}:${f.variationId}`}><strong>{l ? `${l.name} · ${l.label}` : `#${f.productId}`}</strong> — {f.error}</li>; })}</ul></Notice></div>}
    {!countable.length ? <Empty icon={ClipboardCheck} title="Nothing to count">Change the search or filters above.</Empty> :
      <TableRegion label="Stock count sheet"><table className="responsive-table stock-table count-table"><thead><tr><th>Product</th><th>Option</th><th>SKU</th><th className="right">System</th><th className="right">Counted</th><th className="right">Difference</th></tr></thead><tbody>
        {countable.map(line => {
          const value = counts[line.key] ?? '';
          const valid = /^\d{1,7}$/.test(value);
          const diff = valid ? Number(value) - (line.manageStock ? line.stock ?? 0 : 0) : null;
          return <tr key={line.key} className={valid && diff !== 0 ? 'count-changed' : ''}>
            <td data-label="Product"><strong className="table-primary">{line.name}</strong></td>
            <td data-label="Option">{line.label}</td>
            <td data-label="SKU"><span className="sku-cell">{line.sku || '—'}</span></td>
            <td data-label="System" className="right tabular">{line.manageStock ? line.stock : 'Not tracked'}</td>
            <td data-label="Counted" className="right"><input className="input count-input" inputMode="numeric" aria-label={`Counted quantity for ${line.name} ${line.label}`} value={value} disabled={!canWrite || busy}
              onChange={e => setCounts(previous => ({ ...previous, [line.key]: e.target.value.replace(/[^\d]/g, '') }))} /></td>
            <td data-label="Difference" className="right tabular">{diff == null ? '' : <strong className={diff > 0 ? 'positive' : diff < 0 ? 'danger' : ''}>{diff > 0 ? `+${diff}` : diff}</strong>}</td>
          </tr>;
        })}
      </tbody></table></TableRegion>}
    <div className="stock-count-footer">
      <input className="input" maxLength={200} placeholder="Note for this count (e.g. Saturday full count, rail A)" aria-label="Count note" value={note} onChange={e => setNote(e.target.value)} disabled={!canWrite || busy} />
      <button className="button secondary" onClick={() => setCounts({})} disabled={busy || !entered.length}>Clear</button>
      <button className="button primary" onClick={submit} disabled={!canWrite || busy || !entered.length}>{busy ? 'Saving…' : `Save count (${entered.length})`}</button>
    </div>
    <p className="field-hint stock-count-hint">If someone buys an item on the website while you count, that line is refused instead of overwritten — just re-check and enter it again.</p>
  </section>;
}

function MovementHistory({ line, notify, compact = false }) {
  const [rows, setRows] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const params = line ? `productId=${line.productId}${line.variationId ? `&variationId=${line.variationId}` : ''}&` : '';
  const loadPage = useCallback(async (before) => {
    setBusy(true);
    try {
      const res = await api(`/inventory/movements?${params}limit=50${before ? `&before=${before}` : ''}`);
      setRows(previous => before ? [...(previous || []), ...res.movements] : res.movements);
      setCursor(res.nextCursor); setHasMore(res.hasMore); setNotice(res.notice);
    } catch (e) { notify(e.message, 'error'); setRows(previous => previous || []); }
    finally { setBusy(false); }
  }, [params, notify]);
  useEffect(() => { loadPage(); }, [loadPage]);
  if (!rows) return <Spinner label="Loading movements…" />;
  const body = !rows.length ? <Empty icon={History} title="No stock movements yet">Deliveries, write-offs, counts, price changes and POS sales appear here.</Empty> :
    <TableRegion label="Stock movements"><table className="responsive-table stock-table movement-table"><thead><tr><th>When</th>{!line && <th>Product</th>}<th>Change</th><th className="right">Qty</th><th className="right">Stock after</th><th>By</th></tr></thead><tbody>
      {rows.map(m => <tr key={m.id}>
        <td data-label="When">{dateTime(m.at)}</td>
        {!line && <td data-label="Product"><strong className="table-primary">{m.name}</strong><small>{m.label}{m.sku ? ` · ${m.sku}` : ''}</small></td>}
        <td data-label="Change"><Badge tone={m.source === 'pos_sale' ? 'neutral' : m.type === 'price' ? 'neutral' : m.status === 'stock_failed' || m.status === 'stock_uncertain' ? 'red' : m.delta > 0 ? 'green' : m.delta < 0 ? 'amber' : 'neutral'}>{movementLabel(m)}</Badge>{m.note && <small className="movement-note">{m.note}</small>}{m.error && <small className="error-text">{m.error}</small>}</td>
        <td data-label="Qty" className="right tabular">{m.type === 'price' ? priceChange(m) : m.delta == null ? '—' : m.delta > 0 ? `+${m.delta}` : m.delta}</td>
        <td data-label="Stock after" className="right tabular">{m.type === 'price' || m.after == null ? '—' : `${m.before ?? '—'} → ${m.after}`}</td>
        <td data-label="By">{m.by}</td>
      </tr>)}
    </tbody></table></TableRegion>;
  return <div className={compact ? 'movement-compact' : 'surface records-surface'}>
    {!compact && <div className="section-heading"><div><h2>Movement history</h2><p>Every stock change made from the POS, plus POS sales.</p></div><button className="button secondary small" onClick={() => loadPage()} disabled={busy}><RefreshCw size={14} />Refresh</button></div>}
    {body}
    <div className="table-footer"><span>{notice}</span>{hasMore && <button className="button secondary small" onClick={() => loadPage(cursor)} disabled={busy}>{busy ? 'Loading…' : 'Load older'}</button>}</div>
  </div>;
}
function movementLabel(m) {
  if (m.source === 'pos_sale') return m.reasonLabel;
  if (m.type === 'price') return 'Price change';
  if (m.status === 'stock_failed') return 'Change failed';
  if (m.status === 'stock_uncertain') return 'Unconfirmed — check stock';
  if (m.type === 'count') return m.delta === 0 ? 'Count confirmed' : 'Stock count';
  return m.reasonLabel || (m.type === 'receive' ? 'Received' : 'Removed');
}
function priceChange(m) {
  const show = p => p?.sale ? `${p.sale} (sale)` : p?.regular || '—';
  return `${show(m.before)} → ${show(m.after)}`;
}
