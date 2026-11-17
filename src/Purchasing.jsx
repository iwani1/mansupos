import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Truck, ClipboardList, Users, Calculator, PackageCheck, Search, Trash2, Download } from 'lucide-react';
import { api, money, dateTime, uuid } from './api.js';
import { PageHeading, Stat, Empty, Badge, Modal, Notice, Spinner, TableRegion } from './components.jsx';
import './stock-control.css';
import './product-editor.css';
import './purchasing.css';

const STATUS = {
  draft: ['Draft', 'neutral'], pending_approval: ['Awaiting approval', 'amber'], approved: ['Approved', 'green'], ordered: ['Sent to supplier', 'green'],
  partially_received: ['Partly received', 'amber'], received: ['Received', 'neutral'], cancelled: ['Cancelled', 'neutral'],
};
const cedis = value => { const t = String(value ?? '').trim(); return /^\d{1,7}(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null; };
const asCedis = cents => cents == null ? '' : (cents / 100).toFixed(2);
const lineName = l => `${l.name}${l.label && l.label !== 'Standard' ? ` · ${l.label}` : ''}`;
function csv(rows, name) {
  const cell = v => { let t = String(v ?? ''); if (/^[=+\-@]/.test(t)) t = `'${t}`; return /[",\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t; };
  const url = URL.createObjectURL(new Blob([`\ufeff${rows.map(r => r.map(cell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Purchasing({ user, notify, refreshCatalog }) {
  const [tab, setTab] = useState('orders');
  const [overview, setOverview] = useState(null);
  const [orders, setOrders] = useState(null);
  const [suppliers, setSuppliers] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openOrder, setOpenOrder] = useState(null);
  const [draft, setDraft] = useState(null); // new order prefill
  const [supplierForm, setSupplierForm] = useState(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [o, p, s] = await Promise.all([api('/purchasing/overview'), api('/purchase-orders'), api('/suppliers')]);
      setOverview(o); setOrders(p.orders); setSuppliers(s.suppliers); setError('');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const changed = useCallback(async () => { await load(); refreshCatalog?.(); }, [load, refreshCatalog]);

  const s = overview?.summary;
  return <div className="purchasing">
    <PageHeading eyebrow="Catalogue / buying" title="Purchasing" description="Suppliers, purchase orders and deliveries. Receiving a delivery adds the stock to WooCommerce, so the website and the shop see it at once.">
      <button className="button secondary" onClick={load} disabled={busy}><RefreshCw size={16} className={busy ? 'spin' : ''} />Refresh</button>
      <button className="button primary" onClick={() => setDraft({ items: [] })} disabled={!suppliers}><Plus size={16} />New purchase order</button>
    </PageHeading>
    {error && <Notice tone="error">{error}</Notice>}
    {!overview ? !error && <Spinner label="Loading purchasing…" /> : <>
      {!overview.writes.enabled && <Notice tone="warning">Receiving is view-only: {overview.writes.reason}</Notice>}
      <div className="stats-grid four">
        <Stat label="Open purchase orders" value={s.openOrders} detail={`${s.awaitingApproval} awaiting approval`} />
        <Stat label="Incoming stock" value={s.incomingUnits.toLocaleString()} detail={`${money(s.incomingValue)} at order cost`} />
        <Stat label="Stock value at cost" value={money(s.costValue)} detail={s.linesWithoutCost ? `${s.linesWithoutCost} stocked lines have no cost yet` : 'All stocked lines costed'} tone="featured" />
        <Stat label="Needs reordering" value={s.toReorder} detail={`At or below ${s.threshold}, after stock on order`} tone="warm" />
      </div>
      <div className="stock-tabs" role="tablist" aria-label="Purchasing sections">
        {[['orders', 'Purchase orders', ClipboardList], ['reorder', `Reorder (${s.toReorder})`, Truck], ['suppliers', 'Suppliers', Users], ['valuation', 'Stock value', Calculator]].map(([id, label, Icon]) =>
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}
      </div>
      {tab === 'orders' && <Orders orders={orders} onOpen={id => setOpenOrder(id)} />}
      {tab === 'reorder' && <Reorder lines={overview.lines} onOrder={items => setDraft({ items })} />}
      {tab === 'suppliers' && <Suppliers suppliers={suppliers} onEdit={sup => setSupplierForm(sup || {})} />}
      {tab === 'valuation' && <Valuation lines={overview.lines} summary={s} canEdit={user.role === 'owner'} notify={notify} onChanged={load} />}
    </>}
    {draft && <OrderForm suppliers={suppliers} lines={overview?.lines || []} initial={draft} notify={notify} onClose={() => setDraft(null)}
      onSaved={order => { setDraft(null); load(); setOpenOrder(order.id); }} onNewSupplier={() => setSupplierForm({})} />}
    {openOrder && <OrderDetail id={openOrder} suppliers={suppliers} lines={overview?.lines || []} user={user} canReceive={overview?.writes.enabled} notify={notify} onClose={() => setOpenOrder(null)} onChanged={changed} />}
    {supplierForm && <SupplierForm supplier={supplierForm} notify={notify} onClose={() => setSupplierForm(null)} onSaved={() => { setSupplierForm(null); load(); }} />}
  </div>;
}

function Orders({ orders, onOpen }) {
  const [filter, setFilter] = useState('open');
  const shown = (orders || []).filter(o => filter === 'all' || (filter === 'open' ? !['received', 'cancelled'].includes(o.status) : o.status === filter));
  return <section className="surface records-surface">
    <div className="table-toolbar"><select className="select" aria-label="Filter purchase orders" value={filter} onChange={e => setFilter(e.target.value)}>
      <option value="open">Open orders</option><option value="pending_approval">Awaiting approval</option><option value="partially_received">Partly received</option><option value="received">Received</option><option value="cancelled">Cancelled</option><option value="all">All orders</option>
    </select></div>
    {!shown.length ? <Empty icon={ClipboardList} title="No purchase orders here">Create a purchase order, or pick items from the Reorder tab.</Empty> :
      <TableRegion label="Purchase orders"><table className="responsive-table po-table"><thead><tr><th>Order</th><th>Supplier</th><th>Status</th><th className="right">Received</th><th className="right">Total</th><th>Created</th></tr></thead><tbody>
        {shown.map(o => <tr key={o.id}>
          <td data-label="Order"><button className="product-name-button" onClick={() => onOpen(o.id)}>{o.number}</button><small>{o.lines} {o.lines === 1 ? 'line' : 'lines'}{o.expectedDate ? ` · due ${o.expectedDate}` : ''}</small></td>
          <td data-label="Supplier">{o.supplierName}</td>
          <td data-label="Status"><Badge dot tone={STATUS[o.status][1]}>{STATUS[o.status][0]}</Badge></td>
          <td data-label="Received" className="right tabular">{o.unitsReceived} / {o.units}</td>
          <td data-label="Total" className="right tabular"><strong>{money(o.total)}</strong></td>
          <td data-label="Created">{dateTime(o.createdAt)}<small>{o.createdByName}</small></td>
        </tr>)}
      </tbody></table></TableRegion>}
  </section>;
}

function Reorder({ lines, onOrder }) {
  const list = useMemo(() => lines.filter(l => l.suggested > 0).sort((a, b) => (a.stock - b.stock) || (b.posSold30 - a.posSold30)), [lines]);
  const [picked, setPicked] = useState(() => new Set());
  const toggle = key => setPicked(p => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  return <section className="surface records-surface">
    <div className="section-heading"><div><h2>Suggested reorders</h2><p>Items at or below the low-stock level after counting stock already on order. Suggested quantity aims for about 45 days of shop sales (website sales are not included).</p></div>
      <button className="button primary" disabled={!picked.size} onClick={() => onOrder(list.filter(l => picked.has(l.key)).map(l => ({ ...l, quantity: l.suggested, unitCost: l.lastCost ?? l.avgCost ?? null })))}>Create order ({picked.size})</button></div>
    {!list.length ? <Empty icon={Truck} title="Nothing to reorder">Every tracked item is above its low-stock level or already on order.</Empty> :
      <TableRegion label="Suggested reorders"><table className="responsive-table po-table"><thead><tr><th><span className="visually-hidden">Select</span></th><th>Item</th><th className="right">In stock</th><th className="right">On order</th><th className="right">Shop sold · 30 d</th><th className="right">Suggested</th><th className="right">Last cost</th></tr></thead><tbody>
        {list.map(l => <tr key={l.key}>
          <td><input type="checkbox" checked={picked.has(l.key)} onChange={() => toggle(l.key)} aria-label={`Reorder ${lineName(l)}`} /></td>
          <td data-label="Item"><strong className="table-primary">{l.name}</strong><small>{l.label}{l.sku ? ` · ${l.sku}` : ''}</small></td>
          <td data-label="In stock" className="right tabular">{l.stock}</td>
          <td data-label="On order" className="right tabular">{l.incoming || '—'}</td>
          <td data-label="Shop sold" className="right tabular">{l.posSold30}</td>
          <td data-label="Suggested" className="right tabular"><strong>{l.suggested}</strong></td>
          <td data-label="Last cost" className="right tabular">{l.lastCost != null ? money(l.lastCost) : '—'}</td>
        </tr>)}
      </tbody></table></TableRegion>}
  </section>;
}

function Suppliers({ suppliers, onEdit }) {
  return <section className="surface records-surface">
    <div className="section-heading"><div><h2>Suppliers</h2><p>Who you buy from. Used on purchase orders.</p></div><button className="button secondary" onClick={() => onEdit(null)}><Plus size={15} />Add supplier</button></div>
    {!suppliers?.length ? <Empty icon={Users} title="No suppliers yet">Add the people and companies you buy stock from.</Empty> :
      <TableRegion label="Suppliers"><table className="responsive-table po-table"><thead><tr><th>Supplier</th><th>Phone</th><th>Email</th><th className="right">Orders</th><th>Status</th><th><span className="visually-hidden">Action</span></th></tr></thead><tbody>
        {suppliers.map(sp => <tr key={sp.id}>
          <td data-label="Supplier"><strong className="table-primary">{sp.name}</strong>{sp.reference && <small>Ref {sp.reference}</small>}</td>
          <td data-label="Phone">{sp.phone || '—'}</td><td data-label="Email">{sp.email || '—'}</td>
          <td data-label="Orders" className="right tabular">{sp.orders}</td>
          <td data-label="Status"><Badge tone={sp.active ? 'green' : 'neutral'}>{sp.active ? 'Active' : 'Inactive'}</Badge></td>
          <td><button className="text-button" onClick={() => onEdit(sp)}>Edit</button></td>
        </tr>)}
      </tbody></table></TableRegion>}
  </section>;
}

function Valuation({ lines, summary, canEdit, notify, onChanged }) {
  const [query, setQuery] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [editing, setEditing] = useState(null);
  const [value, setValue] = useState('');
  const stocked = lines.filter(l => l.manageStock && l.stock > 0);
  const shown = stocked.filter(l => (!onlyMissing || l.avgCost == null) && `${l.name} ${l.label} ${l.sku}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 300);
  async function save(line) {
    const cents = cedis(value);
    if (cents == null) { notify('Enter a cost in GH₵, e.g. 45.50', 'error'); return; }
    try { await api('/inventory/cost', { method: 'PUT', body: { productId: line.productId, variationId: line.variationId, cost: cents } }); setEditing(null); notify(`Cost saved for ${lineName(line)}.`); onChanged(); }
    catch (e) { notify(e.message, 'error'); }
  }
  const margin = summary.retailValueOfCosted ? Math.round((1 - summary.costValue / summary.retailValueOfCosted) * 100) : null;
  return <section className="surface records-surface">
    <div className="section-heading"><div><h2>Stock value</h2><p>Weighted average cost from deliveries (or set by the owner) × units in stock. Costs stay in the POS and are never shown on the website.{margin != null ? ` Costed lines: ${money(summary.costValue)} at cost, ${money(summary.retailValueOfCosted)} at retail (${margin}% margin).` : ''}</p></div>
      <button className="button secondary" onClick={() => csv([['Product', 'Option', 'SKU', 'In stock', 'Average cost (GHS)', 'Last cost (GHS)', 'Value at cost (GHS)', 'Retail price (GHS)', 'Value at retail (GHS)'],
        ...stocked.map(l => [l.name, l.label, l.sku, l.stock, asCedis(l.avgCost), asCedis(l.lastCost), l.avgCost != null ? asCedis(l.avgCost * l.stock) : '', asCedis(l.price), asCedis(l.price * l.stock)])], `mansu-stock-value-${new Date().toISOString().slice(0, 10)}.csv`)}><Download size={15} />Export CSV</button></div>
    <div className="table-toolbar"><label className="search-field compact"><Search size={18} aria-hidden="true" /><input aria-label="Search stock value" placeholder="Product or SKU…" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label className="check-label"><input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} />Only items without a cost ({summary.linesWithoutCost})</label></div>
    <TableRegion label="Stock value"><table className="responsive-table po-table"><thead><tr><th>Item</th><th className="right">In stock</th><th className="right">Average cost</th><th className="right">Value at cost</th><th className="right">Retail price</th>{canEdit && <th />}</tr></thead><tbody>
      {shown.map(l => <tr key={l.key}>
        <td data-label="Item"><strong className="table-primary">{l.name}</strong><small>{l.label}{l.sku ? ` · ${l.sku}` : ''}</small></td>
        <td data-label="In stock" className="right tabular">{l.stock}</td>
        <td data-label="Average cost" className="right tabular">{editing === l.key ? <input className="input po-num" inputMode="decimal" autoFocus aria-label={`Cost for ${lineName(l)}`} value={value} onChange={e => setValue(e.target.value.replace(/[^\d.]/g, ''))} onKeyDown={e => { if (e.key === 'Enter') save(l); if (e.key === 'Escape') setEditing(null); }} /> : l.avgCost != null ? money(l.avgCost) : <span className="muted">Not set</span>}</td>
        <td data-label="Value at cost" className="right tabular">{l.avgCost != null ? money(l.avgCost * l.stock) : '—'}</td>
        <td data-label="Retail price" className="right tabular">{money(l.price)}</td>
        {canEdit && <td>{editing === l.key ? <><button className="text-button" onClick={() => save(l)}>Save</button> <button className="text-button" onClick={() => setEditing(null)}>Cancel</button></> : <button className="text-button" onClick={() => { setEditing(l.key); setValue(asCedis(l.avgCost)); }}>Set cost</button>}</td>}
      </tr>)}
    </tbody></table></TableRegion>
    <div className="table-footer"><span>{shown.length} of {stocked.length} stocked lines{shown.length === 300 ? ' (first 300 — search to narrow)' : ''}</span></div>
  </section>;
}

function OrderForm({ suppliers, lines, initial, notify, onClose, onSaved, onNewSupplier }) {
  const [supplierId, setSupplierId] = useState(initial.supplierId || suppliers?.find(x => x.active)?.id || '');
  const [expectedDate, setExpectedDate] = useState(initial.expectedDate || '');
  const [note, setNote] = useState(initial.note || '');
  const [items, setItems] = useState(() => initial.items.map(l => ({ ...l, qty: String(l.quantity || ''), cost: asCedis(l.unitCost) })));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const matches = query.trim().length < 2 ? [] : lines.filter(l => !items.some(i => i.key === l.key) && `${l.name} ${l.label} ${l.sku}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8);
  const set = (key, patch) => setItems(list => list.map(i => i.key === key ? { ...i, ...patch } : i));
  const valid = supplierId && items.length && items.every(i => /^\d+$/.test(i.qty) && Number(i.qty) > 0 && cedis(i.cost) != null);
  const total = items.reduce((t, i) => t + (Number(i.qty) || 0) * (cedis(i.cost) || 0), 0);
  async function save() {
    if (!valid || busy) return;
    setBusy(true); setError('');
    try {
      const body = { supplierId, expectedDate, note: note.trim(), items: items.map(i => ({ productId: i.productId, variationId: i.variationId, name: i.name, label: i.label === 'Standard' ? '' : i.label || '', sku: i.sku || '', quantity: Number(i.qty), unitCost: cedis(i.cost) })) };
      const { order } = initial.id ? await api(`/purchase-orders/${initial.id}`, { method: 'PUT', body }) : await api('/purchase-orders', { method: 'POST', body });
      notify(`${order.number} saved as a draft.`); onSaved(order);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <Modal title={initial.id ? `Edit ${initial.number}` : 'New purchase order'} subtitle="Saved as a draft. Submit it for approval, or an owner can approve it straight away." wide busy={busy} onClose={onClose} className="po-modal">
    <div className="modal-body form-stack">
      {!suppliers?.some(x => x.active) && <Notice tone="warning">Add a supplier first. <button className="text-button" onClick={onNewSupplier}>Add supplier</button></Notice>}
      <div className="po-grid">
        <label>Supplier<select className="select" value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">Choose…</option>{suppliers?.filter(x => x.active || x.id === supplierId).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Expected delivery (optional)<input className="input" type="date" value={expectedDate} onChange={e => setExpectedDate(e.target.value)} /></label>
      </div>
      <label>Note (optional)<input className="input" maxLength={300} value={note} onChange={e => setNote(e.target.value)} /></label>
      <div className="po-picker"><label className="search-field compact"><Search size={18} aria-hidden="true" /><input aria-label="Add an item" placeholder="Add an item: name or SKU…" value={query} onChange={e => setQuery(e.target.value)} /></label>
        {matches.length > 0 && <div className="po-matches" role="listbox" aria-label="Matching items">{matches.map(l => <button type="button" role="option" aria-selected="false" key={l.key} onClick={() => { setItems(list => [...list, { ...l, qty: '1', cost: asCedis(l.lastCost ?? l.avgCost) }]); setQuery(''); }}>
          <strong>{l.name}</strong><span>{l.label}{l.sku ? ` · ${l.sku}` : ''} · {l.stock ?? '—'} in stock</span></button>)}</div>}</div>
      {items.length > 0 && <div className="table-scroll" role="region" aria-label="Order lines" tabIndex={0}><table className="pe-table"><thead><tr><th>Item</th><th>Quantity</th><th>Unit cost (GH₵)</th><th className="right">Line total</th><th><span className="visually-hidden">Remove</span></th></tr></thead><tbody>
        {items.map(i => <tr key={i.key}>
          <td><strong>{i.name}</strong><small>{i.label}{i.sku ? ` · ${i.sku}` : ''}</small></td>
          <td><input className="input po-num" inputMode="numeric" aria-label={`Quantity for ${lineName(i)}`} value={i.qty} onChange={e => set(i.key, { qty: e.target.value.replace(/\D/g, '') })} /></td>
          <td><input className="input po-num" inputMode="decimal" aria-label={`Unit cost for ${lineName(i)}`} value={i.cost} onChange={e => set(i.key, { cost: e.target.value.replace(/[^\d.]/g, '') })} /></td>
          <td className="right tabular">{money((Number(i.qty) || 0) * (cedis(i.cost) || 0))}</td>
          <td><button type="button" className="icon-button" aria-label={`Remove ${lineName(i)}`} onClick={() => setItems(list => list.filter(x => x.key !== i.key))}><Trash2 size={15} /></button></td>
        </tr>)}
      </tbody></table></div>}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
    <div className="modal-footer"><span className="pe-summary">{items.length} {items.length === 1 ? 'line' : 'lines'} · {money(total)}</span>
      <button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" onClick={save} disabled={!valid || busy}>{busy ? 'Saving…' : 'Save draft'}</button></div>
  </Modal>;
}

function OrderDetail({ id, suppliers, lines, user, canReceive, notify, onClose, onChanged }) {
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => api(`/purchase-orders/${id}`).then(r => setOrder(r.order)).catch(e => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function act(action, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try { const r = await api(`/purchase-orders/${id}/action`, { method: 'POST', body: { action, reason: '' } }); setOrder(r.order); onChanged(); notify(`${r.order.number}: ${STATUS[r.order.status][0].toLowerCase()}.`); }
    catch (e) { notify(e.message, 'error'); }
    finally { setBusy(false); }
  }
  if (editing && order) return <OrderForm suppliers={suppliers} lines={lines} initial={{ ...order, items: order.items.map(i => ({ ...i, key: `${i.productId}:${i.variationId}`, quantity: i.quantity, unitCost: i.unitCost })) }} notify={notify} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onChanged(); }} onNewSupplier={() => {}} />;
  const st = order && STATUS[order.status];
  return <Modal title={order ? order.number : 'Purchase order'} subtitle={order ? `${order.supplierName} · ${st[0]}` : ''} wide busy={busy} onClose={onClose} className="po-modal">
    <div className="modal-body">
      {error ? <Notice tone="error">{error}</Notice> : !order ? <Spinner /> : receiving ? <ReceiveForm order={order} notify={notify} onCancel={() => setReceiving(false)} onDone={o => { setOrder(o); setReceiving(false); onChanged(); }} /> : <>
        <div className="order-detail-meta">
          <div><span>Status</span><Badge dot tone={st[1]}>{st[0]}</Badge></div>
          <div><span>Created</span><strong>{dateTime(order.createdAt)} · {order.createdByName}</strong></div>
          {order.approvedByName && <div><span>Approved</span><strong>{dateTime(order.approvedAt)} · {order.approvedByName}</strong></div>}
          {order.expectedDate && <div><span>Expected</span><strong>{order.expectedDate}</strong></div>}
        </div>
        {order.note && <p className="field-hint">Note: {order.note}</p>}
        <div className="table-scroll" role="region" aria-label="Order lines" tabIndex={0}><table className="pe-table"><thead><tr><th>Item</th><th className="right">Ordered</th><th className="right">Received</th><th className="right">Damaged</th><th className="right">Unit cost</th><th className="right">Total</th></tr></thead><tbody>
          {order.items.map(i => <tr key={i.id}><td><strong>{i.name}</strong><small>{i.label}{i.sku ? ` · ${i.sku}` : ''}</small></td>
            <td className="right tabular">{i.quantity}</td><td className="right tabular">{i.received}{i.outstanding > 0 && order.status !== 'received' && <small>{i.outstanding} to come</small>}</td>
            <td className="right tabular">{i.damaged || '—'}</td><td className="right tabular">{money(i.unitCost)}</td><td className="right tabular">{money(i.unitCost * i.quantity)}</td></tr>)}
        </tbody></table></div>
        <div className="order-detail-total"><span>Order total</span><strong>{money(order.total)}</strong></div>
        {order.receipts.length > 0 && <><div className="detail-subheading">Deliveries</div><div className="po-receipts">{order.receipts.map(r => <div key={r.id}>
          <strong>{r.number}</strong> · {dateTime(r.createdAt)} · {r.receivedByName}{r.invoiceRef ? ` · invoice ${r.invoiceRef}` : ''}
          {r.status !== 'posted' && <Badge tone="red">Incomplete: {r.pendingLines} line(s) not added</Badge>}
          <small>{r.lines.map(l => `${l.name}${l.label ? ` ${l.label}` : ''}: +${l.received}${l.damaged ? ` (${l.damaged} damaged)` : ''}`).join(' · ')}</small>
        </div>)}</div></>}
        {order.closeReason && <Notice>{order.status === 'cancelled' ? 'Cancelled' : 'Closed'}: {order.closeReason}</Notice>}
      </>}
    </div>
    {order && !receiving && <div className="modal-footer" role="group" aria-label="Order actions">
      {order.status === 'draft' && <button className="button secondary" onClick={() => setEditing(true)} disabled={busy}>Edit</button>}
      {['draft', 'pending_approval', 'approved', 'ordered'].includes(order.status) && <button className="button secondary" onClick={() => act('cancel', `Cancel ${order.number}?`)} disabled={busy}>Cancel order</button>}
      {order.status === 'partially_received' && <button className="button secondary" onClick={() => act('close', 'Close this order? The quantities still outstanding will no longer count as incoming.')} disabled={busy}>Close short</button>}
      {order.status === 'draft' && user.role !== 'owner' && <button className="button primary" onClick={() => act('submit')} disabled={busy}>Submit for approval</button>}
      {['draft', 'pending_approval'].includes(order.status) && user.role === 'owner' && <button className="button primary" onClick={() => act('approve')} disabled={busy}>Approve</button>}
      {order.status === 'approved' && <button className="button secondary" onClick={() => act('mark_ordered')} disabled={busy}>Mark as sent</button>}
      {['approved', 'ordered', 'partially_received'].includes(order.status) && <button className="button primary" onClick={() => setReceiving(true)} disabled={busy || !canReceive}><PackageCheck size={15} />Receive delivery</button>}
    </div>}
  </Modal>;
}

function ReceiveForm({ order, notify, onCancel, onDone }) {
  const open = order.items.filter(i => i.outstanding > 0 || order.status !== 'received');
  const [rows, setRows] = useState(() => Object.fromEntries(open.map(i => [i.id, { received: String(i.outstanding), damaged: '', cost: asCedis(i.unitCost) }])));
  const [invoiceRef, setInvoiceRef] = useState('');
  const [note, setNote] = useState('');
  const [excess, setExcess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [key] = useState(uuid);
  const set = (itemId, patch) => setRows(r => ({ ...r, [itemId]: { ...r[itemId], ...patch } }));
  const lines = open.map(i => ({ item: i, row: rows[i.id] })).map(({ item, row }) => ({ item, received: Number(row.received || 0), damaged: Number(row.damaged || 0), cost: cedis(row.cost) }));
  const over = lines.filter(l => l.received > l.item.outstanding);
  const valid = lines.some(l => l.received > 0 || l.damaged > 0) && lines.every(l => l.cost != null) && (!over.length || excess);
  async function post() {
    if (!valid || busy) return;
    setBusy(true); setError('');
    try {
      const r = await api(`/purchase-orders/${order.id}/receive`, { method: 'POST', body: { key, invoiceRef: invoiceRef.trim(), note: note.trim(), allowExcess: excess,
        lines: lines.filter(l => l.received > 0 || l.damaged > 0).map(l => ({ itemId: l.item.id, received: l.received, damaged: l.damaged, unitCost: l.cost })) } });
      if (r.failures.length) {
        setError(`${r.failures.length} line(s) were not added: ${r.failures.map(f => `${f.name}${f.label ? ` ${f.label}` : ''} — ${f.error}`).join('; ')}. Press "Post delivery" again to retry only those lines.`);
        notify('Delivery partly posted. Some lines need a retry.', 'error');
        return;
      }
      notify(`${r.receipt.number} posted. Stock added on the website and in the shop.`);
      onDone(r.order);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <div className="form-stack">
    <Notice>Count what actually arrived. Good units are added to stock straight away; damaged units are recorded but not added. Posting the same delivery twice never adds stock twice.</Notice>
    <div className="po-grid"><label>Supplier invoice / delivery note (optional)<input className="input" maxLength={80} value={invoiceRef} onChange={e => setInvoiceRef(e.target.value)} /></label>
      <label>Note (optional)<input className="input" maxLength={300} value={note} onChange={e => setNote(e.target.value)} /></label></div>
    <div className="table-scroll" role="region" aria-label="Delivery lines" tabIndex={0}><table className="pe-table"><thead><tr><th>Item</th><th className="right">Outstanding</th><th>Good units</th><th>Damaged</th><th>Unit cost (GH₵)</th></tr></thead><tbody>
      {open.map(i => <tr key={i.id} className={Number(rows[i.id].received) > i.outstanding ? 'po-over' : ''}><td><strong>{i.name}</strong><small>{i.label}{i.sku ? ` · ${i.sku}` : ''}</small></td>
        <td className="right tabular">{i.outstanding}</td>
        <td><input className="input po-num" inputMode="numeric" aria-label={`Good units for ${lineName(i)}`} value={rows[i.id].received} onChange={e => set(i.id, { received: e.target.value.replace(/\D/g, '') })} /></td>
        <td><input className="input po-num" inputMode="numeric" aria-label={`Damaged units for ${lineName(i)}`} value={rows[i.id].damaged} onChange={e => set(i.id, { damaged: e.target.value.replace(/\D/g, '') })} /></td>
        <td><input className="input po-num" inputMode="decimal" aria-label={`Unit cost for ${lineName(i)}`} value={rows[i.id].cost} onChange={e => set(i.id, { cost: e.target.value.replace(/[^\d.]/g, '') })} /></td></tr>)}
    </tbody></table></div>
    {over.length > 0 && <label className="check-label"><input type="checkbox" checked={excess} onChange={e => setExcess(e.target.checked)} />The supplier sent more than ordered for {over.length} line(s). Accept the extra units.</label>}
    {error && <Notice tone="error">{error}</Notice>}
    <div className="po-actions"><button className="button secondary" onClick={onCancel} disabled={busy}>Back</button><button className="button primary" onClick={post} disabled={!valid || busy}>{busy ? 'Posting…' : 'Post delivery'}</button></div>
  </div>;
}

function SupplierForm({ supplier, notify, onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '', reference: '', notes: '', active: true, ...supplier });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = patch => setForm(f => ({ ...f, ...patch }));
  async function save(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const body = { name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim(), address: form.address.trim(), reference: form.reference.trim(), notes: form.notes.trim(), active: form.active };
      await (supplier.id ? api(`/suppliers/${supplier.id}`, { method: 'PUT', body }) : api('/suppliers', { method: 'POST', body }));
      notify(`${body.name} saved.`); onSaved();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <Modal title={supplier.id ? 'Edit supplier' : 'Add supplier'} onClose={onClose} busy={busy}><form onSubmit={save}><div className="modal-body form-stack">
    <label>Name<input className="input" required minLength={2} maxLength={120} value={form.name} onChange={e => set({ name: e.target.value })} /></label>
    <div className="po-grid"><label>Phone<input className="input" maxLength={40} value={form.phone} onChange={e => set({ phone: e.target.value })} /></label>
      <label>Email<input className="input" type="email" maxLength={120} value={form.email} onChange={e => set({ email: e.target.value })} /></label></div>
    <label>Address<input className="input" maxLength={200} value={form.address} onChange={e => set({ address: e.target.value })} /></label>
    <div className="po-grid"><label>Your account / reference<input className="input" maxLength={60} value={form.reference} onChange={e => set({ reference: e.target.value })} /></label>
      <label>Notes<input className="input" maxLength={300} value={form.notes} onChange={e => set({ notes: e.target.value })} /></label></div>
    {supplier.id && <label className="check-label"><input type="checkbox" checked={form.active} onChange={e => set({ active: e.target.checked })} />Active (can be used on new orders)</label>}
    {error && <Notice tone="error">{error}</Notice>}
  </div><div className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" disabled={busy || form.name.trim().length < 2}>{busy ? 'Saving…' : 'Save supplier'}</button></div></form></Modal>;
}
