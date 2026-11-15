import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { saleEvent } from '../server/sale-events.js';
import { paymentReconciliation } from '../server/payment-reconciliation.js';

const original = '2026-11-15T12:00:00.000Z';
function seed(db, { status, total, refunded = 0, method = null,
  paidAt = null, wooId = null, events = [], updated = original }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO sales
    (id,idempotency_key,fingerprint,number,status,woo_order_id,payment_method,
      total,refunded,paid_at,shift_id,updated_at,created_at,currency,
      cashier_id,cashier_name,note,items_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, randomUUID(), 'synthetic', 'TEST-' + id.slice(0, 7), status,
    wooId, method, total, refunded, paidAt, null, updated, updated,
    'GHS', 'synthetic-cashier', 'Synthetic', '', '[]');
  for (const event of events) saleEvent(db, id, event, 'synthetic', { wooOrderId: wooId });
  return id;
}

function createLocal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-payment-review-'));
  const calls = [];
  const api = {
    async products() { calls.push('GET products'); return { data: [], total: 0, pages: 1 }; },
    async variations() { calls.push('GET variations'); throw new Error('No remote variation read'); },
    async order() { calls.push('GET Woo orders'); throw new Error('No website order read'); },
    async createOrder() { calls.push('POST Woo order'); throw new Error('No Woo write'); },
    async updateOrder() { calls.push('PUT Woo order'); throw new Error('No Woo write'); },
  };
  const env = {
    NODE_ENV: 'test', POS_MODE: 'live', POS_LIVE_READ_ONLY: 'true',
    POS_ALLOW_LIVE_WRITES: 'false',
    WOO_BASE_URL: 'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY: 'ck_synthetic', WOO_CONSUMER_SECRET: 'cs_synthetic',
    POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com',
    POS_DATA_DIR: dir, POS_OWNER_USERNAME: 'owner',
    POS_OWNER_PASSWORD: 'synthetic-pilot-password-123',
  };
  const { app, db } = createApp({ env, api,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  return { app, db, dir, calls };
}

test('financial cases use original POS IDs; no duplicate refund/cash cases; pagination bounded', () => {
  const h = createLocal();
  try {
    const custody = seed(h.db, { status: 'needs_reconciliation', total: 10000,
      method: 'cash', wooId: 401, events: [
        'online.intent', 'online.cash_intent_started', 'online.cash_accepted', 'online.payment_started',
      ] });
    const intent = seed(h.db, { status: 'awaiting_payment', total: 20000, wooId: 402,
      events: ['online.intent', 'online.cash_intent_started'] });
    const refund = seed(h.db, { status: 'partially_refunded', total: 30000,
      refunded: 3000, method: 'cash', paidAt: original, wooId: 403,
      events: ['online.intent', 'online.cash_accepted', 'online.payment_verified'] });
    const missing = seed(h.db, { status: 'paid', total: 5000, method: 'cash',
      paidAt: original, wooId: 404, events: ['online.intent'] });
    const healthy = seed(h.db, { status: 'paid', total: 25000, method: 'cash',
      paidAt: original, wooId: 405, events: ['online.intent', 'online.cash_accepted', 'online.payment_verified'] });
    const page = paymentReconciliation(h.db, { limit: 10 });
    assert.equal(page.fullCaseCount, 4);
    assert.equal(page.cases.length, 4);
    assert.equal(page.auditOnly, true);
    assert.equal(page.checkoutAuthorized, false);
    assert.equal(page.mutationsAllowed, false);
    assert.equal(page.websiteOrdersIncluded, false);
    assert.equal(page.gatewaySettlementVerified, false);
    assert.equal(page.refundPayoutVerified, false);
    assert.equal(page.pageSummary.unconfirmedCashCustodyCents, 10000);
    assert.equal(page.pageSummary.unverifiedCashRefundCents, 3000);
    assert.equal(page.pageSummary.urgentCases, 2);
    const byId = new Map(page.cases.map(item => [item.id, item]));
    assert.ok(byId.get(custody).issueCodes.includes('cash_custody_unconfirmed'));
    assert.ok(byId.get(intent).issueCodes.includes('cash_intent_unconfirmed'));
    assert.ok(byId.get(refund).issueCodes.includes('cash_refund_payout_unverified'));
    assert.ok(byId.get(missing).issueCodes.includes('paid_evidence_incomplete'));
    assert.equal(byId.has(healthy), false);
    assert.equal(JSON.stringify(page).includes('payment_reference'), false);
    assert.equal(JSON.stringify(page).includes('synthetic-cashier'), false);
    const ids = [];
    let cursor;
    for (let n = 0; n < 4; n++) {
      const result = paymentReconciliation(h.db, { limit: 1, cursor });
      ids.push(...result.cases.map(item => item.id));
      cursor = result.nextCursor;
      assert.equal(result.pageSummary.cases, 1);
    }
    assert.equal(new Set(ids).size, 4);
    assert.equal(cursor, null);
    assert.throws(() => paymentReconciliation(h.db, { limit: 1000 }), /limit/);
    assert.throws(() => paymentReconciliation(h.db, { cursor: 'not-a-valid-cursor' }), /cursor/);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n, 13);
    assert.deepEqual(h.calls, [], 'Read-only evidence does not request Woo products/orders/stock');
  } finally {
    h.db.close(); fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('live read-only pilot: authenticated Owner and Manager only; no website order read or financial write', async t => {
  const h = createLocal();
  const server = h.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    h.db.close(); fs.rmSync(h.dir, { recursive: true, force: true });
  });
  const saleId = seed(h.db, { status: 'needs_reconciliation', total: 13000,
    method: 'cash', wooId: 1234, events: ['online.intent', 'online.cash_intent_started', 'online.cash_accepted'] });
  const before = {
    sales: h.db.prepare('SELECT * FROM sales WHERE id=?').get(saleId),
    events: h.db.prepare('SELECT * FROM sale_events WHERE sale_id=?').all(saleId),
    audit: h.db.prepare('SELECT * FROM audit').all(),
  };
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(route, token, method = 'GET', body) {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('/payments/reconciliation')).status, 401);
  const login = await request('/auth/login', null, 'POST', {
    username: 'owner', password: 'synthetic-pilot-password-123',
  });
  assert.equal(login.status, 200);
  const token = login.body.token;
  assert.equal((await request('/auth/password', token, 'POST', {
    currentPassword: 'synthetic-pilot-password-123', newPassword: 'synthetic-rotated-password-123',
  })).status, 200);
  const owner = await request('/payments/reconciliation?limit=1', token);
  assert.equal(owner.status, 200);
  assert.equal(owner.body.kind, 'read-only-pos-payment-reconciliation');
  assert.equal(owner.body.fullCaseCount, 1);
  assert.equal(owner.body.cases[0].id, saleId);
  assert.equal(owner.body.cases[0].wooOrderId, 1234);
  assert.equal(owner.body.websiteOrdersIncluded, false);
  assert.equal((await request('/payments/reconciliation?limit=501', token)).status, 400);
  assert.equal((await request('/payments/reconciliation', token, 'POST', {})).status, 404);
  const person = h.db.prepare("SELECT id FROM users WHERE username='owner'").get();
  h.db.prepare('UPDATE users SET role=? WHERE id=?').run('manager', person.id);
  assert.equal((await request('/payments/reconciliation', token)).status, 200);
  h.db.prepare('UPDATE users SET role=? WHERE id=?').run('cashier', person.id);
  assert.equal((await request('/payments/reconciliation', token)).status, 403);
  assert.deepEqual(h.db.prepare('SELECT * FROM sales WHERE id=?').get(saleId), before.sales);
  assert.deepEqual(h.db.prepare('SELECT * FROM sale_events WHERE sale_id=?').all(saleId), before.events);
  // Exclude login/password auditable events; no payment reconciliation audit writes.
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'payment.%'").get().n, 0);
  assert.deepEqual(h.calls, [], 'No Woo products, orders, stock, gateway or write requests');
});
