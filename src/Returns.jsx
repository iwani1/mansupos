import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Search, Undo2, PackageCheck, History, LockKeyhole } from 'lucide-react';
import { api, money, dateTime, uuid } from './api.js';
import { PageHeading, Stat, Empty, Badge, Notice, Spinner, TableRegion } from './components.jsx';
import './stock-control.css';
import './product-editor.css';
import './purchasing.css';

const DISPOSITIONS = [
  ['restock', 'Back on sale', 'Added to website and shop stock now'],
  ['quarantine', 'Check first', 'Kept aside; decide later'],
  ['damaged', 'Damaged', 'Kept aside; decide later'],
  ['write_off', 'Write off', 'Not sellable; recorded only'],
  ['supplier_return', 'Return to supplier', 'Recorded for the supplier'],
];
const REASONS = [['wrong_size', 'Wrong size'], ['faulty', 'Faulty'], ['damaged_in_shop', 'Damaged in shop'], ['changed_mind', 'Changed mind'], ['price_error', 'Price error'], ['other', 'Other']];
const STATUS = { completed: ['Completed', 'green'], cash_review: ['Cash out not recorded', 'red'], refunding: ['Refund not confirmed', 'amber'], refunded: ['Refunded', 'amber'], failed: ['Failed', 'neutral'] };
const label = i => `${i.name}${i.label ? ` · ${i.label}` : ''}`;

