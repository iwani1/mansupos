/**
 * Phase 2.5: read-only POS-ledger payment evidence. This has NO Woo order
 * queries, Paystack settlement claims, refund approvals or write methods.
 * The read-only catalogue pilot must not acquire a Woo order-read credential.
 */
import { AppError } from './errors.js';

const priority = ['cash_custody_unconfirmed', 'cash_intent_unconfirmed',
  'cash_refund_payout_unverified', 'paid_evidence_incomplete',
  'order_link_missing', 'unfinished_pos_order'];

function flags(row) {
  const cashAccepted = Boolean(row.cash_accepted_event);
  const cashIntent = Boolean(row.cash_intent_event);
  const originalAttempt = Boolean(row.online_intent_event);
  const paymentVerifiedEvent = Boolean(row.payment_verified_event);
  const uncertain = ['creating', 'needs_reconciliation', 'awaiting_payment'].includes(row.status);
  return {
    cash_custody_unconfirmed: cashAccepted && (uncertain || !row.paid_at),
    cash_intent_unconfirmed: cashIntent && !cashAccepted && (uncertain || !row.paid_at),
    // A POS customer return records its cash out on a shift; only the rest is unproven.
    cash_refund_payout_unverified: row.payment_method === 'cash' && row.refunded > (row.cash_refund_recorded || 0),
    paid_evidence_incomplete: originalAttempt && (row.status === 'paid' ||
      row.status === 'partially_refunded' || row.status === 'refunded') &&
      (!row.paid_at || !paymentVerifiedEvent),
    order_link_missing: originalAttempt && !row.woo_order_id,
    unfinished_pos_order: uncertain,
  };
}

const commonSql = `
  WITH event_flags AS (
    SELECT sale_id,
      MAX(CASE WHEN event='online.intent' THEN 1 ELSE 0 END) AS online_intent_event,
      MAX(CASE WHEN event='online.cash_intent_started' THEN 1 ELSE 0 END) AS cash_intent_event,
      MAX(CASE WHEN event='online.cash_accepted' THEN 1 ELSE 0 END) AS cash_accepted_event,
      MAX(CASE WHEN event='online.payment_verified' THEN 1 ELSE 0 END) AS payment_verified_event
    FROM sale_events
    WHERE event IN ('online.intent','online.cash_intent_started','online.cash_accepted','online.payment_verified')
    GROUP BY sale_id
  ), evidence AS (
    SELECT s.id, s.number, s.status, s.woo_order_id, s.payment_method,
      s.total, s.refunded, s.paid_at, s.shift_id, s.updated_at,
      sh.status AS original_shift_status,
      COALESCE(ef.online_intent_event,0) AS online_intent_event,
      COALESCE(ef.cash_intent_event,0) AS cash_intent_event,
      COALESCE(ef.cash_accepted_event,0) AS cash_accepted_event,
      COALESCE(ef.payment_verified_event,0) AS payment_verified_event,
      __CASH_REFUND_RECORDED__ AS cash_refund_recorded
    FROM sales s
    LEFT JOIN shifts sh ON sh.id=s.shift_id
    LEFT JOIN event_flags ef ON ef.sale_id=s.id
  )
  SELECT * FROM evidence
  WHERE (
    status IN ('creating','awaiting_payment','needs_reconciliation')
    OR (refunded > cash_refund_recorded AND payment_method='cash')
    OR (cash_accepted_event=1 AND paid_at IS NULL)
    OR (cash_intent_event=1 AND cash_accepted_event=0 AND paid_at IS NULL)
    OR (online_intent_event=1 AND woo_order_id IS NULL)
    OR (online_intent_event=1 AND status IN ('paid','partially_refunded','refunded')
      AND (paid_at IS NULL OR payment_verified_event=0))
  )
`;

