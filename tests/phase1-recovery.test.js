import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { AppError, RemoteError } from '../server/errors.js';
import { WooCommerce } from '../server/woocommerce.js';

// These are in-memory Woo fixtures. None of the tests contacts a real store.
function fakeWoo() {
  const state = { orders: [], creates: 0, updates: 0, loseCreate: false, losePayment: false, stock: 5,
    variationOverride: null, productOverride: null };
  const product = () => ({ id: 101, name: 'Fixture shirt', type: 'variable', sku: 'F-101', status: 'publish', price: '100.00',
    manage_stock: true, stock_quantity: state.stock, stock_status: 'instock', purchasable: true, images: [], categories: [] ,
    ...state.productOverride });
  const variation = () => ({ id: 102, parent_id: 101, sku: '', price: '100.00', attributes: [{ name: 'Size', option: 'M' }],
    manage_stock: 'parent', stock_status: 'instock', purchasable: true, ...state.variationOverride });
  const view = order => order ? structuredClone(order) : null;
  return {
    state,
    async products() { return { data: [product()], pages: 1, total: 1 }; },
    async variations() { return { data: [variation()], pages: 1, total: 1 }; },
    async product() { return product(); },
    async variation() { return variation(); },
    async createOrder(body) {
      const id = 700 + ++state.creates;
      const line_items = body.line_items.map((item, i) => ({ id: 1000 + i, product_id: item.product_id,
        variation_id: item.variation_id || 0, quantity: item.quantity, name: 'Fixture shirt', sku: 'F-101',
        price: 100, total: (100 * item.quantity).toFixed(2), subtotal: (100 * item.quantity).toFixed(2),
        total_tax: '0.00', meta_data: [] }));
      const order = { id, number: String(id), status: 'pending', currency: 'GHS', total: (100 * body.line_items.reduce((n, x) => n + x.quantity, 0)).toFixed(2),
        total_tax: '0.00', date_paid: null, line_items, meta_data: view(body.meta_data), billing: body.billing || {},
        fee_lines: [], coupon_lines: [], shipping_lines: [], shipping_total: '0.00', discount_total: '0.00', tax_lines: [], refunds: [] };
      state.orders.push(order);
      if (state.loseCreate) { state.loseCreate = false; throw new RemoteError('Fixture lost create response after Woo committed', 502, true); }
      return view(order);
    },
    async updateOrder(id, body) {
      state.updates++;
      const order = state.orders.find(item => item.id === id);
      if (!order) throw new Error('Fixture order not found');
      Object.assign(order, { ...body, meta_data: order.meta_data });
      if (body.meta_data) for (const entry of body.meta_data) {
        const prior = order.meta_data.find(m => m.key === entry.key);
        if (prior) prior.value = entry.value; else order.meta_data.push(view(entry));
      }
      if (body.set_paid) order.date_paid_gmt = new Date().toISOString();
      if (state.losePayment) { state.losePayment = false; throw new RemoteError('Fixture lost payment response after Woo committed', 502, true); }
      return view(order);
    },
    async order(id) { return view(state.orders.find(item => item.id === id)); },
    async findOrderByKey(key) {
      const found = state.orders.filter(order => order.meta_data.some(entry => entry.key === '_mansu_pos_key' && entry.value === key));
      if (found.length > 1) throw new AppError('Ambiguous key in fixture Woo orders', 409, 'RECONCILIATION_REQUIRED');
      return view(found[0]);
    },
  };
}