export default function Returns({ notify, refreshCatalog }) {
  const [tab, setTab] = useState('new');
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try { const [s, h] = await Promise.all([api('/returns/summary'), api('/returns')]); setData(s); setHistory(h.returns); setError(''); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const changed = useCallback(() => { load(); refreshCatalog?.(); }, [load, refreshCatalog]);
  const s = data?.summary;
  return <div className="purchasing">
    <PageHeading eyebrow="Operations / after-sales" title="Customer returns" description="Take back items from a POS sale. The refund is recorded on the WooCommerce order and the cash on your shift; only items you mark “Back on sale” go back into website stock.">
      <button className="button secondary" onClick={load} disabled={busy}><RefreshCw size={16} className={busy ? 'spin' : ''} />Refresh</button>
    </PageHeading>
    {error && <Notice tone="error">{error}</Notice>}
    {!data ? !error && <Spinner label="Loading returns…" /> : <>
      {!data.writes.enabled && <Notice tone="warning" icon={LockKeyhole}><strong>View only.</strong> {data.writes.reason}</Notice>}
      <div className="stats-grid four">
        <Stat label="Returns · 30 days" value={s.last30} detail="Completed returns" />
        <Stat label="Refunded · 30 days" value={money(s.refunded30)} detail="Paid back to customers" />
        <Stat label="Awaiting decision" value={s.awaiting} detail="Damaged or check-first items" tone="warm" />
        <Stat label="Needs attention" value={s.needsReview} detail="Unconfirmed refund or cash" />
      </div>
      <div className="stock-tabs" role="tablist" aria-label="Returns sections">
        {[['new', 'New return', Undo2], ['awaiting', `Awaiting decision (${s.awaiting})`, PackageCheck], ['history', 'History', History]].map(([id, text, Icon]) =>
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={16} />{text}</button>)}
      </div>
      {tab === 'new' && <NewReturn canWrite={data.writes.enabled} notify={notify} onDone={() => { changed(); }} />}
      {tab === 'awaiting' && <Awaiting items={data.awaiting} canWrite={data.writes.enabled} notify={notify} onChanged={changed} />}
      {tab === 'history' && <ReturnHistory returns={history} />}
    </>}
  </div>;
}

function NewReturn({ canWrite, notify, onDone }) {
  const [query, setQuery] = useState('');
  const [sales, setSales] = useState(null);
  const [info, setInfo] = useState(null);
  const [rows, setRows] = useState({});
  const [reason, setReason] = useState('wrong_size');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const search = useCallback(async q => {
    try { setSales((await api(`/returns/find?q=${encodeURIComponent(q)}`)).sales); }
    catch (e) { notify(e.message, 'error'); }
  }, [notify]);
  useEffect(() => { const t = setTimeout(() => search(query.trim()), 250); return () => clearTimeout(t); }, [query, search]);
  async function open(saleId) {
    setError(''); setResult(null);
    try {
      const r = await api(`/returns/sale/${encodeURIComponent(saleId)}`);
      setInfo(r); setRows(Object.fromEntries(r.lines.map(l => [`${l.productId}:${l.variationId}`, { qty: 0, disposition: 'restock' }]))); setKey(uuid()); setReason('wrong_size'); setNote('');
    } catch (e) { notify(e.message, 'error'); }
  }
  const chosen = info ? info.lines.map(l => ({ ...l, ...rows[`${l.productId}:${l.variationId}`] })).filter(l => l.qty > 0) : [];
  const total = Math.min(chosen.reduce((t, l) => t + l.unitRefund * l.qty, 0), info ? info.sale.total - info.sale.refunded : 0);
  const cash = info?.sale.paymentMethod === 'cash';
  const drawerShort = cash && info?.drawerCash != null && info.drawerCash < total;
  const noShift = cash && total > 0 && info?.shiftRequired && !info?.shiftOpen;
  async function submit() {
    if (!chosen.length || busy) return;
    if (!window.confirm(`Refund ${money(total)}${cash ? ' in cash from your drawer' : ''} for ${chosen.reduce((n, l) => n + l.qty, 0)} item(s)?`)) return;
    setBusy(true); setError('');
    try {
      const r = await api('/returns', { method: 'POST', body: { key, saleId: info.sale.id, reason, note: note.trim(),
        lines: chosen.map(l => ({ productId: l.productId, variationId: l.variationId, quantity: l.qty, disposition: l.disposition })) } });
      setResult(r);
      if (r.failures.length) notify('Return refunded, but some items were not put back in stock. Press "Complete return" again to retry.', 'error');
      else notify(`${r.return.number} done: ${money(r.return.refundTotal)} refunded.`);
      if (r.return.status === 'cash_review') notify(r.return.error, 'error');
      onDone();
      if (!r.failures.length) { setInfo(null); setQuery(''); }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  if (!info) return <section className="surface records-surface">
    <div className="section-heading"><div><h2>Find the sale</h2><p>Search the receipt or order number, or pick a recent paid sale.</p></div></div>
    <div className="table-toolbar"><label className="search-field compact"><Search size={18} aria-hidden="true" /><input aria-label="Search sales to return" placeholder="Receipt or order number, e.g. 4001" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    {!sales ? <Spinner /> : !sales.length ? <Empty icon={Search} title="No paid sales found">Website orders are refunded in WooCommerce; this screen handles POS sales.</Empty> :
      <TableRegion label="Sales"><table className="responsive-table po-table"><thead><tr><th>Receipt</th><th>Date</th><th>Payment</th><th className="right">Total</th><th className="right">Refunded</th><th /></tr></thead><tbody>
        {sales.map(s => <tr key={s.id}><td data-label="Receipt"><strong className="table-primary">{s.number}</strong><small>{s.items} item(s) · {s.cashierName}</small></td>
          <td data-label="Date">{dateTime(s.paidAt)}</td><td data-label="Payment">{s.paymentMethod || '—'}</td>
          <td data-label="Total" className="right tabular">{money(s.total)}</td><td data-label="Refunded" className="right tabular">{s.refunded ? money(s.refunded) : '—'}</td>
          <td><button className="button secondary small" onClick={() => open(s.id)}>Return items</button></td></tr>)}
      </tbody></table></TableRegion>}
  </section>;
  return <section className="surface records-surface">
    <div className="section-heading"><div><h2>Return from {info.sale.number}</h2><p>{dateTime(info.sale.paidAt)} · {info.sale.cashierName} · paid {money(info.sale.total)} by {info.sale.paymentMethod}{info.sale.refunded ? ` · ${money(info.sale.refunded)} already refunded` : ''}</p></div>
      <button className="button secondary" onClick={() => setInfo(null)} disabled={busy}>Choose another sale</button></div>
    <div className="form-stack" style={{ padding: '0 16px 16px' }}>
      {result?.failures?.length > 0 && <Notice tone="warning">Refunded, but not yet back in stock: {result.failures.map(f => `${label(f)} — ${f.error}`).join('; ')}. Press <strong>Complete return</strong> again to retry only those items.</Notice>}
      <div className="table-scroll" role="region" aria-label="Items to return" tabIndex={0}><table className="pe-table"><thead><tr><th>Item</th><th className="right">Sold</th><th className="right">Can return</th><th>Return</th><th>What happens to it</th><th className="right">Refund</th></tr></thead><tbody>
        {info.lines.map(l => { const k = `${l.productId}:${l.variationId}`; const row = rows[k]; return <tr key={k} className={l.returnable ? '' : 'off'}>
          <td><strong>{l.name}</strong><small>{l.label}{l.sku ? ` · ${l.sku}` : ''} · {money(l.unitRefund)} each</small></td>
          <td className="right tabular">{l.sold}</td><td className="right tabular">{l.returnable}</td>
          <td><select className="select po-num" aria-label={`Quantity to return for ${label(l)}`} value={row.qty} disabled={!l.returnable || busy} onChange={e => setRows(r => ({ ...r, [k]: { ...r[k], qty: Number(e.target.value) } }))}>
            {Array.from({ length: l.returnable + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}</select></td>
          <td><select className="select" aria-label={`What happens to ${label(l)}`} value={row.disposition} disabled={!row.qty || busy} onChange={e => setRows(r => ({ ...r, [k]: { ...r[k], disposition: e.target.value } }))}>
            {DISPOSITIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>{row.qty > 0 && <small>{DISPOSITIONS.find(d => d[0] === row.disposition)[2]}</small>}</td>
          <td className="right tabular">{row.qty ? money(l.unitRefund * row.qty) : ''}</td>
        </tr>; })}
      </tbody></table></div>
      <div className="po-grid">
        <label>Reason<select className="select" value={reason} onChange={e => setReason(e.target.value)} disabled={busy}>{REASONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <label>Note {reason === 'other' ? '(required)' : '(optional)'}<input className="input" maxLength={200} value={note} onChange={e => setNote(e.target.value)} disabled={busy} /></label>
      </div>
      {noShift && <Notice tone="warning">Open your shift first: the cash is paid from your drawer.</Notice>}
      {drawerShort && <Notice tone="warning">Your drawer should hold {money(info.drawerCash)}, less than this refund. Record a Cash in first, or use the owner's float.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="po-actions"><span className="pe-summary">{chosen.length ? `${chosen.reduce((n, l) => n + l.qty, 0)} item(s) · refund ${money(total)}${cash ? ' cash' : ''}` : 'Choose how many of each item come back'}</span>
        <button className="button primary" onClick={submit} disabled={!canWrite || busy || !chosen.length || (reason === 'other' && note.trim().length < 3)}>{busy ? 'Processing…' : 'Complete return'}</button></div>
    </div>
  </section>;
}

function Awaiting({ items, canWrite, notify, onChanged }) {
  const [busy, setBusy] = useState('');
  async function resolve(item, action) {
    const text = { restock: `Put ${item.quantity} × ${label(item)} back on sale (website and shop)?`, write_off: `Write off ${item.quantity} × ${label(item)}?`, supplier_return: `Mark ${item.quantity} × ${label(item)} for return to the supplier?` }[action];
    if (!window.confirm(text)) return;
    setBusy(item.id);
    try { await api(`/returns/items/${item.id}/resolve`, { method: 'POST', body: { action, note: '' } }); notify(`${label(item)}: done.`); onChanged(); }
    catch (e) { notify(e.message, 'error'); }
    finally { setBusy(''); }
  }
  if (!items.length) return <section className="surface"><Empty icon={PackageCheck} title="Nothing waiting">Damaged and check-first items from returns appear here until you decide what to do with them.</Empty></section>;
  return <section className="surface records-surface">
    <div className="section-heading"><div><h2>Awaiting decision</h2><p>These items are not in website stock. Check each one, then decide.</p></div></div>
    <TableRegion label="Items awaiting decision"><table className="responsive-table po-table"><thead><tr><th>Item</th><th className="right">Qty</th><th>Kept as</th><th>From</th><th className="right">Actions</th></tr></thead><tbody>
      {items.map(i => <tr key={i.id}><td data-label="Item"><strong className="table-primary">{i.name}</strong><small>{i.label}{i.sku ? ` · ${i.sku}` : ''}</small></td>
        <td data-label="Qty" className="right tabular">{i.quantity}</td><td data-label="Kept as"><Badge tone={i.disposition === 'damaged' ? 'red' : 'amber'}>{i.dispositionLabel}</Badge></td>
        <td data-label="From">{i.returnNumber} · sale {i.saleNumber}<small>{dateTime(i.returnedAt)}</small></td>
        <td data-label="Actions"><div className="row-actions stock-actions">
          <button className="button secondary small" disabled={!canWrite || busy === i.id} onClick={() => resolve(i, 'restock')}>Back on sale</button>
          <button className="button secondary small" disabled={!canWrite || busy === i.id} onClick={() => resolve(i, 'write_off')}>Write off</button>
          <button className="button secondary small" disabled={!canWrite || busy === i.id} onClick={() => resolve(i, 'supplier_return')}>To supplier</button>
        </div></td></tr>)}
    </tbody></table></TableRegion>
  </section>;
}

function ReturnHistory({ returns }) {
  if (!returns?.length) return <section className="surface"><Empty icon={History} title="No returns yet">Completed returns appear here.</Empty></section>;
  return <section className="surface records-surface">
    <TableRegion label="Return history"><table className="responsive-table po-table"><thead><tr><th>Return</th><th>Items</th><th>Status</th><th className="right">Refund</th><th>By</th></tr></thead><tbody>
      {returns.map(r => <tr key={r.id}><td data-label="Return"><strong className="table-primary">{r.number}</strong><small>Sale {r.saleNumber} · {r.reasonLabel}{r.note ? ` · ${r.note}` : ''}</small></td>
        <td data-label="Items">{r.items.map(i => <small key={i.id}>{i.quantity} × {label(i)} — {i.resolution ? `${i.dispositionLabel} → ${i.resolutionLabel}` : i.dispositionLabel}{i.stockStatus === 'restocked' ? ` (stock ${i.stockBefore} → ${i.stockAfter})` : ''}</small>)}</td>
        <td data-label="Status"><Badge dot tone={(STATUS[r.status] || ['', 'neutral'])[1]}>{(STATUS[r.status] || [r.status])[0]}</Badge>{r.error && <small className="error-text">{r.error}</small>}</td>
        <td data-label="Refund" className="right tabular">{money(r.refundTotal)}<small>{r.paymentMethod}{r.cashRecorded ? ' · cash out recorded' : ''}</small></td>
        <td data-label="By">{r.createdByName}<small>{dateTime(r.createdAt)}</small></td></tr>)}
    </tbody></table></TableRegion>
  </section>;
}
