import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluateRefundEvidence } from '../server/refund-evidence-policy.js';
import { createApp } from '../server/app.js';
import { saleEvent } from '../server/sale-events.js';

const date = '2026-11-15T13:30:00.000Z';
const original = (change = {}) => ({
  id: randomUUID(), number: 'SYNTHETIC-POS-ORDER', woo_order_id: 777,
  status: 'partially_refunded', payment_method: 'cash', total: 20000,
  refunded: 5000, paid_at: date, shift_id: null, ...change,
});
const ev = ['online.intent', 'online.cash_intent_started',
  'online.cash_accepted', 'online.payment_verified'];

test('partial and final proposed refunds are arithmetic only: no payout, approval, stock restoration or settlement claim', () => {
  const partial = evaluateRefundEvidence(original(), ev, 7000);
  assert.equal(partial.kind, 'read-only-refund-evidence-policy');
  assert.equal(partial.source, 'local-pos-ledger');
  assert.equal(partial.websiteOrdersIncluded, false);
  assert.equal(partial.originalTotalCents, 20000);
  assert.equal(partial.observedWooRefundCents, 5000);
  assert.equal(partial.observedRemainingCents, 15000);
  assert.equal(partial.recordedRefundKind, 'partial');
  assert.equal(partial.proposalWithinObservedRemaining, true);
  assert.equal(partial.hypotheticalBalanceAfterCents, 8000);
  assert.equal(partial.localCashCustodyEvent, true);
  assert.equal(partial.posPaymentEvidenceObserved, true);
  assert.equal(partial.decision, 'manual_review_only');
  for (const flag of ['auditOnly','mutationsAllowed','checkoutAuthorized','refundAuthorized',
    'refundExecuted','cashPayoutVerified','gatewaySettlementVerified','stockRestored',
    'returnInspected','fulfilmentAuthorized']) {
    assert.equal(partial[flag], flag === 'auditOnly', flag + ' must not authorize money or goods');
  }
  assert.ok(partial.checks.some(x => x.code === 'external_settlement_and_prior_payout' && x.observed === false));
  assert.ok(partial.checks.some(x => x.code === 'stock_restoration_authorization' && x.observed === false));
  assert.ok(partial.warnings.includes('recorded_woo_cash_refund_does_not_prove_physical_payout'));
  const fullRemainder = evaluateRefundEvidence(original(), ev, 15000);
  assert.equal(fullRemainder.proposalWithinObservedRemaining, true);
  assert.equal(fullRemainder.hypotheticalBalanceAfterCents, 0);
  assert.equal(fullRemainder.refundAuthorized, false, 'Even an exact remaining-balance match cannot authorize a payout');
  const over = evaluateRefundEvidence(original(), ev, 15001);
  assert.equal(over.proposalWithinObservedRemaining, false);
  assert.equal(over.hypotheticalBalanceAfterCents, null);
  assert.ok(over.warnings.includes('proposal_exceeds_observed_remaining_or_invalid'));
  assert.equal(over.checks.find(x => x.code === 'refund_amount_consistency').observed, false);
});

test('full prior refunds, unverified original payment, missing Woo ID and inconsistent refund states fail closed', () => {
  const full = evaluateRefundEvidence(original({ refunded: 20000, status: 'refunded' }), ev, 1);
  assert.equal(full.recordedRefundKind, 'full');
  assert.equal(full.observedRemainingCents, 0);
  assert.equal(full.proposalWithinObservedRemaining, false);
  const missingPayment = evaluateRefundEvidence(original({ paid_at: null }), ['online.intent'], 100);
  assert.equal(missingPayment.posPaymentEvidenceObserved, false);
  assert.ok(missingPayment.warnings.includes('local_payment_evidence_incomplete'));
  const unlinked = evaluateRefundEvidence(original({ woo_order_id: null }), ev);
  assert.ok(unlinked.warnings.includes('original_woo_order_unknown'));
  assert.equal(unlinked.refundAuthorized, false);
  const overRecorded = evaluateRefundEvidence(original({ refunded: 21000 }), ev, 100);
  assert.equal(overRecorded.recordedRefundKind, 'inconsistent');
  assert.equal(overRecorded.observedRemainingCents, null);
  assert.ok(overRecorded.warnings.includes('invalid_original_or_refund_total'));
  const impossibleStatus = evaluateRefundEvidence(original({ refunded: 0, status: 'refunded' }), ev);
  assert.ok(impossibleStatus.warnings.includes('woo_refund_state_inconsistent'));
  const claimedPaidNoRefundStatus = evaluateRefundEvidence(original({ status: 'paid' }), ev);
  assert.ok(claimedPaidNoRefundStatus.warnings.includes('woo_refund_state_inconsistent'));
  assert.equal(evaluateRefundEvidence(original({ refunded: 0, status: 'paid' }), ev).recordedRefundKind, 'none');
  for (const invalid of [0, -1, 0.5, NaN, 100000001]) {
    assert.throws(() => evaluateRefundEvidence(original(), ev, invalid), /illustrative refund amount/);
  }
});