async function harness(t, { mode = 'staging', requireShift = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-phase1-recovery-'));
  const api = fakeWoo();
  const env = { NODE_ENV: 'test', POS_MODE: mode, POS_LIVE_READ_ONLY: 'false', POS_DATA_DIR: dir,
    WOO_BASE_URL: mode === 'live' ? 'https://www.mansutrendzgh.com' : 'https://staging.example.com',
    WOO_CONSUMER_KEY: 'ck_fake', WOO_CONSUMER_SECRET: 'cs_fake', POS_STAGING_APPROVED: 'true',
    POS_ALLOW_LIVE_WRITES: 'true', POS_OWNER_APPROVAL_REFERENCE: 'isolated-fixture-only',
    POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'phase-one-fixture-secret-123', POS_REQUIRE_SHIFT: String(requireShift) };
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  let instance = createApp({ env, api, logger });
  let server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (instance.db.isOpen) instance.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  const owner = (await request('/auth/login', { method: 'POST', body: { username: 'owner', password: env.POS_OWNER_PASSWORD } })).data.token;
  assert.equal((await request('/auth/password', { method: 'POST', token: owner,
    body: { currentPassword: env.POS_OWNER_PASSWORD, newPassword: 'phase-one-rotated-secret-123' } })).status, 200);
  const restart = async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    instance.db.close();
    instance = createApp({ env, api, logger });
    server = instance.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    return { ...instance, api, request, owner, base, restart };
  };
  return { ...instance, api, request, owner, base, restart };
}
const cart = () => ({ idempotencyKey: randomUUID(), items: [{ productId: 101, variationId: 102, quantity: 1 }] });
const post = (h, route, body, token = h.owner) => h.request(route, { method: 'POST', body, token });


test('lost create response keeps one POS key and one Woo order; duplicate requests cannot create another', async t => {
  const h = await harness(t);
  const input = cart();
  h.api.state.loseCreate = true;
  const lost = await post(h, '/sales/prepare', input);
  assert.equal(lost.data.code, 'RECONCILIATION_REQUIRED');
  assert.equal(h.api.state.creates, 1);
  const row = h.db.prepare('SELECT * FROM sales WHERE idempotency_key=?').get(input.idempotencyKey);
  assert.equal(row.status, 'needs_reconciliation');
  assert.equal(row.woo_order_id, null);
  const sameKey = await post(h, '/sales/prepare', input);
  assert.equal(sameKey.data.sale.id, row.id);
  assert.equal(sameKey.data.sale.wooOrderId, h.api.state.orders[0].id);
  assert.equal(h.db.prepare('SELECT prepared_total FROM sales WHERE id=?').get(row.id).prepared_total, 10000,
    'Recovered pending retail orders pin the verified total in the same commit.');
  assert.equal(h.api.state.creates, 1);
  const otherKey = await post(h, '/sales/prepare', { ...input, idempotencyKey: randomUUID() });
  assert.equal(otherKey.status, 409);
  assert.equal(h.api.state.creates, 1);
  const events = (await h.request(`/sales/${row.id}/events`, { token: h.owner })).data.events;
  assert.ok(events.some(event => event.event === 'woo.create_started'));
  assert.ok(events.some(event => event.event === 'woo.create_uncertain'));
  assert.ok(events.some(event => event.event === 'reconcile.checked'));
  assert.ok(events.every(event => !JSON.stringify(event).includes(input.idempotencyKey)), 'Events do not duplicate checkout keys.');
});

