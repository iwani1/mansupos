/**
 * Phase 2.9 — offline-only, source-bound Woo/Paystack settlement comparator.
 *
 * Does NOT contact, authenticate or trust any external service, and cannot
 * authorize money, goods, order status, inventory or refunds. Callers must
 * independently obtain and authenticate original Woo, Paystack and settlement
 * evidence; none of this module's result is financial proof on its own.
 * Never expose raw payment references, names, bank account details or tokens.
 */
const cents = value => Number.isSafeInteger(value) && value >= 0;
const amount = value => Number.isSafeInteger(value) && value > 0;
const reference = value => typeof value === 'string' &&
  value.length >= 8 && value.length <= 256 && /^[a-zA-Z0-9_.-]+$/.test(value);

const unique = rows => new Set(rows).size === rows.length;
const paid = new Set(['processing', 'completed', 'refunded']);

export function compareSettlementEvidence({ woo = null, gateway = null,
  settlement = null, gatewayRefunds = null, relatedWooOrders = [] } = {}) {
  const issues = [];
  const add = issue => { if (!issues.includes(issue)) issues.push(issue); };
  const validWoo = Boolean(woo &&
    Number.isSafeInteger(woo.orderId) && woo.orderId > 0 &&
    amount(woo.totalCents) && cents(woo.refundedCents) &&
    woo.refundedCents <= woo.totalCents && woo.currency === 'GHS' &&
    woo.paymentMethod === 'paystack' && reference(woo.originalReference) &&
    typeof woo.status === 'string');
  if (!validWoo) add('original_woo_order_evidence_invalid_or_missing');

  const validGateway = Boolean(gateway && reference(gateway.reference) &&
    amount(gateway.amountCents) && gateway.currency === 'GHS' &&
    typeof gateway.status === 'string' && gateway.status.length <= 40 &&
    Number.isSafeInteger(gateway.transactionId) && gateway.transactionId > 0);
  if (!validGateway) add('gateway_verification_record_invalid_or_missing');

  if (validWoo && !paid.has(woo.status)) {
    add('original_woo_order_not_recorded_paid');
  }
  if (validGateway && gateway.status !== 'success') {
    add('gateway_transaction_not_reported_successful');
  }
  if (validWoo && validGateway) {
    if (woo.originalReference !== gateway.reference) {
      add('gateway_reference_does_not_match_original_woo_attempt');
    }
    if (woo.totalCents !== gateway.amountCents) {
      add('original_order_and_gateway_gross_amount_disagree');
    }
    if (relatedWooOrders.some(row => row &&
        row.orderId !== woo.orderId &&
        row.originalReference === woo.originalReference)) {
      add('gateway_reference_claimed_by_another_woo_order');
    }
  }

  let refundedGatewayCents = null;
  if (Array.isArray(gatewayRefunds)) {
    const ids = gatewayRefunds.map(r => r && r.refundId);
    if (!unique(ids) || ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
      add('duplicate_or_invalid_gateway_refund_identifiers');
    }
    let total = 0;
    let valid = true;
    for (const refund of gatewayRefunds) {
      if (!refund || !reference(refund.originalReference) ||
          !amount(refund.amountCents) || refund.currency !== 'GHS' ||
          !['success','pending','failed'].includes(refund.status)) {
        add('gateway_refund_evidence_invalid');
        valid = false;
        continue;
      }
      if (validWoo && refund.originalReference !== woo.originalReference) {
        add('gateway_refund_bound_to_different_payment_attempt');
      }
      if (refund.status !== 'success') {
        add('gateway_refund_not_confirmed_successful');
      }
      if (refund.status === 'success') {
        total += refund.amountCents;
        if (!Number.isSafeInteger(total)) valid = false;
      }
    }
    if (valid) refundedGatewayCents = total;
  } else {
    add('independent_gateway_refund_history_missing');
  }
  if (validWoo && refundedGatewayCents !== null &&
      refundedGatewayCents !== woo.refundedCents) {
    add('gateway_refund_totals_do_not_match_woo');
  }
  if (validGateway && refundedGatewayCents !== null &&
      refundedGatewayCents > gateway.amountCents) {
    add('gateway_refunds_exceed_original_payment');
  }

  const validSettlement = Boolean(settlement &&
    reference(settlement.originalReference) &&
    amount(settlement.grossCents) && cents(settlement.feeCents) &&
    cents(settlement.netCents) && settlement.currency === 'GHS' &&
    typeof settlement.status === 'string' &&
    settlement.status.length <= 40 &&
    reference(settlement.settlementBatchId));
  if (!validSettlement) {
    add('independent_settlement_record_invalid_or_missing');
  } else {
    if (settlement.grossCents !== settlement.feeCents + settlement.netCents) {
      add('settlement_gross_fee_net_arithmetic_disagrees');
    }
    if (settlement.status !== 'settled') {
      add('settlement_record_not_reported_settled');
    }
    if (woo && reference(woo.originalReference) &&
        settlement.originalReference !== woo.originalReference) {
      add('settlement_reference_does_not_match_original_woo_attempt');
    }
    if (validGateway && settlement.grossCents !== gateway.amountCents) {
      add('settlement_gross_amount_disagrees_with_gateway');
    }
  }
  // A report matching the same reference/amount may still be manipulated,
  // duplicated, from the wrong merchant, or not actually credited to bank.
  // Authentication, merchant ownership and final cash credit must therefore
  // be verified independently by a credentialed provider or bank statement.
  const arithmeticMatches = issues.length === 0;
  return {
    kind: 'offline-synthetic-settlement-evidence-comparison',
    source: 'caller-supplied-untrusted-snapshots',
    authOfSourcesVerified: false, merchantOwnershipVerified: false,
    bankFundsReceivedVerified: false, gatewaySettlementVerified: false,
    payoutToCustomerVerified: false, returnInspected: false,
    refundAuthorized: false, refundExecuted: false,
    stockRestorationAuthorized: false, checkoutAuthorized: false,
    writesAllowed: false,
    sameReferenceAndAmountsArithmeticallyConsistent: arithmeticMatches,
    issues,
    comparisonScope: {
      originalWooOrderProvided: validWoo,
      gatewayTransactionProvided: validGateway,
      settlementRecordProvided: validSettlement,
      refundHistoryProvided: Array.isArray(gatewayRefunds),
      relatedWooOrdersInspected: relatedWooOrders.length,
    },
    disposition: 'manual_source_authentication_and_financial_review_required',
    notice: 'This offline comparator only evaluates independently supplied, possibly untrusted snapshots. Matching values NEVER authenticate Paystack, prove bank credit, establish customer payout, authorize a refund, release goods or restore stock. Installed-site read-only verification and merchant-owned settlement evidence remain mandatory.',
  };
}
