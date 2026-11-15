import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, LockKeyhole } from 'lucide-react';
import { api, dateTime, money } from './api.js';
import { Badge, Notice, PageHeading, Stat, TableRegion } from './components.jsx';

const issueLabels = {
  cash_custody_unconfirmed: 'Cash custody; payment unconfirmed',
  cash_intent_unconfirmed: 'Cash intent; custody not evidenced',
  cash_refund_payout_unverified: 'Refund payout unverified',
  paid_evidence_incomplete: 'Paid status missing original verification',
  order_link_missing: 'Original Woo order not linked',
  unfinished_pos_order: 'Unfinished POS order',
};

function Evidence({ value, label }) {
  return <span className="method-label">{value ? 'POS evidence recorded' : 'Not evidenced'} · {label}</span>;
}

// Evidence only: do not load website customer orders, collect/refund money,
// alter a shift, change inventory, or infer bank settlement from a POS event.
export default function PaymentReconciliation() {
  const [cases, setCases] = useState([]);
  const [summary, setSummary] = useState(null);
  const [fullCount, setFullCount] = useState(0);
  const [cursor, setCursor] = useState(null);
  const [more, setMore] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async (after = '') => {
    setBusy(true);
    setError('');
    if (!after) {
      // Never retain stale POS financial evidence after a failed refresh.
      setCases([]); setSummary(null); setFullCount(0); setMore(false);
      setCursor(null); setLoaded(false);
    }
    try {
      const suffix = after ? `?limit=50&cursor=${encodeURIComponent(after)}` : '?limit=50';
      const response = await api(`/payments/reconciliation${suffix}`);
      if (response?.kind !== 'read-only-pos-payment-reconciliation' ||
          response.auditOnly !== true || response.checkoutAuthorized !== false ||
          response.mutationsAllowed !== false || response.source !== 'local-pos-ledger' ||
          response.websiteOrdersIncluded !== false ||
          response.gatewaySettlementVerified !== false ||
          response.refundPayoutVerified !== false ||
          !Array.isArray(response.cases) || !response.pageSummary ||
          !Number.isSafeInteger(response.fullCaseCount)) {
        throw new Error('The payment evidence source could not be verified.');
      }
      setCases(previous => after
        ? [...previous, ...response.cases.filter(item =>
          !previous.some(existing => existing.id === item.id))]
        : response.cases);
      setSummary(previous => after ? {
        cases: previous.cases + response.pageSummary.cases,
        urgentCases: previous.urgentCases + response.pageSummary.urgentCases,
        unconfirmedCashCustodyCents: previous.unconfirmedCashCustodyCents +
          response.pageSummary.unconfirmedCashCustodyCents,
        unverifiedCashRefundCents: previous.unverifiedCashRefundCents +
          response.pageSummary.unverifiedCashRefundCents,
      } : response.pageSummary);
      setFullCount(response.fullCaseCount);
      setCursor(response.nextCursor || null);
      setMore(Boolean(response.hasMore));
      setNote(response.notice);
      setLoaded(true);
    } catch (failure) {
      setError(failure.message || 'Payment evidence could not be loaded.');
      if (after) {
        // Already loaded rows are no longer a complete paginated view.
        setMore(false); setCursor(null);
      }
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  return <div className="sales-page">
    <PageHeading eyebrow="Operations / financial integrity" title="Payment reconciliation"
      description="Review POS ledger payment exceptions and evidence gaps. No settlement or refund actions are available.">
      <button type="button" className="button secondary" disabled={busy} onClick={() => load()}>
        <RefreshCw size={16}/>{busy ? 'Reading evidence…' : 'Refresh'}
      </button>
    </PageHeading>
    <Notice tone="warning"><LockKeyhole size={16}/> <strong>POS ledger only.</strong> This screen does not read the WooCommerce website order ledger or verify Paystack/bank settlement. It cannot confirm cash refund payouts, authorize fulfilment or unlock checkout.</Notice>
    {error && <Notice tone="error">{error}</Notice>}
    {busy && <p role="status" className="field-hint">Reading local POS evidence only; no remote payment or stock request.</p>}
    {summary && <div className="stats-grid">
      <Stat label="Cases on loaded pages" value={summary.cases}
        detail={more ? `${fullCount} total POS cases · more pages available` : `${fullCount} total POS cases`}/>
      <Stat label="Urgent on loaded pages" value={summary.urgentCases}
        detail="Review original Woo order and cash custody"/>
      <Stat label="Cash custody needing verification" value={money(summary.unconfirmedCashCustodyCents)}
        detail="POS ledger indication, not verified bank settlement"/>
      <Stat label="Refund evidence needing review" value={money(summary.unverifiedCashRefundCents)}
        detail="Woo refund amounts; physical payout unverified"/>
    </div>}
    <section className="surface records-surface" aria-label="Payment reconciliation cases">
      <div className="section-heading"><div>
        <span className="eyebrow">Read-only original-order evidence</span>
        <h2>Financial exceptions</h2>
        <p>{loaded ? `${cases.length} of ${fullCount} POS cases loaded` : 'Waiting for validated POS evidence'}.</p>
      </div></div>
      {loaded && !cases.length
        ? <Notice tone="warning">No local POS ledger exceptions were found. This does not mean all website payments, bank settlements, refunds or inventory are reconciled.</Notice>
        : cases.length > 0 && <TableRegion label="POS payment reconciliation records">
          <table className="responsive-table records-sales">
            <thead><tr><th>Original sale</th><th>Review priority</th><th>Local financial evidence</th><th>Woo order / shift</th><th>Updated</th></tr></thead>
            <tbody>{cases.map(item => <tr key={item.id}>
              <td data-label="Original sale">
                <strong className="table-primary">{item.number}</strong><small>{item.id}</small>
                <small>{item.status.replaceAll('_', ' ')}</small>
              </td>
              <td data-label="Review priority">
                <Badge tone={item.priority === 'urgent' ? 'red' : 'amber'}>
                  {item.priority === 'urgent' ? 'Urgent review' : 'Manual review'}
                </Badge>
                {(item.issueCodes || []).map(code =>
                  <small key={code}>{issueLabels[code] || 'Unknown payment evidence gap'}</small>)}
              </td>
              <td data-label="Local financial evidence">
                <small>Original total: {money(item.totalCents)}</small>
                <small>Refund on record: {money(item.refundedCents)}</small>
                <Evidence value={item.evidence.posCashCustodyRecorded} label="cash custody event"/>
                <Evidence value={item.evidence.posWooPaymentVerifiedEvent} label="Woo payment event"/>
                <small>External settlement: not verified</small>
              </td>
              <td data-label="Woo order / shift">
                <strong>{item.wooOrderId ? `#${item.wooOrderId}` : 'Unlinked'}</strong>
                <small>Shift: {item.originalShiftStatus || 'unknown'}</small>
                <small>{item.originalShiftId || 'No shift reference'}</small>
              </td>
              <td data-label="Updated">{dateTime(item.updatedAt)}</td>
            </tr>)}</tbody>
          </table>
        </TableRegion>}
      <div className="table-footer">
        <span>{note || 'Local POS evidence only. External settlement remains unverified.'}</span>
        {more && <button type="button" className="button secondary small" disabled={busy || !cursor}
          onClick={() => load(cursor)}>{busy ? 'Reading…' : 'Load more'}</button>}
      </div>
    </section>
  </div>;
}