test('live catalogue pilot: Owner/Manager can read policy; cashier/public cannot; no order reads, payout writes, stock changes or financial events', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-refund-evidence-'));
  const calls = [];
  const api = {
    async products() { calls.push('GET products'); throw Error('No catalogue read'); },
    async variations() { calls.push('GET variations'); throw Error('No variation read'); },
    async order() { calls.push('GET order'); throw Error('No order read'); },
    async createOrder() { calls.push('POST order'); throw Error('No order write'); },
    async updateOrder() { calls.push('PUT order'); throw Error('No order write'); },
  };
  const env = {
    NODE_ENV: 'test', POS_MODE: 'live', POS_LIVE_READ_ONLY: 'true',
    POS_ALLOW_LIVE_WRITES: 'false', POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com',
    WOO_BASE_URL: 'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY: 'ck_synthetic', WOO_CONSUMER_SECRET: 'cs_synthetic',
    POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'synthetic-pilot-password-123',
    POS_DATA_DIR: dir,
  };
  const { app, db } = createApp({ env, api, logger: {
    debug() {}, info() {}, warn() {}, error() {},
  } });
  const sale = original();
  db.prepare('INSERT INTO sales(id,idempotency_key,fingerprint,number,status,woo_order_id,' +
    'payment_method,total,refunded,paid_at,shift_id,updated_at,created_at,currency,' +
    'cashier_id,cashier_name,note,items_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(sale.id, randomUUID(), 'synthetic', sale.number, sale.status, sale.woo_order_id,
      sale.payment_method, sale.total, sale.refunded, sale.paid_at, sale.shift_id,
      date, date, 'GHS', 'cashier', 'Synthetic', '', '[]');
  for (const event of ev) saleEvent(db, sale.id, event, 'synthetic');
  const beforeSale = db.prepare('SELECT * FROM sales WHERE id=?').get(sale.id);
  const beforeEvents = db.prepare('SELECT * FROM sale_events').all();
  const beforeAudit = db.prepare('SELECT * FROM audit').all();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/api';
  async function req(uri, token, method = 'GET', body) {
    const r = await fetch(base + uri, {
      method, headers: { 'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  }
  const route = '/payments/reconciliation/' + sale.id + '/refund-evidence';
  assert.equal((await req(route)).status, 401);
  const login = await req('/auth/login', null, 'POST', {
    username: 'owner', password: 'synthetic-pilot-password-123',
  });
  assert.equal(login.status, 200);
  const token = login.body.token;
  assert.equal((await req('/auth/password', token, 'POST', {
    currentPassword: 'synthetic-pilot-password-123',
    newPassword: 'synthetic-rotated-password-123',
  })).status, 200);
  const response = await req(route + '?proposedCents=7000', token);
  assert.equal(response.status, 200);
  assert.equal(response.body.originalTotalCents, 20000);
  assert.equal(response.body.hypotheticalNewRefundCents, 7000);
  assert.equal(response.body.refundAuthorized, false);
  assert.equal(response.body.refundExecuted, false);
  assert.equal(response.body.stockRestored, false);
  assert.equal(response.body.gatewaySettlementVerified, false);
  assert.equal((await req(route + '?proposedCents=abc', token)).status, 400);
  assert.equal((await req(route + '?proposedCents=0', token)).status, 400);
  assert.equal((await req(route + '?proposedCents=100000001', token)).status, 400);
  assert.equal((await req(route, token, 'POST', {})).status, 404);
  const person = db.prepare("SELECT id FROM users WHERE username='owner'").get();
  db.prepare('UPDATE users SET role=? WHERE id=?').run('manager', person.id);
  assert.equal((await req(route, token)).status, 200);
  db.prepare('UPDATE users SET role=? WHERE id=?').run('cashier', person.id);
  assert.equal((await req(route, token)).status, 403);
  assert.deepEqual(db.prepare('SELECT * FROM sales WHERE id=?').get(sale.id), beforeSale);
  assert.deepEqual(db.prepare('SELECT * FROM sale_events').all(), beforeEvents);
  // Password rotation is separately auditable; read-only policy must not add
  // any finance, refund, cash or stock action.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'finance.%' OR action LIKE 'refund.%'").get().n, 0);
  assert.deepEqual(calls, []);
  assert.ok(beforeAudit.length >= 0);
});
