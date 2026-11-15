import test from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticReadOnlyEvidenceReader } from '../server/readonly-evidence-source.js';

const ORDER = 5003;
const REF = '5003_synthetic_paystack_ref';
const WOO = 'https://shop.mansu-pos-evidence.invalid/wp-json/wc/v3/orders/5003';
const PAY = 'https://api.paystack.co/transaction/verify/' + REF;
const env = { NODE_ENV: 'test', MANSU_CI_SYNTHETIC_EVIDENCE: 'true' };
const config = {
  env, wooOrigin: 'https://shop.mansu-pos-evidence.invalid',
  wooKey: 'ck_synthetic_evidence_only', wooSecret: 'cs_synthetic_evidence_only',
  paystackSecret: 'sk_test_synthetic_evidence_only',
};
const makeOrder = () => ({
  id: ORDER, status: 'processing', currency: 'GHS', payment_method: 'paystack',
  total: '120.00', date_modified_gmt: '2026-11-15T15:00:00',
  meta_data: [{ key: '_paystack_txn_ref', value: REF }],
  refunds: [{ id: 705 }, { id: 706 }],
  billing: { first_name: 'Never reveal', email: 'private@example.invalid' },
});
const refundRows = () => [
  { id: 705, amount: '-25.00', reason: 'PRIVATE CUSTOMER RETURN' },
  { id: 706, amount: '10.00', reason: 'PRIVATE REFUND NOTE' },
];
const pay = () => ({
  status: true, message: 'Verification successful',
  data: {
    id: 44445555, status: 'success', reference: REF,
    currency: 'GHS', amount: 12000, customer: {
      email: 'never-expose@example.invalid', authorization: { last4: '0123' },
    },
  },
});
function fixture({ order = makeOrder(), refunds = refundRows(), gateway = pay(),
  refundCount = refunds.length, refundPages = 1,
  mutate = null, failAt = null, networkError = null } = {}) {
  const calls = [];
  const mock = async (url, init) => {
    calls.push({ url, init });
    if (networkError && calls.length === networkError) throw Error('secret remote detail');
    if (failAt && calls.length === failAt) return new Response('UPSTREAM PRIVATE', {
      status: 503, headers: { 'content-type': 'text/plain' },
    });
    if (url === WOO) return new Response(JSON.stringify(calls.length === 4 && mutate ? mutate : order), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    if (url === WOO + '/refunds?page=1&per_page=100') return new Response(JSON.stringify(refunds), {
      status: 200, headers: {
        'content-type': 'application/json',
        'x-wp-total': String(refundCount), 'x-wp-totalpages': String(refundPages),
      },
    });
    if (url === PAY) return new Response(JSON.stringify(gateway), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    throw Error('Unknown mock URL: ' + url);
  };
  return { calls, mock, reader: new SyntheticReadOnlyEvidenceReader({ ...config, fetchImpl: mock }) };
}
test('strict synthetic-only mode cannot reach merchant host or use native fetch in production', () => {
  assert.throws(() => new SyntheticReadOnlyEvidenceReader({
    ...config, env: { NODE_ENV: 'production', MANSU_CI_SYNTHETIC_EVIDENCE: 'true' },
    fetchImpl: async () => {},
  }), /NOT enabled/);
  assert.throws(() => new SyntheticReadOnlyEvidenceReader({
    ...config, wooOrigin: 'https://www.mansutrendzgh.com', fetchImpl: async () => {},
  }), /NOT enabled/);
  assert.throws(() => new SyntheticReadOnlyEvidenceReader({
    ...config, paystackSecret: 'sk_live_real_secret', fetchImpl: async () => {},
  }), /NOT enabled/);
  assert.throws(() => new SyntheticReadOnlyEvidenceReader({
    ...config, fetchImpl: globalThis.fetch,
  }), /NOT enabled/);
});
test('pinned GET-only Woo order/refunds and Paystack verifier form an UNVERIFIED, non-executing comparison', async () => {
  const f = fixture();
  const result = await f.reader.inspect(ORDER);
  assert.deepEqual(f.calls.map(x => x.url), [
    WOO, WOO + '/refunds?page=1&per_page=100', PAY, WOO,
  ]);
  assert.deepEqual(f.calls.map(x => x.init.method), ['GET', 'GET', 'GET', 'GET']);
  for (const item of f.calls) {
    assert.equal(item.init.redirect, 'error');
    assert.equal(item.init.cache, 'no-store');
    assert.equal(item.init.body, undefined);
    assert.equal(item.init.headers.Accept, 'application/json');
    assert.ok(item.init.signal, 'Every request has a bounded timeout signal');
  }
  assert.equal(f.calls[0].init.headers.Authorization.startsWith('Basic '), true);
  assert.equal(f.calls[2].init.headers.Authorization, 'Bearer sk_test_synthetic_evidence_only');
  assert.equal(result.kind, 'synthetic-woo-paystack-read-contract');
  assert.equal(result.originalOrderId, ORDER);
  assert.equal(result.numberOfWooRefundRowsInspected, 2);
  assert.equal(result.sameReferenceAndAmountsArithmeticallyConsistent, false,
    'No bank settlement/refund provider history was fetched');
  assert.ok(result.issues.includes('independent_gateway_refund_history_missing'));
  assert.ok(result.issues.includes('independent_settlement_record_invalid_or_missing'));
  for (const key of ['disconnectedFromMerchant','merchantSourceAuthenticated','bankFundsReceivedVerified',
    'gatewaySettlementVerified','refundExecuted','stockRestorationAuthorized',
    'checkoutAuthorized','writesAllowed','payoutToCustomerVerified']) {
    assert.equal(result[key], key === 'disconnectedFromMerchant', key);
  }
  const serialized = JSON.stringify(result);
  for (const sensitive of [REF, '44445555', 'never-expose', 'private@example.invalid',
    'PRIVATE CUSTOMER RETURN', 'sk_test_synthetic_evidence_only', 'cs_synthetic_evidence_only']) {
    assert.equal(serialized.includes(sensitive), false, 'Response leaked ' + sensitive);
  }
});
test('wrong Paystack reference or amount is a diagnostic, never an approved settlement', async () => {
  const other = pay(); other.data.reference = 'another_synthetic_ref_123';
  other.data.amount = 11900;
  const f=fixture({gateway:other});
  const r=await f.reader.inspect(ORDER);
  assert.ok(r.issues.includes('gateway_reference_does_not_match_original_woo_attempt'));
  assert.ok(r.issues.includes('original_order_and_gateway_gross_amount_disagree'));
  assert.equal(r.gatewaySettlementVerified,false);
  assert.equal(r.writesAllowed,false);
});
test('rejects incomplete Woo refund pagination, duplicated IDs, and mismatched original refund index', async () => {
  for (const options of [
    { refundCount: 3 },
    { refundPages: 2 },
    { refunds: [{ id: 705, amount: '-5.00' }, { id: 705, amount: '-5.00' }] },
    { order: { ...makeOrder(), refunds: [{ id: 705 }] } },
    { refunds: [{ id: 705, amount: '-110.00' }, { id: 706, amount: '-20.00' }] },
  ]) {
    const f=fixture(options);
    await assert.rejects(f.reader.inspect(ORDER));
  }
});
test('read-after-verification detects changed Woo status, reference, total or revision', async () => {
  for (const update of [
    { status: 'on-hold' }, { total: '125.00' },
    { meta_data: [{ key: '_paystack_txn_ref', value: 'another_ref_123456' }] },
    { date_modified_gmt: '2026-11-15T15:01:00' },
  ]) {
    const f=fixture({mutate:{...makeOrder(),...update}});
    await assert.rejects(f.reader.inspect(ORDER), /changed during evidence collection/);
  }
});
test('fail closed on Woo ID mismatch, untrusted meta, malformed currency, underpaid original and malformed response', async () => {
  for (const order of [
    {...makeOrder(),id: ORDER + 1},
    {...makeOrder(),currency:'USD'},
    {...makeOrder(),meta_data: [
      {key:'_paystack_txn_ref',value:REF},{key:'_paystack_txn_ref',value:REF},
    ]},
    {...makeOrder(),total:'NaN'},
    {...makeOrder(),total:'0.00'},
  ]) {
    await assert.rejects(fixture({order}).reader.inspect(ORDER));
  }
  for (const gateway of [
    {...pay(),status:false},
    {...pay(),data:{...pay().data,amount:0}},
    {...pay(),data:{...pay().data,id:'no-id'}},
  ]) {
    await assert.rejects(fixture({gateway}).reader.inspect(ORDER));
  }
});
test('timeout/network/HTTP failure never retries, logs upstream errors or makes money/stock writes', async () => {
  for (const options of [{failAt:1},{failAt:3},{networkError:2}]) {
    const f=fixture(options);
    await assert.rejects(f.reader.inspect(ORDER), err =>
      !String(err).includes('UPSTREAM PRIVATE') && !String(err).includes('secret remote detail'));
    assert.ok(f.calls.length <= 3);
    assert.ok(f.calls.every(x => x.init.method === 'GET'));
  }
  await assert.rejects(fixture().reader.inspect(0));
  await assert.rejects(fixture().reader.inspect('5003'));
});
