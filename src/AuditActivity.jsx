import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api, dateTime } from './api.js';
import { Badge, Empty, Notice, PageHeading, TableRegion } from './components.jsx';

const initialFilters = { search:'', category:'all', period:'30d' };
const categoryNames = {
  all:'All actions',auth:'Sign-ins and account security',
  staff:'Staff management',shift:'Cash shifts and drawer',wholesale:'Wholesale',
};
const statusFor = action => action.startsWith('auth.') ? 'amber' :
  action.startsWith('staff.') ? 'red' : 'neutral';

// POS owner evidence only: all filters execute on the server-side audit query.
// Never persist this sensitive activity in browser storage or export it.
export default function AuditActivity() {
  const [draft,setDraft] = useState(initialFilters);
  const [applied,setApplied] = useState(initialFilters);
  const [events,setEvents] = useState([]);
  const [cursor,setCursor] = useState(null);
  const [hasMore,setHasMore] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [loaded,setLoaded] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async (filters, nextCursor = null) => {
    const id = ++requestId.current;
    setBusy(true); setError('');
    if(nextCursor === null) {
      // A failed refresh never leaves old evidence looking like fresh results.
      setEvents([]); setCursor(null); setHasMore(false); setLoaded(false);
    }
    try {
      const params = new URLSearchParams({
        limit:'100',category:filters.category,period:filters.period,
      });
      if(filters.search.trim()) params.set('search',filters.search.trim());
      if(nextCursor !== null) params.set('cursor',String(nextCursor));
      const response = await api('/audit?' + params.toString());
      if (response?.kind !== 'owner-local-pos-audit-history' ||
          response.source !== 'local-pos-ledger' ||
          response.readOnly !== true || response.websiteAuditIncluded !== false ||
          !Array.isArray(response.events) || typeof response.hasMore !== 'boolean' ||
          !(response.nextCursor === null ||
            Number.isSafeInteger(response.nextCursor) && response.nextCursor > 0) ||
          (response.hasMore && response.nextCursor === null)) {
        throw new Error('The audit history source could not be verified.');
      }
      if(id !== requestId.current) return;
      setEvents(previous => nextCursor === null ? response.events :
        [...previous,...response.events.filter(row =>
          !previous.some(loadedRow => loadedRow.id === row.id))]);
      setCursor(response.nextCursor);
      setHasMore(response.hasMore);
      setLoaded(true);
    } catch (failure) {
      if(id !== requestId.current) return;
      setError(failure.message || 'Audit history could not be loaded.');
      if(nextCursor !== null) { setCursor(null); setHasMore(false); }
    } finally { if(id === requestId.current) setBusy(false); }
  }, []);

  useEffect(() => {
    void load(initialFilters);
    return () => { requestId.current++; };
  }, [load]);

  const applyFilters = e => {
    e.preventDefault();
    const next={...draft,search:draft.search.trim()};
    setApplied(next);
    void load(next);
  };
  const clearFilters = () => {
    setDraft(initialFilters);
    setApplied(initialFilters);
    void load(initialFilters);
  };
  const filtered = applied.search || applied.category !== 'all' || applied.period !== 'all';
  return <div className="sales-page">
    <PageHeading eyebrow="Administration / accountability" title="Audit log"
      description="Review staff access, shift activity and POS changes across the local ledger. Only the Owner can open this history.">
      <button type="button" className="button secondary" disabled={busy}
        onClick={() => load(applied)}>
        <RefreshCw size={16} className={busy ? 'spin' : ''}/>{busy ? 'Checking…' : 'Refresh'}
      </button>
    </PageHeading>
    <Notice tone="warning">
      This is your POS activity history, not a verification of WooCommerce orders,
      website payments, physical cash or independently stored audit evidence.
      Review suspicious activity alongside the original transaction and shift records.
    </Notice>
    <section className="surface records-surface">
      <div className="section-heading"><div><span className="eyebrow">Owner review</span>
        <h2>Find staff activity</h2>
        <p>Search the full POS audit history using the filters below, not just currently loaded rows.</p>
      </div><ShieldCheck size={20} aria-hidden="true"/></div>
      <form className="audit-review-filters" onSubmit={applyFilters} role="search">
        <label>Staff, action or reference
          <span className="audit-search-input"><Search size={16} aria-hidden="true"/>
            <input className="input" type="search" placeholder="e.g. staff, login, reference"
              maxLength={80} value={draft.search}
              onChange={e=>setDraft(previous=>({...previous,search:e.target.value}))}/>
          </span>
        </label>
        <label>Activity type
          <select className="input" value={draft.category}
            onChange={e=>setDraft(previous=>({...previous,category:e.target.value}))}>
            {Object.entries(categoryNames).map(([value,label])=>
              <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>Time range
          <select className="input" value={draft.period}
            onChange={e=>setDraft(previous=>({...previous,period:e.target.value}))}>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All recorded history</option>
          </select>
        </label>
        <div className="audit-review-actions">
          <button type="submit" className="button primary" disabled={busy}>
            <Search size={16} aria-hidden="true"/>Search activity</button>
          <button type="button" className="button secondary" disabled={busy}
            onClick={clearFilters}>Clear</button>
        </div>
      </form>
    </section>
    {error && <Notice tone="error" role="alert">{error} {loaded ? 'Previously loaded results may be incomplete.' : 'No results were verified.'}</Notice>}
    <section className="surface records-surface">
      <div className="section-heading"><div><span className="eyebrow">POS ledger events</span>
        <h2>Activity history</h2>
        <p>{loaded ? <>{events.length} {events.length===1?'event':'events'} loaded
          {hasMore ? ' · older events available' : ' · end of matching history'}
          {filtered ? ' · current filters applied' : ''}</> :
          busy ? 'Checking audit history…' : 'No verified audit results loaded'}</p>
      </div><Badge tone="neutral">Owner only</Badge></div>
      {loaded && !events.length ?
        <Empty icon={ShieldCheck} title="No matching activity">
          Try a broader date range or clear your search. This does not prove no activity occurred outside this POS.
        </Empty> :
        <TableRegion label="Staff activity history"><table className="responsive-table records-audit">
          <thead><tr><th>Time</th><th>Staff account</th><th>Recorded action</th><th>Subject / reference</th></tr></thead>
          <tbody>{events.map(event=><tr key={event.id}>
            <td data-label="Time">{dateTime(event.createdAt)}</td>
            <td data-label="Staff account">{event.actorName || 'Unknown'}</td>
            <td data-label="Recorded action">
              <Badge tone={statusFor(event.action)}>{event.action}</Badge>
            </td>
            <td data-label="Subject / reference" className="audit-subject">{event.subject}</td>
          </tr>)}</tbody>
        </table></TableRegion>}
      <div className="table-footer">
        <span>Search is read-only. Staff activities outside this POS are not included.</span>
        {hasMore && <button type="button" className="button secondary small"
          disabled={busy || !cursor} onClick={()=>load(applied,cursor)}>
          {busy ? 'Loading older…' : 'Load older events'}
        </button>}
      </div>
    </section>
  </div>;
}