// Older ledgers (and isolated tests) may not have the returns table yet.
function evidenceSql(db) {
  const returns = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_returns'").get();
  return commonSql.replace('__CASH_REFUND_RECORDED__', returns
    ? 'COALESCE((SELECT SUM(cr.refund_total) FROM customer_returns cr WHERE cr.sale_id=s.id AND cr.cash_recorded=1),0)' : '0');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof data.updatedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(data.updatedAt) ||
        data.updatedAt.length > 40 ||
        typeof data.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(data.id)) throw new Error('Invalid');
    return data;
  } catch {
    throw new AppError('Invalid payment reconciliation cursor.', 400);
  }
}

function presentCase(row) {
    const found = flags(row);
    const issues = priority.filter(key => found[key]);
    return {
      id: row.id, number: row.number, wooOrderId: row.woo_order_id,
      status: row.status, paymentMethod: row.payment_method,
      originalShiftId: row.shift_id, originalShiftStatus: row.original_shift_status || null,
      totalCents: row.total, refundedCents: row.refunded,
      paidAt: row.paid_at, updatedAt: row.updated_at,
      issueCodes: issues, priority: found.cash_custody_unconfirmed ||
        found.paid_evidence_incomplete ? 'urgent' : 'review',
      evidence: {
        originalOnlinePosAttempt: Boolean(row.online_intent_event),
        cashIntentRecorded: Boolean(row.cash_intent_event),
        posCashCustodyRecorded: Boolean(row.cash_accepted_event),
        posWooPaymentVerifiedEvent: Boolean(row.payment_verified_event),
        gatewaySettlementVerified: false,
        externalCashRefundPaidVerified: false,
      },
      cashCustodyAtRiskCents: found.cash_custody_unconfirmed ? row.total : 0,
      cashRefundEvidenceCents: found.cash_refund_payout_unverified ? row.refunded - (row.cash_refund_recorded || 0) : 0,
    };
}

export function paymentReconciliationCase(db, saleId) {
  const common = evidenceSql(db);
  const row = db.prepare('SELECT * FROM (' + common + ') WHERE id=?').get(saleId);
  return row ? presentCase(row) : null;
}

export function paymentReconciliation(db, { limit = 50, cursor } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError('Invalid payment reconciliation page limit.', 400);
  }
  const after = decodeCursor(cursor);
  const filter = after ? ' AND (updated_at < ? OR (updated_at = ? AND id < ?))' : '';
  const params = after ? [after.updatedAt, after.updatedAt, after.id] : [];
  // The count is POS ledger cases only, not a bank balance or merchant-wide
  // gateway settlement figure. All cases use one original sale ID.
  const common = evidenceSql(db);
  const count = db.prepare('SELECT COUNT(*) AS cases FROM (' + common + ')').get().cases;
  const rows = db.prepare(common + filter +
    ' ORDER BY updated_at DESC,id DESC LIMIT ?').all(...params, limit + 1);
  const page = rows.slice(0, limit);
  const cases = page.map(presentCase);
  const last = page.at(-1);
  return {
    kind: 'read-only-pos-payment-reconciliation',
    auditOnly: true, checkoutAuthorized: false, mutationsAllowed: false,
    source: 'local-pos-ledger', websiteOrdersIncluded: false,
    gatewaySettlementVerified: false, refundPayoutVerified: false,
    fullCaseCount: count,
    // Per-page amounts only. Do NOT present as whole-business liabilities,
    // full-ledger totals, bank settlement, or verified cash payout.
    pageSummary: {
      cases: cases.length,
      urgentCases: cases.filter(item => item.priority === 'urgent').length,
      unconfirmedCashCustodyCents: cases.reduce((n, item) => n + item.cashCustodyAtRiskCents, 0),
      unverifiedCashRefundCents: cases.reduce((n, item) => n + item.cashRefundEvidenceCents, 0),
    },
    cases,
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({
      updatedAt: last.updated_at, id: last.id,
    })).toString('base64url') : null,
    notice: 'This is an evidence-only view of POS ledger exceptions. Website Paystack orders and bank settlement are NOT included. POS cash intent is not custody, Woo payment status is not external settlement, and a Woo refund is not proof of a physical payout. Reconcile the original order and cash drawer with an authorized Owner/Manager; no automatic refund, stock adjustment or new cash collection.',
  };
}