test('process restarts retain Woo create/payment intents and recover the same remote order without a second write', async t => {
  const h = await harness(t, { mode: 'live' });
  const input = cart();
  h.api.state.loseCreate = true;
  assert.equal((await post(h, '/sales/prepare', input)).data.code, 'RECONCILIATION_REQUIRED');
  const id = h.db.prepare('SELECT id FROM sales WHERE idempotency_key=?').get(input.idempotencyKey).id;
  assert.equal(h.api.state.creates, 1);
  const afterCreateRestart = await h.restart();
  assert.equal(afterCreateRestart.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='woo.create_started'").get(id).n, 1);
  const recovered = await post(afterCreateRestart, '/sales/prepare', input);
  assert.equal(recovered.data.sale.id, id);
  assert.equal(recovered.data.sale.wooOrderId, afterCreateRestart.api.state.orders[0].id);
  assert.equal(afterCreateRestart.api.state.creates, 1);
  afterCreateRestart.api.state.losePayment = true;
  assert.equal((await post(afterCreateRestart, `/sales/${id}/pay`, { method: 'cash', tendered: 11000, confirmed: true })).data.code, 'RECONCILIATION_REQUIRED');
  assert.equal(afterCreateRestart.api.state.updates, 1);
  const afterPaymentRestart = await afterCreateRestart.restart();
  assert.equal(afterPaymentRestart.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='payment.intent'").get(id).n, 1);
  const verified = await post(afterPaymentRestart, `/sales/${id}/reconcile`, {});
  assert.equal(verified.data.sale.status, 'paid');
  assert.equal(verified.data.sale.id, id);
  assert.equal(afterPaymentRestart.api.state.creates, 1);
  assert.equal(afterPaymentRestart.api.state.updates, 1);
  assert.equal(afterPaymentRestart.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='sale.paid' AND subject LIKE ?").get(`${id}:%`).n, 1);
});

test('a v9 sale with no durable Woo create intent cannot adopt an unrelated matching-key order', async t => {
  const h = await harness(t);
  const input = cart();
  h.api.state.variationOverride = { parent_id: 999 };
  const failed = await post(h, '/sales/prepare', input);
  assert.equal(failed.status, 409, 'The catalogue identity check fails before any Woo create attempt.');
  assert.equal(h.api.state.creates, 0);
  const row = h.db.prepare('SELECT * FROM sales WHERE idempotency_key=?').get(input.idempotencyKey);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='woo.create_started'").get(row.id).n, 0);
  await h.api.createOrder({ status: 'pending', line_items: [{ product_id: 101, variation_id: 102, quantity: 1 }],
    meta_data: [{ key: '_mansu_pos_key', value: input.idempotencyKey },
      { key: '_mansu_pos_channel', value: 'mansu-pos' }, { key: '_mansu_pos_cashier', value: row.cashier_id }] });
  const checked = await post(h, `/sales/${row.id}/reconcile`, {});
  assert.equal(checked.data.code, 'RECONCILIATION_REQUIRED');
  assert.equal(h.sales.get(row.id, { role: 'owner' }).woo_order_id, null);
});

test('owner recovery queue paginates without hiding older pending sales', async t => {
  const h = await harness(t);
  for (let i = 0; i < 3; i++) {
    const prepared = await post(h, '/sales/prepare', { ...cart(), note: `Queue fixture ${i}` });
    assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  }
  const first = (await h.request('/recovery/queue?limit=2', { token: h.owner })).data;
  assert.equal(first.sales.length, 2);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = (await h.request(`/recovery/queue?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, { token: h.owner })).data;
  assert.equal(second.sales.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.sales, ...second.sales].map(row => row.id)).size, 3);
  assert.equal((await h.request('/recovery/queue?cursor=invalid', { token: h.owner })).status, 400);
});

test('manager can inspect recovery and sale events but cannot administer staff or audit', async t => {
  const h = await harness(t);
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  const password = 'phase-one-manager-secret-123';
  const staff = (await post(h, '/staff', { name: 'Fixture Manager', username: 'phase1.manager', role: 'manager', password })).data.user;
  const manager = (await post(h, '/auth/login', { username: staff.username, password }, null)).data.token;
  assert.equal((await post(h, '/auth/password', {
    currentPassword: password, newPassword: 'phase-one-manager-rotated-123',
  }, manager)).status, 200);
  const queue = await h.request('/recovery/queue?limit=1', { token: manager });
  assert.equal(queue.status, 200);
  assert.equal(queue.data.sales[0].id, sale.id);
  const events = await h.request(`/sales/${sale.id}/events`, { token: manager });
  assert.equal(events.status, 200);
  assert.ok(events.data.events.some(event => event.event === 'sale.prepare_intent'));
  for (const route of ['/staff', '/audit']) assert.equal((await h.request(route, { token: manager })).status, 403, route);
});

test('missing, conflicting, or duplicate cashier metadata never binds a new Woo order', async t => {
  for (const mutate of [
    order => { order.meta_data = order.meta_data.filter(entry => entry.key !== '_mansu_pos_cashier'); },
    order => { order.meta_data.find(entry => entry.key === '_mansu_pos_cashier').value = 'different-cashier'; },
    order => { order.meta_data.push({ key: '_mansu_pos_cashier', value: 'different-cashier' }); },
  ]) {
    const h = await harness(t);
    const input = cart();
    h.api.state.loseCreate = true;
    await post(h, '/sales/prepare', input);
    mutate(h.api.state.orders[0]);
    const id = h.db.prepare('SELECT id FROM sales WHERE idempotency_key=?').get(input.idempotencyKey).id;
    const checked = await post(h, `/sales/${id}/reconcile`, {});
    assert.equal(checked.data.code, 'RECONCILIATION_REQUIRED');
    assert.equal(h.sales.get(id, { role: 'owner' }).woo_order_id, null);
    assert.equal(h.api.state.creates, 1);
  }
});

test('lost payment response records intent before Woo PUT and reconciles without taking cash twice', async t => {
  const h = await harness(t, { mode: 'live' });
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  h.api.state.losePayment = true;
  const lost = await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 11000, confirmed: true });
  assert.equal(lost.data.code, 'RECONCILIATION_REQUIRED');
  assert.equal(h.sales.get(sale.id, { role: 'owner' }).status, 'needs_reconciliation');
  assert.equal(h.api.state.updates, 1);
  const reconciled = await post(h, `/sales/${sale.id}/reconcile`, {});
  assert.equal(reconciled.data.sale.status, 'paid');
  assert.equal(reconciled.data.sale.wooOrderId, sale.wooOrderId);
  assert.equal((await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 11000, confirmed: true })).data.sale.status, 'paid');
  assert.equal(h.api.state.updates, 1);
  const events = (await h.request(`/sales/${sale.id}/events`, { token: h.owner })).data.events;
  for (const kind of ['payment.intent', 'woo.payment_started', 'woo.payment_uncertain', 'payment.verified']) {
    assert.ok(events.some(e => e.event === kind), kind);
  }
  assert.ok(events.find(e => e.event === 'payment.verified').details.recovered);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='sale.paid' AND subject LIKE ?").get(`${sale.id}:%`).n, 1);
});

test('a refund before the POS has confirmed an interrupted payment requires manual review', async t => {
  const h = await harness(t, { mode: 'live', requireShift: true });
  const shift = (await post(h, '/shifts/open', { openingFloat: 1000 })).data.shift;
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  h.api.state.losePayment = true;
  await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 10000, confirmed: true });
  h.api.state.orders[0].refunds = [{ total: '-40.00' }];
  const reviewed = (await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale;
  assert.equal(reviewed.status, 'needs_reconciliation');
  assert.equal(reviewed.refunded, 4000);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='sale.paid'").get().n, 0);
  assert.equal((await post(h, `/shifts/${shift.id}/close`, { closingCash: 11000 })).status, 409);
});

test('Woo marked paid without a prior POS intent never becomes a paid cash receipt', async t => {
  const h = await harness(t, { mode: 'live' });
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  const order = h.api.state.orders[0];
  order.status = 'completed'; order.date_paid_gmt = new Date().toISOString(); order.payment_method = 'pos_cash';
  order.meta_data.push({ key: '_mansu_pos_payment_recorded', value: 'externally-collected' });
  assert.equal((await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 10000, confirmed: true })).data.code, 'RECONCILIATION_REQUIRED');
  const row = h.sales.get(sale.id, { role: 'owner' });
  assert.equal(row.status, 'needs_reconciliation');
  assert.equal(row.payment_method, null);
  assert.equal(h.api.state.updates, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='sale.paid'").get().n, 0);
});

test('changed Woo variation or quantity is not paid even when gross total is unchanged', async t => {
  for (const changed of [order => { order.line_items[0].variation_id = 999; }, order => { order.line_items[0].quantity = 2; }]) {
    const h = await harness(t, { mode: 'live' });
    const sale = (await post(h, '/sales/prepare', cart())).data.sale;
    changed(h.api.state.orders[0]);
    const payment = await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 10000, confirmed: true });
    assert.equal(payment.data.code, 'RETAIL_ORDER_CHANGED');
    assert.equal(h.api.state.updates, 0);
    assert.equal(h.sales.get(sale.id, { role: 'owner' }).status, 'needs_reconciliation');
  }
});

test('retail gross or line tax drift after preparation never silently rewrites an approved receipt', async t => {
  for (const changed of [
    order => { order.line_items[0].total = order.line_items[0].subtotal = '105.00'; order.total = '105.00'; },
    order => { order.line_items[0].total = order.line_items[0].subtotal = '90.00';
      order.line_items[0].total_tax = '10.00'; order.total_tax = '10.00'; },
  ]) {
    const h = await harness(t, { mode: 'live' });
    const sale = (await post(h, '/sales/prepare', cart())).data.sale;
    changed(h.api.state.orders[0]);
    const payment = await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 11000, confirmed: true });
    assert.ok(['TOTAL_CHANGED', 'RETAIL_ORDER_CHANGED'].includes(payment.data.code), JSON.stringify(payment));
    const row = h.sales.get(sale.id, { role: 'owner' });
    assert.equal(row.status, 'needs_reconciliation');
    assert.equal(row.prepared_total, 10000, 'Original prepared amount remains available for review.');
    assert.equal(row.total, 10000, 'Unverified Woo drift cannot replace the saved POS amount.');
    assert.equal(h.api.state.updates, 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='sale.paid'").get().n, 0);
  }
});

test('later Woo edits cannot overwrite an already paid POS receipt or its original timestamp', async t => {
  const h = await harness(t, { mode: 'live' });
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 10000, confirmed: true });
  const before = h.sales.get(sale.id, { role: 'owner' });
  const order = h.api.state.orders[0];
  order.total = '105.00';
  order.line_items[0].total = order.line_items[0].subtotal = '105.00';
  order.line_items[0].name = 'Changed after receipt';
  order.number = 'new-display-number';
  const reviewed = (await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale;
  assert.equal(reviewed.status, 'needs_reconciliation');
  const kept = h.sales.get(sale.id, { role: 'owner' });
  for (const field of ['total', 'tax', 'subtotal', 'number', 'items_json', 'paid_at', 'prepared_total']) {
    assert.equal(kept[field], before[field], `${field} was preserved for historical review`);
  }
  const observations = (await h.request(`/sales/${sale.id}/events`, { token: h.owner })).data.events;
  assert.equal(observations.find(event => event.event === 'woo.state_observed').details.remoteTotalCents, 10500);
  order.total = '100.00';
  order.line_items[0].total = order.line_items[0].subtotal = '100.00';
  const returned = (await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale;
  assert.equal(returned.status, 'paid');
  assert.equal(h.sales.get(sale.id, { role: 'owner' }).items_json, before.items_json);
  assert.equal(h.sales.get(sale.id, { role: 'owner' }).number, before.number);
  order.date_paid_gmt = new Date(Date.now() + 60000).toISOString();
  assert.equal((await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale.status, 'needs_reconciliation');
  assert.equal(h.sales.get(sale.id, { role: 'owner' }).paid_at, before.paid_at);
});

test('wrong variation parent/ID and invalid Woo price fail before any remote create', async t => {
  for (const variationOverride of [{ parent_id: 999 }, { id: 999 }, { price: 'not-a-price' }]) {
    const h = await harness(t);
    h.api.state.variationOverride = variationOverride;
    const attempted = await post(h, '/sales/prepare', cart());
    assert.ok([409, 502].includes(attempted.status));
    assert.equal(h.api.state.creates, 0);
    assert.equal(h.db.prepare('SELECT status FROM sales LIMIT 1').get().status, 'failed');
  }
});

test('a previously paid sale under remote review keeps its recorded drawer cash and report row', async t => {
  const h = await harness(t, { mode: 'live', requireShift: true });
  const shift = (await post(h, '/shifts/open', { openingFloat: 1000 })).data.shift;
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  assert.equal((await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 10000, confirmed: true })).data.sale.status, 'paid');
  const recordedAt = h.sales.get(sale.id, { role: 'owner' }).paid_at;
  h.api.state.orders[0].currency = 'USD';
  const reviewed = (await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale;
  assert.equal(reviewed.status, 'needs_reconciliation');
  assert.equal(reviewed.paidAt, recordedAt);
  const shiftView = h.shifts.view(h.shifts.get(shift.id, { role: 'owner' }));
  assert.equal(shiftView.expectedCash, 11000, 'A remote discrepancy is not a cash-out.');
  assert.equal(shiftView.summary.cash, 10000);
  assert.equal(shiftView.summary.reviewRequiredOrders, 1);
  const report = (await h.request('/reports?days=1', { token: h.owner })).data;
  assert.equal(report.orders, 1, 'A previously paid receipt does not disappear from historical reports.');
  assert.equal(report.total, 10000);
  assert.equal(report.reviewRequiredOrders, 1);
  assert.equal(report.sales[0].status, 'needs_reconciliation');
  assert.equal((await post(h, `/shifts/${shift.id}/close`, { closingCash: 11000 })).status, 409,
    'Do not close a shift with an unresolved paid-order discrepancy.');
  h.api.state.orders[0].currency = 'GHS';
  assert.equal((await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale.status, 'paid');
  assert.equal((await post(h, `/shifts/${shift.id}/close`, { closingCash: 11000 })).data.shift.variance, 0);
});

test('cash refund after shift close leaves frozen counts intact and does not invent a payout shift', async t => {
  const h = await harness(t, { mode: 'live', requireShift: true });
  const first = (await post(h, '/shifts/open', { openingFloat: 1000 })).data.shift;
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  assert.equal(sale.shiftId, first.id);
  assert.equal((await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 10000, confirmed: true })).data.sale.status, 'paid');
  const closed = (await post(h, `/shifts/${first.id}/close`, { closingCash: 11000 })).data.shift;
  assert.equal(closed.expectedCash, 11000);
  const second = (await post(h, '/shifts/open', { openingFloat: 3000 })).data.shift;
  h.api.state.orders[0].refunds = [{ id: 42, total: '-40.00' }];
  const refreshed = (await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale;
  assert.equal(refreshed.refunded, 4000);
  assert.equal(refreshed.status, 'partially_refunded');
  const firstAfter = h.shifts.get(first.id, { role: 'owner' });
  assert.equal(h.shifts.view(firstAfter).expectedCash, 11000);
  assert.deepEqual(h.shifts.view(firstAfter).summary, closed.summary);
  assert.equal(h.shifts.current(h.db.prepare("SELECT id FROM users WHERE role='owner'").get().id).expectedCash, 3000);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM cash_movements').get().n, 0);
  const queued = (await h.request('/recovery/queue', { token: h.owner })).data.sales.find(row => row.id === sale.id);
  assert.deepEqual([queued.originalShiftId, queued.originalShiftStatus, queued.cashPayoutUnverified], [first.id, 'closed', true]);
  const events = (await h.request(`/sales/${sale.id}/events`, { token: h.owner })).data.events;
  assert.equal(events.filter(e => e.event === 'refund.observed').length, 1);
  assert.equal(events.find(e => e.event === 'refund.observed').amountCents, 4000);
  await post(h, `/sales/${sale.id}/reconcile`, {});
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='refund.observed'").get(sale.id).n, 1);
  assert.throws(() => h.db.prepare("UPDATE shifts SET expected_cash=0 WHERE id=?").run(first.id), /Closed shifts are immutable/);
  assert.throws(() => h.db.prepare('INSERT INTO cash_movements(id,shift_id,user_id,type,amount,reason,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), first.id, 'fixture', 'out', 100, 'Backdated payout', new Date().toISOString()),
  /Closed shifts cannot receive cash movements/);
  assert.equal(second.status, 'open');
});

test('a Woo refunded status without refund amounts cannot be treated as a settled sale', async t => {
  const h = await harness(t, { mode: 'live' });
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 10000, confirmed: true });
  h.api.state.orders[0].status = 'refunded';
  const reviewed = (await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale;
  assert.equal(reviewed.status, 'needs_reconciliation');
  assert.equal(reviewed.refunded, 0);
  assert.match(reviewed.error, /no refund amounts/);
});

test('an open shift does not subtract observed refunds without evidence of an actual cash payout', async t => {
  const h = await harness(t, { mode: 'live', requireShift: true });
  const shift = (await post(h, '/shifts/open', { openingFloat: 1000 })).data.shift;
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 10000, confirmed: true });
  h.api.state.orders[0].refunds = [{ id: 42, total: '-40.00' }];
  assert.equal((await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale.refunded, 4000);
  const open = h.shifts.current(h.db.prepare("SELECT id FROM users WHERE role='owner'").get().id);
  assert.equal(open.expectedCash, 11000, 'Expected drawer is float plus cash received, not the net Woo order.');
  assert.equal(open.summary.cash, 10000);
  assert.equal(open.summary.net, 6000, 'Financial report still records the Woo refund.');
  assert.equal(open.summary.observedCashRefunds, 4000);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM cash_movements').get().n, 0);
  const closed = (await post(h, `/shifts/${shift.id}/close`, { closingCash: 11000 })).data.shift;
  assert.equal(closed.expectedCash, 11000);
  assert.equal(closed.variance, 0);
});

test('a disappearing Woo refund keeps the last observed amount and requires review', async t => {
  const h = await harness(t, { mode: 'live' });
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 10000, confirmed: true });
  h.api.state.orders[0].refunds = [{ total: '-40.00' }];
  assert.equal((await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale.refunded, 4000);
  h.api.state.orders[0].refunds = [];
  const changed = (await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale;
  assert.equal(changed.status, 'needs_reconciliation');
  assert.equal(changed.refunded, 4000, 'Do not erase a historical refund observation.');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='refund.decreased_remotely'").get(sale.id).n, 1);
  h.api.state.orders[0].refunds = [{ total: '+40.00' }];
  assert.equal((await post(h, `/sales/${sale.id}/reconcile`, {})).data.code, 'RECONCILIATION_REQUIRED');
  assert.equal(h.sales.get(sale.id, { role: 'owner' }).refunded, 4000);
});

test('a Woo cancellation after an interrupted POS payment cannot close the shift as if no cash was taken', async t => {
  const h = await harness(t, { mode: 'live', requireShift: true });
  const shift = (await post(h, '/shifts/open', { openingFloat: 1000 })).data.shift;
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  h.api.state.losePayment = true;
  assert.equal((await post(h, `/sales/${sale.id}/pay`, { method: 'cash', tendered: 10000, confirmed: true })).data.code, 'RECONCILIATION_REQUIRED');
  const order = h.api.state.orders[0];
  order.status = 'cancelled'; order.date_paid_gmt = null;
  const checked = (await post(h, `/sales/${sale.id}/reconcile`, {})).data.sale;
  assert.equal(checked.status, 'needs_reconciliation');
  assert.equal(checked.paymentMethod, 'cash');
  assert.equal(h.shifts.view(h.shifts.get(shift.id, { role: 'owner' })).expectedCash, 1000,
    'The interrupted payment intent is not proof of cash received; closing remains blocked for review.');
  assert.equal((await post(h, `/shifts/${shift.id}/close`, { closingCash: 11000 })).status, 409);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='sale.cancelled'").get().n, 0);
});

test('cashier is denied owner recovery/audit data and password reset revokes sessions', async t => {
  const h = await harness(t);
  const sale = (await post(h, '/sales/prepare', cart())).data.sale;
  const staff = (await post(h, '/staff', { name: 'Fixture Cashier', username: 'phase1.cashier', role: 'cashier', password: 'phase-one-cashier-secret-123' })).data.user;
  const login = (await post(h, '/auth/login', { username: staff.username, password: 'phase-one-cashier-secret-123' }, null)).data.token;
  assert.equal((await post(h, '/auth/password', { currentPassword: 'phase-one-cashier-secret-123', newPassword: 'phase-one-cashier-rotated-123' }, login)).status, 200);
  for (const route of ['/recovery/queue', `/sales/${sale.id}/events`, '/audit', '/staff']) {
    assert.equal((await h.request(route, { token: login })).status, 403, route);
  }
  assert.equal((await post(h, `/staff/${staff.id}/password`, { newPassword: 'phase-one-cashier-reset-123' })).status, 200);
  assert.equal((await h.request('/catalog', { token: login })).status, 401);
  assert.ok(h.db.prepare("SELECT id FROM audit WHERE action='staff.password_reset'").get());
  assert.throws(() => h.db.prepare("DELETE FROM audit WHERE action='staff.password_reset'").run(), /Audit is append-only/);
  assert.throws(() => h.db.prepare("UPDATE sale_events SET event='spoofed' WHERE sale_id=?").run(sale.id), /Sale events are append-only/);
});

test('session credentials reject conflicting cookie/header and do not audit a guessed username', async t => {
  const h = await harness(t);
  const conflict = await fetch(`${h.base}/api/catalog`, { headers: {
    Authorization: `Bearer ${h.owner}`, Cookie: `mansu_session=${'a'.repeat(64)}`,
  } });
  assert.equal(conflict.status, 401);
  const fallback = await fetch(`${h.base}/api/catalog`, { headers: { 'X-Mansu-Session': h.owner } });
  assert.equal(fallback.status, 200);
  assert.equal((await post(h, '/auth/login', { username: 'private-guessed-user', password: 'wrong-passphrase' }, null)).status, 401);
  const anonymous = h.db.prepare("SELECT subject FROM audit WHERE action='auth.failed' AND actor='anonymous' ORDER BY id DESC LIMIT 1").get();
  assert.ok(anonymous);
  assert.doesNotMatch(anonymous.subject, /private-guessed-user/);
});

test('bounded Woo key search refuses two matches, truncated pages, and missing pagination evidence', async () => {
  const env = { POS_MODE: 'staging', WOO_BASE_URL: 'https://staging.example.com',
    WOO_CONSUMER_KEY: 'ck_fake', WOO_CONSUMER_SECRET: 'cs_fake' };
  const woo = new WooCommerce(readConfig(env));
  const key = randomUUID();
  const pageData = page => Array.from({ length: 100 }, (_, i) => ({ id: page * 100 + i,
    meta_data: i === 0 ? [{ key: '_mansu_pos_key', value: key }] : [] }));
  woo.request = async (_resource, { query }) => ({ data: pageData(query.page), pages: 2, total: 200, totalKnown: true });
  await assert.rejects(woo.findOrderByKey(key, new Date().toISOString()), /Multiple WooCommerce orders/);
  woo.request = async (_resource, { query }) => ({ data: pageData(query.page).map(order => ({ ...order, meta_data: [] })), pages: 11, total: 1100, totalKnown: true });
  await assert.rejects(woo.findOrderByKey(key, new Date().toISOString()), /exceeded ten pages/);
  woo.request = async () => ({ data: [{ id: 700, meta_data: [{ key: '_mansu_pos_key', value: key }] }], pages: 1, total: 1, totalKnown: true });
  assert.equal((await woo.findOrderByKey(key, new Date().toISOString())).id, 700);
  woo.request = async (_resource, { query }) => ({ data: query.page === 1 ? pageData(1) : [], pages: 2, total: 101, totalKnown: true });
  await assert.rejects(woo.findOrderByKey(key, new Date().toISOString()), /incomplete order search/,
    'A match on page one cannot be adopted if a second reported page is empty.');
  woo.request = async (_resource, { query }) => ({ data: query.page === 1 ? pageData(1) : [], pages: 2,
    total: query.page === 1 ? 101 : 100, totalKnown: true });
  await assert.rejects(woo.findOrderByKey(key, new Date().toISOString()), /incomplete order search/,
    'Changing pagination totals are not evidence of a complete uniqueness search.');
  const headerless = new WooCommerce(readConfig(env), async () => new Response('[]', {
    headers: { 'Content-Type': 'application/json' },
  }));
  await assert.rejects(headerless.findOrderByKey(key, new Date().toISOString()), /incomplete order search/);
  const missingTotal = new WooCommerce(readConfig(env), async () => new Response('[]', {
    headers: { 'Content-Type': 'application/json', 'X-WP-TotalPages': '1' },
  }));
  await assert.rejects(missingTotal.findOrderByKey(key, new Date().toISOString()), /incomplete order search/);
});
