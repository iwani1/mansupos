/**
 * Phase 2.7: source-limited refund evidence worksheet, with no write methods.
 *
 * A Woo refund recorded in the local POS ledger is NOT proof that cash was
 * handed back or a gateway sent money. POS payment events are not bank proof.
 * Neither the refund decision nor physical stock return is automated here.
 */
import { AppError } from './errors.js';

const refundStatuses = new Set(['partially_refunded', 'refunded']);
const settledStatuses = new Set(['paid', ...refundStatuses]);
const paymentEvents = [
  'online.intent', 'online.payment_verified', 'online.cash_accepted',
  'online.cash_intent_started',
];

export function evaluateRefundEvidence(sale, events, proposedCents = null) {
  const seen = new Set(events);
  const total = sale.total;
  const recorded = sale.refunded;
  const totalsValid = Number.isSafeInteger(total) && total > 0 &&
    Number.isSafeInteger(recorded) && recorded >= 0 && recorded <= total;
  const remaining = totalsValid ? total - recorded : null;
  const proposalPresent = proposedCents !== null;
  if (proposalPresent &&
      (!Number.isSafeInteger(proposedCents) || proposedCents < 1 || proposedCents > 100000000)) {
    throw new AppError('The illustrative refund amount must be whole pesewas in an accepted range.', 400);
  }
  const withinRemaining = totalsValid && proposalPresent &&
    proposedCents <= remaining && remaining > 0;
  const recordedKind = !totalsValid ? 'inconsistent' :
    recorded === 0 ? 'none' :
      recorded === total ? 'full' : 'partial';
  const observedPaidRecord = Boolean(sale.paid_at) &&
    settledStatuses.has(sale.status);
  const isOnlinePos = seen.has('online.intent');
  const paymentEvidenceLocal = observedPaidRecord &&
    (!isOnlinePos || seen.has('online.payment_verified'));
  const invalidStatus = refundStatuses.has(sale.status) &&
    (recordedKind === 'none' || recordedKind === 'inconsistent');
  const mismatchedRefundState = recorded > 0 && sale.status === 'paid';
  const noOriginalOrder = !Number.isSafeInteger(sale.woo_order_id) || sale.woo_order_id < 1;
  const mismatch = invalidStatus || mismatchedRefundState;
  const checks = [
    {
      code: 'original_order_link', observed: !noOriginalOrder,
      requirement: 'Identify the original WooCommerce order; verify its current status on an authorized site',
    },
    {
      code: 'local_pos_payment_evidence', observed: paymentEvidenceLocal,
      requirement: 'Confirm the original POS payment record and original drawer or gateway transaction',
    },
    {
      code: 'refund_amount_consistency', observed: totalsValid && !mismatch &&
        (!proposalPresent || withinRemaining),
      requirement: 'Reconcile cumulative observed Woo refunds and proposed amount against the original order total',
    },
    {
      code: 'customer_refund_entitlement', observed: false,
      requirement: 'Verify customer identity, original purchase, return policy and rightful refund recipient',
    },
    {
      code: 'external_settlement_and_prior_payout', observed: false,
      requirement: 'Independently verify settlement and any prior cash/bank/Paystack refund before issuing another payment',
    },
    {
      code: 'refund_approval_and_disbursement', observed: false,
      requirement: 'Obtain an independently approved refund decision and separate verified payout evidence',
    },
    {
      code: 'goods_return_and_inspection', observed: false,
      requirement: 'If goods are to be returned, physically receive and inspect the exact variation and quantity',
    },
    {
      code: 'stock_restoration_authorization', observed: false,
      requirement: 'Only after verified physical return and an approved Woo stock-owner decision may stock be restored',
    },
  ];
  const warnings = [];
  if (!totalsValid) warnings.push('invalid_original_or_refund_total');
  if (invalidStatus || mismatchedRefundState) warnings.push('woo_refund_state_inconsistent');
  if (noOriginalOrder) warnings.push('original_woo_order_unknown');
  if (!paymentEvidenceLocal) warnings.push('local_payment_evidence_incomplete');
  if (proposalPresent && !withinRemaining) warnings.push('proposal_exceeds_observed_remaining_or_invalid');
  if (recorded > 0 && sale.payment_method === 'cash') {
    warnings.push('recorded_woo_cash_refund_does_not_prove_physical_payout');
  }
  return {
    kind: 'read-only-refund-evidence-policy',
    source: 'local-pos-ledger', websiteOrdersIncluded: false,
    auditOnly: true, mutationsAllowed: false, checkoutAuthorized: false,
    refundAuthorized: false, refundExecuted: false,
    cashPayoutVerified: false, gatewaySettlementVerified: false,
    stockRestored: false, returnInspected: false, fulfilmentAuthorized: false,
    saleId: sale.id, saleNumber: sale.number,
    wooOrderId: sale.woo_order_id, saleStatus: sale.status,
    paymentMethod: sale.payment_method, originalShiftId: sale.shift_id,
    originalTotalCents: total, observedWooRefundCents: recorded,
    observedRemainingCents: remaining, recordedRefundKind: recordedKind,
    hypotheticalNewRefundCents: proposedCents,
    proposalWithinObservedRemaining: Boolean(withinRemaining),
    hypotheticalBalanceAfterCents: withinRemaining ? remaining - proposedCents : null,
    localPosPaymentEvent: seen.has('online.payment_verified'),
    localCashCustodyEvent: seen.has('online.cash_accepted'),
    posPaymentEvidenceObserved: Boolean(paymentEvidenceLocal),
    checks, warnings,
    decision: 'manual_review_only',
    notice: 'Amounts are a local POS/Woo observation and hypothetical arithmetic, NOT refund eligibility, bank settlement or cash payout proof. Manual Owner/Manager reconciliation and separate approval are mandatory. Never automatically issue, repeat, or approve refunds; do not restock goods without verified physical return and correct Woo stock ownership.',
  };
}

export function refundEvidencePolicy(db, saleId, proposedCents = null) {
  const sale = db.prepare(
    'SELECT id,number,woo_order_id,status,payment_method,total,refunded,paid_at,shift_id ' +
    'FROM sales WHERE id=?'
  ).get(saleId);
  if (!sale) throw new AppError('Original POS sale was not found.', 404, 'REFUND_EVIDENCE_NOT_FOUND');
  const events = db.prepare(
    'SELECT DISTINCT event FROM sale_events WHERE sale_id=? AND event IN (?,?,?,?)'
  ).all(saleId, ...paymentEvents).map(row => row.event);
  return evaluateRefundEvidence(sale, events, proposedCents);
}
