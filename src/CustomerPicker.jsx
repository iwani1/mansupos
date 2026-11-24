import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Gift, Search, UserPlus, UserRound, X } from 'lucide-react';
import { api, money } from './api.js';
import { Modal, Notice } from './components.jsx';

export const REDEEM_STEP = 100; // 100 points = GH₵1.00 off

// The customer strip in the till cart: walk-in by default, or a loyalty
// customer found by phone/name (or added on the spot) with optional points.
export function CustomerStrip({ customer, redeemPoints, onChange, total, disabled }) {
  const [open, setOpen] = useState(false);
  const maxPoints = customer ? Math.max(0, Math.min(customer.points, total - 100)) : 0;
  const steps = Math.floor(maxPoints / REDEEM_STEP);
  if (!customer) return <>
    <button type="button" className="customer-strip customer-strip-button" onClick={() => setOpen(true)} disabled={disabled}>
      <span className="customer-avatar"><UserRound size={18} /></span>
      <div><strong>Walk-in customer</strong><span>Add a customer to give loyalty points</span></div><UserPlus size={17} />
    </button>
    {/* Portal: the cart panel is its own stacking context. */}
    {open && createPortal(<CustomerPicker onClose={() => setOpen(false)} onPick={c => { onChange(c, 0); setOpen(false); }} />, document.body)}
  </>;
  return <div className="customer-strip customer-selected">
    <span className="customer-avatar filled">{customer.name.slice(0, 1).toUpperCase()}</span>
    <div><strong>{customer.name}</strong><span>{customer.phone} · {customer.points} points</span></div>
    <button type="button" className="icon-button" aria-label="Remove customer from this sale" onClick={() => onChange(null, 0)} disabled={disabled}><X size={16} /></button>
    {customer.points >= REDEEM_STEP && <div className="customer-points">
      <label htmlFor="redeem-points"><Gift size={14} aria-hidden="true" /> Use points</label>
      <select id="redeem-points" className="select" value={redeemPoints} onChange={e => onChange(customer, Number(e.target.value))} disabled={disabled || !steps}>
        <option value={0}>Don’t use points</option>
        {Array.from({ length: Math.min(steps, 200) }, (_, i) => (i + 1) * REDEEM_STEP).reverse().map(p => <option key={p} value={p}>{p} points · {money(p)} off</option>)}
      </select>
    </div>}
  </div>;
}

export function CustomerPicker({ onClose, onPick }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api(`/customers?q=${encodeURIComponent(query.trim())}`).then(r => { if (active) { setResults(r.customers); setError(''); } }).catch(e => { if (active) setError(e.message); });
    }, query ? 250 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);
  async function create(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try { const { customer } = await api('/customers', { method: 'POST', body: form }); onPick(customer); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const startAdding = () => { setAdding(true); setForm({ name: /\d/.test(query) ? '' : query.trim(), phone: /\d/.test(query) ? query.trim() : '', email: '' }); };
  return <Modal title={adding ? 'New customer' : 'Find a customer'} subtitle={adding ? 'They earn 1 point for every GH₵1 they spend.' : 'Search by phone number or name.'} onClose={onClose}>
    <div className="modal-body customer-picker">
      {error && <Notice tone="error">{error}</Notice>}
      {!adding ? <>
        <label className="search-field"><Search size={18} aria-hidden="true" /><input ref={inputRef} aria-label="Phone or name" placeholder="024 412 3456 or Akosua" value={query} onChange={e => setQuery(e.target.value)} inputMode="search" /></label>
        <div className="customer-results" role="list">
          {results === null ? <p className="field-hint">Loading…</p> : results.length ? results.slice(0, 12).map(c => <button type="button" role="listitem" key={c.id} className="customer-result" onClick={() => onPick(c)}>
            <span className="customer-avatar filled">{c.name.slice(0, 1).toUpperCase()}</span>
            <span><strong>{c.name}</strong><small>{c.phone}{c.visits ? ` · ${c.visits} ${c.visits === 1 ? 'visit' : 'visits'}` : ''}</small></span>
            <span className="customer-result-points">{c.points}<small>points</small></span>
          </button>) : <p className="field-hint">{query ? 'No customer found.' : 'No customers yet.'}</p>}
        </div>
        <button type="button" className="button secondary" onClick={startAdding}><UserPlus size={16} />Add a new customer</button>
      </> : <form className="form-stack" onSubmit={create}>
        <label>Phone number<input className="input" required inputMode="tel" autoComplete="off" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="024 412 3456" /></label>
        <label>Name<input className="input" required minLength={2} maxLength={80} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Akosua Mensah" /></label>
        <label>Email (optional)<input className="input" type="email" maxLength={120} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
        <p className="field-hint">Ask the customer before saving their details. They are kept in the POS and shown on their WooCommerce order.</p>
        <div className="form-actions"><button type="button" className="button secondary" onClick={() => setAdding(false)} disabled={busy}>Back to search</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save and add to sale'}</button></div>
      </form>}
    </div>
  </Modal>;
}
