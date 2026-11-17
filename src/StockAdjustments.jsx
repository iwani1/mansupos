import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, dateTime } from './api.js';
import { Notice, TableRegion } from './components.jsx';

const reasons = [
  ['delivery','New delivery received'],
  ['recount','Physical stock recount'],
  ['damage','Damaged items'],
  ['missing','Missing or lost items'],
  ['return','Customer return'],
  ['correction','Other correction'],
];
const statuses = { pending: 'Awaiting owner review', approved: 'Approved — update in WooCommerce',
  rejected: 'Rejected', verified: 'Verified stock balance' };

export default function StockAdjustments({ catalog, user, config, refresh }) {
  const [requests, setRequests] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [lookup, setLookup] = useState('');
  const [selected, setSelected] = useState('');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('delivery');
  const [note, setNote] = useState('');
  const [reviewNotes, setReviewNotes] = useState({});
  const isOwner = user?.role === 'owner';
  const options = useMemo(() => (catalog?.products || []).flatMap(product =>
    product.type === 'variable'
      ? (product.variations || []).map(v => ({ ...v, productId: product.id, variationId: v.id,
          name: product.name, label: v.label || 'Variation', key: `${product.id}:${v.id}` }))
      : [{ ...product, productId: product.id, variationId: 0, label: 'Standard', key: `${product.id}:0` }]
  ), [catalog]);
  const candidates = options.filter(item => `${item.name} ${item.label} ${item.sku}`.toLowerCase()
    .includes(lookup.toLowerCase())).slice(0, 100);
  const item = options.find(option => option.key === selected);
  const refreshQueue = useCallback(async () => {
    try {
      const result = await api('/stock-adjustments');
      setRequests(result.requests || []); setError(''); setLoaded(true);
    } catch (e) { setError(e.message); setLoaded(true); }
  }, []);
  useEffect(() => { void refreshQueue(); }, [refreshQueue]);
  async function submit(event) {
    event.preventDefault();
    if (!item || busy || !Number.isSafeInteger(Number(target)) || Number(target) < 0 || !note.trim()) return;
    setBusy('request');
    try {
      await api('/stock-adjustments', { method:'POST', body: {
        productId: item.productId, variationId: item.variationId,
        expectedQuantity: item.stock, targetQuantity: Number(target),
        reason, note: note.trim()
      } });
      setNote(''); setTarget(''); setSelected(''); await refreshQueue();
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }
  async function act(row, operation, decision) {
    if (busy) return;
    const actionName = decision === 'approve' ? 'approve' : decision === 'reject' ? 'reject' : 'check';
    const prompt = decision === 'approve'
      ? `Approve ${row.name} (${row.label || 'Standard'}) from ${row.expectedQuantity} to ${row.targetQuantity} units? This does NOT update the live website.`
      : decision === 'reject' ? 'Reject this stock adjustment request?' :
        'Check WooCommerce now and mark the request verified only when its current stock matches the approved quantity?';
    if (!window.confirm(prompt)) return;
    setBusy(row.id); setError('');
    try {
      const body = operation === 'review' ? { decision, note: (reviewNotes[row.id] || '').trim() } : {};
      await api(`/stock-adjustments/${row.id}/${operation}`, { method:'POST', body });
      await refreshQueue();
      if (config.mode === 'demo' && decision === 'approve') await refresh(true);
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }
  return <section className="surface records-surface" aria-label="Stock adjustment requests">
    <div className="section-heading">
      <div><span className="eyebrow">Inventory / staff accountability</span><h2>Stock adjustment requests</h2>
        <p>Staff request corrections; the owner approves or rejects each one. Every action stays in the POS audit trail.</p></div>
      <button className="button secondary" type="button" onClick={refreshQueue} disabled={Boolean(busy)}>
        <RefreshCw size={15}/> Refresh requests</button>
    </div>
    <Notice tone="warning"><strong>No live stock edits from this screen.</strong> Owner approval is a documented request,
      not a WooCommerce quantity update. For real stock, an owner must apply the change in WordPress
      and then select "Verify website balance". Demo approvals update demo stock only.</Notice>
    {error && <Notice tone="error">{error}</Notice>}
    <form className="form-stack" onSubmit={submit}>
      <label>Search items and variations
        <input className="input" value={lookup} onChange={event=>{setLookup(event.target.value);setSelected('');}}
          placeholder="Search outfit, size, SKU…"/></label>
      <label>Exact stock record
        <select className="select" required value={selected} onChange={e=>setSelected(e.target.value)}>
          <option value="">Select product and size</option>
          {candidates.map(option => <option key={option.key} value={option.key}>
            {option.name} · {option.label} · {option.sku || 'no SKU'} · {option.stock ?? 'unknown'} on hand
          </option>)}
        </select>
      </label>
      {item && <Notice>Catalogue reports <strong>{item.stock ?? 'unknown'}</strong> units.
        {item.stockSource === 'parent' ? ' This size uses shared parent stock. Separate size adjustments are blocked.' :
         ' The server will recheck exact WooCommerce stock before saving the request.'}</Notice>}
      <label>Correct counted quantity
        <input className="input" type="number" min="0" max="100000" step="1" required value={target}
          onChange={e=>setTarget(e.target.value)} placeholder="How many should be available?"/></label>
      <label>Reason
        <select className="select" value={reason} onChange={e=>setReason(e.target.value)}>
          {reasons.map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label>Explanation (required)
        <textarea className="input" value={note} onChange={e=>setNote(e.target.value)}
          minLength={8} maxLength={250} required rows={2}
          placeholder="e.g. Received 4 new blue dresses after physically counting the shelf"/></label>
      <button type="submit" className="button primary" disabled={Boolean(busy) || !item || catalog?.stale || Boolean(catalog?.error) ||
        !item.manageStock || item.stockSource === 'parent' || !Number.isSafeInteger(item.stock)}>
        {busy==='request' ? 'Submitting…' : 'Submit stock adjustment for owner review'}
      </button>
    </form>
    <div className="section-heading">
      <div><h3>{isOwner ? 'Staff requests and approvals' : 'Stock adjustment history'}</h3>
        <p>{isOwner ? 'Approve only after checking the physical stock and original request.' :
          'Cashiers see their own requests. Managers can review the queue but cannot approve.'}</p></div>
    </div>
    {!loaded ? <p role="status">Loading adjustment history…</p> : requests.length === 0 ?
      <p className="field-hint">No stock adjustment requests recorded yet.</p> :
      <TableRegion label="Stock adjustment request register"><table className="responsive-table">
        <thead><tr><th>Product and staff</th><th>Change</th><th>Reason</th><th>Status</th><th>Owner action</th></tr></thead>
        <tbody>{requests.map(row=><tr key={row.id}>
          <td data-label="Product"><strong>{row.name}</strong><small>{row.label || 'Standard'} · {row.sku || 'No SKU'} · {row.requesterName}</small>
            <small>{dateTime(row.createdAt)}</small></td>
          <td data-label="Change"><strong>{row.expectedQuantity} → {row.targetQuantity} units</strong></td>
          <td data-label="Reason"><strong>{reasons.find(([key])=>key===row.reason)?.[1] || row.reason}</strong><small>{row.note}</small></td>
          <td data-label="Status">{statuses[row.status] || row.status}
            {row.reviewedAt && <small>Owner reviewed {dateTime(row.reviewedAt)}</small>}</td>
          <td data-label="Owner action">{isOwner && row.status === 'pending' ? <div className="form-stack">
            <input className="input" value={reviewNotes[row.id]||''} onChange={e=>setReviewNotes(s=>({...s,[row.id]:e.target.value}))}
              maxLength={250} placeholder="Optional approval note / required rejection reason"/>
            <div className="row-actions"><button className="button primary small" type="button" disabled={Boolean(busy)}
              onClick={()=>act(row,'review','approve')}>Approve request</button>
            <button className="button secondary small" type="button" disabled={Boolean(busy) || (reviewNotes[row.id]||'').trim().length<8}
              onClick={()=>act(row,'review','reject')}>Reject</button></div>
          </div> : isOwner && row.status==='approved' ?
            <button className="button secondary small" type="button" disabled={Boolean(busy)}
              onClick={()=>act(row,'verify')}>Verify website balance</button> : <small>—</small>}
            {isOwner && row.status === 'approved' && <small>Edit the exact product/variation quantity in WooCommerce first.</small>}
          </td></tr>)}</tbody>
      </table></TableRegion>}
  </section>;
}
