import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, dateTime, money } from './api.js';
import { Badge, Notice, PageHeading, TableRegion } from './components.jsx';

// Manager/owner observation only: do not mutate Woo, money or shifts here.
export default function RecoveryQueue() {
  const [records, setRecords] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = useCallback(async (after = '') => {
    setBusy(true); setError('');
    try {
      const suffix = after ? `?limit=50&cursor=${encodeURIComponent(after)}` : '?limit=50';
      const data = await api(`/recovery/queue${suffix}`);
      if (!Array.isArray(data.sales)) throw new Error('Incomplete recovery response.');
      setRecords(old => after
        ? [...old, ...data.sales.filter(item => !old.some(previous => previous.id === item.id))]
        : data.sales);
      setCursor(data.nextCursor || null);
      setMore(Boolean(data.hasMore));
      setNote(data.note || '');
    } catch (failure) {
      setError(failure.message || 'The recovery queue could not be loaded.');
    } finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return <div className="sales-page">
    <PageHeading eyebrow="Operations / financial integrity" title="Recovery queue"
      description="Review original POS orders and cash exceptions. This page cannot collect cash, cancel orders, change inventory or edit shifts.">
      <button className="button secondary" type="button" disabled={busy} onClick={() => load()}>
        <RefreshCw size={16}/>{busy ? 'Checking…' : 'Refresh'}
      </button>
    </PageHeading>
    <Notice tone="warning">Do not collect cash again, cancel an uncertain order or release goods from this screen. Verify the original WooCommerce order. A Woo refund does not prove a physical cash payout.</Notice>
    {error && <Notice tone="error">{error}</Notice>}
    <section className="surface records-surface">
      <div className="section-heading"><div><span className="eyebrow">Original ledger exceptions</span>
        <h2>Orders needing review</h2><p>{records.length} records loaded{more ? ' · more available' : ''}.</p></div></div>
      {!records.length && !busy && !error
        ? <p className="field-hint">No exceptions in this POS ledger. Website orders are not included.</p>
        : <TableRegion label="Recovery exceptions"><table className="responsive-table records-sales">
          <thead><tr><th>Sale</th><th>Updated</th><th>Exception</th><th>Original shift</th><th>Woo order</th></tr></thead>
          <tbody>{records.map(record => <tr key={record.id}>
            <td data-label="Sale"><strong className="table-primary">{record.number}</strong><small>{record.id}</small></td>
            <td data-label="Updated">{dateTime(record.updatedAt)}</td>
            <td data-label="Exception">{record.cashCustodyUnresolved
              ? <><Badge tone="red">Cash held; Woo unverified</Badge><small>{money(record.cashHeldCents)} already counted; never recollect</small></>
              : record.cashIntentAwaitingReview
                ? <><Badge tone="red">Cash intent requires review</Badge><small>Intent started; no POS cash-custody event recorded. Verify the original Woo order and physical drawer.</small></>
                : record.cashPayoutUnverified
                  ? <><Badge tone="amber">Cash payout not verified</Badge><small>Woo refund {money(record.refundedCents)} is not cash disbursement</small></>
                  : <Badge tone={record.status === 'needs_reconciliation' ? 'red' : 'amber'}>{record.status.replaceAll('_', ' ')}</Badge>}</td>
            <td data-label="Original shift">{record.originalShiftId
              ? <><strong>{record.originalShiftStatus || 'Unknown'}</strong><small>{record.originalShiftId}</small></>
              : 'Not recorded'}</td>
            <td data-label="Woo order">{record.wooOrderId ? `#${record.wooOrderId}` : 'Not linked'}</td>
          </tr>)}</tbody>
        </table></TableRegion>}
      <div className="table-footer"><span>{note || 'Separate approval is required for actual corrections.'}</span>
        {more && <button type="button" className="button secondary small" disabled={busy || !cursor}
          onClick={() => load(cursor)}>{busy ? 'Loading…' : 'Load more'}</button>}
      </div>
    </section>
  </div>;
}
