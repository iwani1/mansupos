import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSettlementEvidence } from '../server/settlement-evidence-comparison.js';

const original = '891_synthetic_paystack_txn_original';
const sample = () => ({
  woo: { orderId: 891, status: 'processing', totalCents: 25000,
    refundedCents: 10000, paymentMethod: 'paystack', currency: 'GHS',
    originalReference: original },
  gateway: { transactionId: 912345, reference: original, status: 'success',
    currency: 'GHS', amountCents: 25000 },
  settlement: { originalReference: original, settlementBatchId: 'batch_synthetic_001',
    grossCents: 25000, feeCents: 450, netCents: 24550,
    status: 'settled', currency: 'GHS' },
  gatewayRefunds: [
    { refundId: 331, originalReference: original, amountCents: 3000,
      currency: 'GHS', status: 'success' },
    { refundId: 332, originalReference: original, amountCents: 7000,
      currency: 'GHS', status: 'success' },
  ],
  relatedWooOrders: [{ orderId: 891, originalReference: original }],
});
const mustRemainClosed = report => {
  assert.equal(report.kind, 'offline-synthetic-settlement-evidence-comparison');
  assert.equal(report.source, 'caller-supplied-untrusted-snapshots');
  for (const key of ['authOfSourcesVerified','merchantOwnershipVerified',
    'bankFundsReceivedVerified','gatewaySettlementVerified',
    'payoutToCustomerVerified','returnInspected','refundAuthorized',
    'refundExecuted','stockRestorationAuthorized','checkoutAuthorized',
    'writesAllowed']) {
    assert.equal(report[key], false, key + ' must never become true from caller data');
  }
  assert.equal(report.disposition, 'manual_source_authentication_and_financial_review_required');
  const text = JSON.stringify(report);
  assert.equal(text.includes(original), false, 'Raw gateway payment reference must never be returned');
  assert.equal(text.includes('912345'), false, 'Raw gateway transaction ID must never be returned');
};
test('matching Woo, Paystack, settled batch and two partial refunds is arithmetic-only, NOT bank proof', () => {
  const report=compareSettlementEvidence(sample());
  assert.deepEqual(report.issues, []);
  assert.equal(report.sameReferenceAndAmountsArithmeticallyConsistent,true);
  assert.equal(report.comparisonScope.refundHistoryProvided,true);
  mustRemainClosed(report);
});
test('rejects reference misuse across Woo orders, wrong amount and wrong external attempt', () => {
  const x=sample();
  x.relatedWooOrders.push({orderId: 892, originalReference:original});
  x.gateway.amountCents=24999;
  x.gateway.reference='892_synthetic_other_reference';
  const r=compareSettlementEvidence(x);
  for (const code of ['gateway_reference_claimed_by_another_woo_order',
    'gateway_reference_does_not_match_original_woo_attempt',
    'original_order_and_gateway_gross_amount_disagree',
    'settlement_gross_amount_disagrees_with_gateway']) {
    assert.ok(r.issues.includes(code), code);
  }
  assert.equal(r.sameReferenceAndAmountsArithmeticallyConsistent,false);
  mustRemainClosed(r);
});
test('duplicate, wrong-original, pending, overpaid and missing refund evidence never counts as matched', () => {
  const duplicate=sample();
  duplicate.gatewayRefunds[1].refundId=duplicate.gatewayRefunds[0].refundId;
  duplicate.gatewayRefunds[1].originalReference='other_synthetic_ref_0001';
  duplicate.gatewayRefunds[1].status='pending';
  const r=compareSettlementEvidence(duplicate);
  assert.ok(r.issues.includes('duplicate_or_invalid_gateway_refund_identifiers'));
  assert.ok(r.issues.includes('gateway_refund_bound_to_different_payment_attempt'));
  assert.ok(r.issues.includes('gateway_refund_not_confirmed_successful'));
  assert.ok(r.issues.includes('gateway_refund_totals_do_not_match_woo'));
  mustRemainClosed(r);
  const missing=sample();missing.gatewayRefunds=null;
  assert.ok(compareSettlementEvidence(missing).issues.includes('independent_gateway_refund_history_missing'));
  const excess=sample();excess.gatewayRefunds[1].amountCents=24000;
  const out=compareSettlementEvidence(excess);
  assert.ok(out.issues.includes('gateway_refunds_exceed_original_payment'));
  assert.ok(out.issues.includes('gateway_refund_totals_do_not_match_woo'));
});
test('settlement report status, merchant accounting and currency errors fail closed', () => {
  const x=sample();
  x.settlement.status='pending';
  x.settlement.netCents=26000;
  x.settlement.originalReference='another_settlement_000';
  x.woo.currency='USD';
  x.gateway.status='abandoned';
  const r=compareSettlementEvidence(x);
  for (const code of ['original_woo_order_evidence_invalid_or_missing',
    'gateway_transaction_not_reported_successful',
    'settlement_gross_fee_net_arithmetic_disagrees',
    'settlement_record_not_reported_settled',
    'settlement_reference_does_not_match_original_woo_attempt']) {
    assert.ok(r.issues.includes(code), code);
  }
  mustRemainClosed(r);
});
test('missing evidence and zero/malformed totals never become settlement confirmation', () => {
  mustRemainClosed(compareSettlementEvidence());
  const bad=sample();
  bad.gateway=null;
  bad.woo.refundedCents=26000;
  bad.settlement=null;
  const r=compareSettlementEvidence(bad);
  assert.ok(r.issues.includes('original_woo_order_evidence_invalid_or_missing'));
  assert.ok(r.issues.includes('gateway_verification_record_invalid_or_missing'));
  assert.ok(r.issues.includes('independent_settlement_record_invalid_or_missing'));
  mustRemainClosed(r);
});
