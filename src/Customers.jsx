import React, { useEffect, useState } from 'react';
import { Gift, RefreshCw, Search, UserPlus, Users } from 'lucide-react';
import { api, dateTime, money } from './api.js';
import { Empty, Modal, Notice, PageHeading, Spinner, StatusBadge, TableRegion } from './components.jsx';
import { CustomerPicker } from './CustomerPicker.jsx';

const kindLabel = { earn: 'Earned on sale', redeem: 'Used at the till', redeem_returned: 'Given back (sale not completed)', return: 'Taken back (items returned)', adjust: 'Changed by owner' };

// Loyalty customers (phone-identified, points) and the private wholesale-buyer
// directory.
export default function Customers({ refreshKey, user, notify }) {
  const [tab, setTab] = useState('loyalty');
  return <div className="customers-page">
    <PageHeading eyebrow="Relationships" title="Customers" description="Shop customers who collect loyalty points (1 point per GH₵1; 100 points = GH₵1 off), and named wholesale buyers." />
    <div className="instore-tabs" role="tablist" aria-label="Customer lists">
      <button role="tab" aria-selected={tab === 'loyalty'} className={tab === 'loyalty' ? 'selected' : ''} onClick={() => setTab('loyalty')}><Gift size={15} />Loyalty customers</button>
      <button role="tab" aria-selected={tab === 'buyers'} className={tab === 'buyers' ? 'selected' : ''} onClick={() => setTab('buyers')}><Users size={15} />Wholesale buyers</button>
    </div>
    {tab === 'loyalty' ? <LoyaltyCustomers refreshKey={refreshKey} user={user} notify={notify} /> : <WholesaleBuyers refreshKey={refreshKey} />}
  </div>;
}

function LoyaltyCustomers({ refreshKey, user, notify }) {
  const [query, setQuery] = useState('');
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => api(`/customers?q=${encodeURIComponent(query.trim())}`)
      .then(r => { if (active) { setList(r.customers); setError(''); } }).catch(e => { if (active) setError(e.message); }), query ? 250 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [query, refreshKey, reload]);
  const totalPoints = (list || []).reduce((n, c) => n + c.points, 0);
  return <section className="surface records-surface">
    <div className="section-heading"><div><span className="eyebrow">Loyalty</span><h2>Shop customers</h2><p>{list ? `${list.length} shown · ${totalPoints} points outstanding (${money(totalPoints)})` : 'Loading…'}</p></div>
      <div className="heading-actions"><button className="button secondary" onClick={() => setReload(v => v + 1)}><RefreshCw size={16} />Refresh</button><button className="button primary" onClick={() => setAdding(true)}><UserPlus size={16} />Add customer</button></div></div>
    <div className="table-toolbar"><label className="search-field compact"><Search size={18} aria-hidden="true" /><input aria-label="Search customers" placeholder="Phone or name" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    {error && <Notice tone="error">{error}</Notice>}
    {list === null && !error ? <Spinner label="Loading customers…" /> : list?.length ? <TableRegion label="Loyalty customers"><table className="responsive-table customers-table"><thead><tr><th>Customer</th><th>Phone</th><th>Points</th><th>Visits</th><th>Spent</th><th>Last visit</th></tr></thead><tbody>
      {list.map(c => <tr key={c.id} className="clickable-row" onClick={() => setOpenId(c.id)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setOpenId(c.id); }}>
        <td data-label="Customer"><strong className="table-primary">{c.name}</strong></td><td data-label="Phone">{c.phone}</td>
        <td data-label="Points"><strong>{c.points}</strong> <small>({money(c.points)})</small></td><td data-label="Visits">{c.visits || 0}</td>
        <td data-label="Spent">{money(c.spent || 0)}</td><td data-label="Last visit">{c.lastVisit ? dateTime(c.lastVisit) : '—'}</td></tr>)}
    </tbody></table></TableRegion> : list && <Empty icon={Gift} title={query ? 'No matching customers' : 'No loyalty customers yet'}>{query ? 'Try another phone number or name.' : 'Add a customer from the till (tap “Walk-in customer”) or here.'}</Empty>}
    {adding && <CustomerPicker onClose={() => setAdding(false)} onPick={c => { setAdding(false); setReload(v => v + 1); setOpenId(c.id); notify?.(`${c.name} saved.`); }} />}
    {openId && <CustomerDetail id={openId} user={user} notify={notify} onClose={() => { setOpenId(null); setReload(v => v + 1); }} />}
  </section>;
}

