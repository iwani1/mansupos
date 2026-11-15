import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, LockKeyhole } from 'lucide-react';
import { api, dateTime, money, uuid } from './api.js';
import { Badge, Notice, PageHeading, Stat, TableRegion } from './components.jsx';

const issueLabels = {
  cash_custody_unconfirmed: 'Cash custody; payment unconfirmed',
  cash_intent_unconfirmed: 'Cash intent; custody not evidenced',
  cash_refund_payout_unverified: 'Refund payout unverified',
  paid_evidence_incomplete: 'Paid status missing original verification',
  order_link_missing: 'Original Woo order not linked',
  unfinished_pos_order: 'Unfinished POS order',
};

const stepLabel = {
  verify_original_woo_order: 'Check original WooCommerce order',
  reconcile_pos_cash_custody: 'Reconcile original cash drawer',
  request_refund_payout_evidence: 'Request evidence of actual refund payout',
  escalate_financial_exception: 'Escalate unresolved financial exception',
};

function Evidence({ value, label }) {
  return <span className="method-label">{value ? 'POS evidence recorded' : 'Not evidenced'} · {label}</span>;
}

// Evidence only: do not load website customer orders, collect/refund money,
// alter a shift, change inventory, or infer bank settlement from a POS event.
export default function PaymentReconciliation({ user }) {
  const [cases, setCases] = useState([]);
  const [summary, setSummary] = useState(null);
  const [fullCount, setFullCount] = useState(0);
  const [cursor, setCursor] = useState(null);
  const [more, setMore] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(null);
  const [review, setReview] = useState(null);
  const [reviewError, setReviewError] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [selectedStep, setSelectedStep] = useState('');
  const [pendingKey, setPendingKey] = useState(null);
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

  const readReview = async (item) => {
    setReviewBusy(true); setReviewError('');
    try {
      const result = await api(`/payments/reconciliation/${encodeURIComponent(item.id)}/review`);
      if (result?.kind !== 'non-executing-finance-review' ||
          result.source !== 'local-pos-ledger' ||
          result.refundAuthorized !== false || result.refundExecuted !== false ||
          result.cashPaidOut !== false || result.stockRestored !== false ||
          result.gatewaySettlementVerified !== false || !Array.isArray(result.entries) ||
          !Array.isArray(result.availableSteps) || result.saleId !== item.id) {
        throw new Error('Financial review was not authenticated as non-executing POS evidence.');
      }
      setReview(result);
      setSelectedStep(current => result.availableSteps.includes(current) ?
        current : (result.availableSteps[0] || ''));
    } catch (failure) {
      setReview(null);
      setReviewError(failure.message || 'Could not validate original review evidence.');
    } finally { setReviewBusy(false); }
  };
  const openReview = async item => {
    if (selected?.id === item.id) {
      setSelected(null); setReview(null); setPendingKey(null); setReviewError('');
      return;
    }
    setSelected(item); setReview(null); setSelectedStep(''); setPendingKey(null);
    await readReview(item);
  };
  const recordRequest = async () => {
    if (!selected || !review?.actionsAvailable || !selectedStep) return;
    setReviewBusy(true); setReviewError('');
    const reviewKey = pendingKey || uuid();
    setPendingKey(reviewKey); // retry the same original request; never duplicate.
    try {
      const result = await api(`/payments/reconciliation/${encodeURIComponent(selected.id)}/review`, {
        method: 'POST', body: {
          reviewKey, step: selectedStep, expectedStatus: review.saleStatus,
          expectedUpdatedAt: review.saleUpdatedAt,
          expectedWooOrderId: review.wooOrderId,
        },
      });
      if (result.nonExecuting !== true || !result.entry?.eventId ||
          result.entry.refundExecuted !== false ||
          result.entry.cashPaidOut !== false || result.entry.stockRestored !== false) {
        throw new Error('Financial review request returned unsafe or incomplete evidence.');
      }
      setPendingKey(null);
      await readReview(selected);
    } catch (failure) {
      setReviewError(failure.message || 'The original review request needs verification; do not retry with a new key.');
    } finally { setReviewBusy(false); }
  };
  const acknowledge = async entry => {
    if (!selected || !review?.actionsAvailable || user?.role !== 'owner') return;
    setReviewBusy(true); setReviewError('');
    try {
      const result = await api(`/payments/reconciliation/${encodeURIComponent(selected.id)}/acknowledge`, {
        method: 'POST', body: {
          reviewKey: entry.reviewKey, requestEventId: entry.eventId,
          expectedStatus: review.saleStatus, expectedUpdatedAt: review.saleUpdatedAt,
        },
      });
      if (result.nonExecuting !== true || result.entry?.kind !== 'owner_acknowledgement' ||
          result.entry.refundAuthorized !== false || result.entry.cashPaidOut !== false) {
        throw new Error('Owner acknowledgement returned unsafe financial evidence.');
      }
      await readReview(selected);
    } catch (failure) {
      setReviewError(failure.message || 'Owner acknowledgement was not recorded.');
    } finally { setReviewBusy(false); }
  };

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
              <td data-label="Updated">{dateTime(item.updatedAt)}
                <button className="button secondary small" type="button" disabled={reviewBusy}
                  aria-expanded={selected?.id === item.id}
                  onClick={() => openReview(item)}>
                  {selected?.id === item.id ? 'Hide review' : 'Review evidence'}
                </button>
              </td>
            </tr>)}</tbody>
          </table>
        </TableRegion>}
      <div className="table-footer">
        <span>{note || 'Local POS evidence only. External settlement remains unverified.'}</span>
        {more && <button type="button" className="button secondary small" disabled={busy || !cursor}
          onClick={() => load(cursor)}>{busy ? 'Reading…' : 'Load more'}</button>}
      </div>
    </section>
    {selected && <section className="surface records-surface" aria-label="Original financial review">
      <div className="section-heading"><div>
        <span className="eyebrow">Original sale · {selected.number}</span>
        <h2>Documented investigation requests</h2>
        <p>Read-only in live mode. An acknowledgement is not payment, payout or refund authorization.</p>
      </div>
        <button className="button secondary small" type="button" disabled={reviewBusy}
          onClick={() => readReview(selected)}>
          <RefreshCw size={15}/>{reviewBusy ? 'Checking…' : 'Refresh review'}
        </button>
      </div>
      {reviewError && <Notice tone="error">{reviewError}</Notice>}
      {reviewBusy && <p role="status" className="field-hint">Checking original POS review events.</p>}
      {review && <>
        <Notice tone="warning">No refund approval, no physical cash payout, no Paystack settlement verification, and no stock restoration are possible here. These are investigation instructions only.</Notice>
        {review.entries.length === 0
          ? <p className="field-hint">No investigation instructions have been recorded for this original sale.</p>
          : <TableRegion label="Immutable financial investigation timeline">
            <table className="responsive-table records-sales"><thead>
              <tr><th>Recorded</th><th>Investigation</th><th>Actor</th><th>Owner action</th></tr>
            </thead><tbody>{review.entries.map(entry => {
              const hasAck = review.entries.some(other =>
                other.kind === 'owner_acknowledgement' && other.reviewKey === entry.reviewKey);
              return <tr key={entry.eventId}>
                <td data-label="Recorded">{dateTime(entry.createdAt)}</td>
                <td data-label="Investigation"><strong>{stepLabel[entry.step] || 'Unknown step'}</strong>
                  <small>{entry.kind === 'request' ? 'Investigation requested' : 'Owner acknowledged triage (NOT refund authorization)'}</small>
                </td>
                <td data-label="Actor">{entry.actorId}</td>
                <td data-label="Owner action">{entry.kind === 'request' && !hasAck &&
                  review.actionsAvailable && user?.role === 'owner' && entry.actorId !== user?.id
                  ? <button type="button" className="button secondary small" disabled={reviewBusy}
                    onClick={() => acknowledge(entry)}>Acknowledge review only</button>
                  : 'No financial action'}</td>
              </tr>;
            })}</tbody></table>
          </TableRegion>}
        {review.truncated && <Notice tone="warning">The review history is truncated. Audit the append-only POS events before relying on this record.</Notice>}
        {review.actionsAvailable && <div className="form-stack">
          <label>Next investigation step
            <select className="input" value={selectedStep}
              onChange={event => { setSelectedStep(event.target.value); setPendingKey(null); }}>
              {review.availableSteps.map(step => <option key={step} value={step}>
                {stepLabel[step] || step}
              </option>)}
            </select>
          </label>
          <button className="button secondary" type="button" disabled={reviewBusy || !selectedStep}
            onClick={recordRequest}>Record investigation request (demo only)</button>
        </div>}
      </>}
    </section>}
  </div>;
}