function CustomerDetail({ id, user, notify, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [adjust, setAdjust] = useState({ points: '', note: '' });
  const [busy, setBusy] = useState(false);
  const load = () => api(`/customers/${id}`).then(d => { setData(d); setForm({ name: d.customer.name, phone: d.customer.phone, email: d.customer.email || '', note: d.customer.note || '' }); }).catch(e => setError(e.message));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const canEdit = ['owner', 'manager'].includes(user?.role);
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(`/customers/${id}`, { method: 'PATCH', body: form }); await load(); setEditing(false); notify?.('Customer updated.'); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function changePoints(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { const d = await api(`/customers/${id}/points`, { method: 'POST', body: { points: Number(adjust.points), note: adjust.note } }); setData(d); setAdjust({ points: '', note: '' }); notify?.('Points updated.'); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const c = data?.customer;
  return <Modal title={c ? c.name : 'Customer'} subtitle={c ? `${c.phone}${c.email ? ` · ${c.email}` : ''}` : ''} onClose={onClose} wide>
    <div className="modal-body customer-detail">
      {error && <Notice tone="error">{error}</Notice>}
      {!data ? <Spinner label="Loading customer…" /> : <>
        <div className="stats-grid four">
          <div className="stat-card featured"><div className="stat-top">Points</div><strong>{c.points}</strong><p>Worth {money(c.points)} · used in steps of 100</p></div>
          <div className="stat-card"><div className="stat-top">Visits</div><strong>{c.visits}</strong><p>Paid sales</p></div>
          <div className="stat-card"><div className="stat-top">Spent</div><strong className="stat-small">{money(c.spent)}</strong><p>After refunds</p></div>
          <div className="stat-card"><div className="stat-top">Last visit</div><strong className="stat-small">{c.lastVisit ? dateTime(c.lastVisit) : '—'}</strong><p>Customer since {dateTime(c.createdAt)}</p></div>
        </div>
        {c.note && <p className="field-hint">Note: {c.note}</p>}
        {canEdit && (editing ? <form className="form-stack customer-edit" onSubmit={save}>
          <label>Name<input className="input" required minLength={2} maxLength={80} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label>Phone<input className="input" required inputMode="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label>
          <label>Email<input className="input" type="email" maxLength={120} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
          <label>Note<input className="input" maxLength={250} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="e.g. prefers size M" /></label>
          <div className="form-actions"><button type="button" className="button secondary" onClick={() => setEditing(false)} disabled={busy}>Cancel</button><button className="button primary" disabled={busy}>Save</button></div>
        </form> : <button className="button secondary" onClick={() => setEditing(true)}>Edit details</button>)}
        <h3>Purchases</h3>
        {data.sales.length ? <TableRegion label="Purchases"><table className="responsive-table"><thead><tr><th>Receipt</th><th>Date</th><th>Status</th><th>Total</th><th>Points used</th></tr></thead><tbody>
          {data.sales.map(s => <tr key={s.id}><td data-label="Receipt">{s.number}</td><td data-label="Date">{dateTime(s.paidAt || s.createdAt)}</td><td data-label="Status"><StatusBadge status={s.status} /></td><td data-label="Total">{money(s.total - s.refunded)}</td><td data-label="Points used">{s.redeemedPoints || '—'}</td></tr>)}
        </tbody></table></TableRegion> : <p className="field-hint">No purchases yet.</p>}
        <h3>Points history</h3>
        {data.history.length ? <ul className="points-history">{data.history.map(h => <li key={h.id}><span><strong>{kindLabel[h.kind] || h.kind}</strong><small>{dateTime(h.createdAt)}{h.note ? ` · ${h.note}` : ''}</small></span><span className={h.points < 0 ? 'negative' : 'positive'}>{h.points > 0 ? '+' : ''}{h.points}</span><small>{h.balanceAfter}</small></li>)}</ul> : <p className="field-hint">No points yet.</p>}
        {user?.role === 'owner' && <form className="points-adjust" onSubmit={changePoints}>
          <h3>Change points by hand</h3>
          <p className="field-hint">For a paper loyalty card, a goodwill gesture or a correction. Use a minus sign to remove points. Every change is kept in the history with your name.</p>
          <div className="points-adjust-row"><input className="input" type="number" step="1" required aria-label="Points to add or remove" placeholder="e.g. 200 or -50" value={adjust.points} onChange={e => setAdjust({ ...adjust, points: e.target.value })} /><input className="input" required minLength={3} maxLength={250} aria-label="Reason" placeholder="Reason" value={adjust.note} onChange={e => setAdjust({ ...adjust, note: e.target.value })} /><button className="button secondary" disabled={busy}>Save</button></div>
        </form>}
      </>}
    </div>
  </Modal>;
}

// The private named wholesale-buyer directory (unchanged).
function WholesaleBuyers({ refreshKey }) {
  const [buyers, setBuyers] = useState(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let current = true;
    api('/wholesale-buyers')
      .then(result => { if (current) { setBuyers(result.buyers); setError(''); } })
      .catch(problem => { if (current) { setBuyers(null); setError(problem.message); } });
    return () => { current = false; };
  }, [refreshKey, reload]);
  const filtered = (buyers || []).filter(buyer => buyer.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <Notice>Buyer names are private POS records for approved wholesale use. Wholesale sales do not earn loyalty points.</Notice>
    {error && <Notice tone="error">Could not load buyers: {error}</Notice>}
    {buyers === null && !error ? <Spinner label="Loading named buyers…" /> : buyers && <section className="surface records-surface"><div className="section-heading"><div><span className="eyebrow">Private directory</span><h2>Named wholesale buyers</h2><p>Names already recorded in the POS ledger.</p></div><button className="button secondary" onClick={() => setReload(value => value + 1)}><RefreshCw size={16} />Refresh</button></div><div className="table-toolbar"><label className="search-field compact"><Search size={18} aria-hidden="true" /><input aria-label="Search named buyers" placeholder="Search by name" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      {filtered.length ? <TableRegion label="Named wholesale buyers"><table className="responsive-table customers-table"><thead><tr><th>Buyer</th><th>Record type</th><th>Added to this POS</th></tr></thead><tbody>{filtered.map(buyer => <tr key={buyer.id}><td data-label="Buyer"><strong className="table-primary">{buyer.name}</strong></td><td data-label="Record type">Named wholesale buyer</td><td data-label="Added to this POS">{dateTime(buyer.createdAt)}</td></tr>)}</tbody></table></TableRegion> : <Empty icon={Users} title={query ? 'No matching buyers' : 'No named buyers saved'} action={query && <button className="button secondary" onClick={() => setQuery('')}>Clear search</button>}>{query ? 'Try another name.' : 'Wholesale orders can still have an optional buyer name without creating a customer account.'}</Empty>}
      <div className="table-footer">{filtered.length} loaded records</div></section>}
  </>;
}
