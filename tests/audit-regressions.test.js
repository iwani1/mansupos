import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { RemoteError } from '../server/errors.js';
import { paymentSchema, prepareSchema } from '../server/sales.js';

function fakeApi(opts = {}) {
  const state = { orders: [], creates: 0, updates: 0, stock: 10, refunds: [], driftTotal: opts.driftTotal, driftCurrency: opts.driftCurrency, failCancel: opts.failCancel, parentOut: opts.parentOut, soldIndividually: opts.soldIndividually };
  const product = { id: 10, name: 'Probe Dress', type: 'variable', sku: 'DRESS', price: '100.00', images: [], categories: [], status: 'publish', purchasable: true, manage_stock: false, stock_status: state.parentOut ? 'outofstock' : 'instock', backorders: 'no', sold_individually: Boolean(state.soldIndividually), ...opts.product };
  const variation = { id: 11, sku: 'DRESS-M', price: '100.00', attributes: [{ name: 'Size', option: 'M' }], manage_stock: true, stock_quantity: state.stock, stock_status: 'instock', backorders: 'no', purchasable: true };
  const variations = opts.variations || [variation];
  state.product = product;
  state.variations = variations;
  const view = o => ({ ...o, line_items: o.line_items.map(i => ({ ...i, name: 'Probe Dress', sku: 'DRESS-M', price: 100, subtotal: '100.00', total: '100.00', total_tax: '15.00', meta_data: [{ key: 'Size', value: 'M' }] })), refunds: state.refunds });
  return {
    state,
    async request() { return { data: [product], total: 1, pages: 1 }; },
    async products() { return { data: [product], total: 1, pages: 1 }; },
    async variations() { return { data: variations, total: variations.length, pages: 1 }; },
    async product() { return product; },
    async variation(_productId, id) { const found = variations.find(v => v.id === id); if (!found) throw new Error('Unexpected variation'); return found; },
    async createOrder(body) { state.creates++; const o = { ...body, id: 500 + state.creates, number: String(500 + state.creates), currency: 'GHS', total: '115.00', total_tax: '15.00', date_paid: null }; state.orders.push(o); return view(o); },
    async updateOrder(id, body) {
      state.updates++;
      if (body.status === 'cancelled' && state.failCancel) throw new RemoteError('timeout after remote cancel', 502, true);
      const o = state.orders.find(x => x.id === id);
      const { meta_data, ...rest } = body;
      Object.assign(o, rest);
      if (meta_data) { o.meta_data = o.meta_data || []; for (const m of meta_data) { const e = o.meta_data.find(x => x.key === m.key); if (e) e.value = m.value; else o.meta_data.push(m); } }
      if (body.set_paid) { const paid = new Date().toISOString().replace('Z', ''); o.date_paid = paid; o.date_paid_gmt = paid; if (state.driftTotal) o.total = '200.00'; if (state.driftCurrency) o.currency = state.driftCurrency; }
      return view(o);
    },
    async order(id) { return view(state.orders.find(x => x.id === id)); },
    async findOrderByKey(key) { const o = state.orders.find(o => o.meta_data?.some(m => m.key === '_mansu_pos_key' && m.value === key)); return o ? view(o) : null; },
  };
}
async function harness(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-regression-'));
  const api = fakeApi(opts);
  const env = { POS_MODE: 'staging', POS_DATA_DIR: dir, NODE_ENV: 'test', WOO_BASE_URL: 'https://staging.example.com', WOO_CONSUMER_KEY: 'ck_test', WOO_CONSUMER_SECRET: 'cs_test', POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'probe-secret-passphrase-123', POS_REQUIRE_SHIFT: 'false', POS_STAGING_APPROVED: 'true', ...(opts.env || {}) };
  const instance = createApp({ env, api, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, { method = 'GET', body, token, headers = {} } = {}) {
    const res = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  }
  let token = (await request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'probe-secret-passphrase-123' } })).data.token;
  await request('/auth/password', { method: 'POST', token, body: { currentPassword: 'probe-secret-passphrase-123', newPassword: 'probe-rotated-passphrase-123' } });
  t.after(async () => { await new Promise(r => server.close(r)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...instance, request, token, api, base };
}
const cart = (note = '') => ({ idempotencyKey: randomUUID(), items: [{ productId: 10, variationId: 11, quantity: 1 }], note });

test('same-key prepare retry is idempotent and new-key duplicate unpaid cart is blocked', async t => {
  const h = await harness(t);
  const input = cart();
  const a = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: input });
  const b = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: input });
  assert.equal(a.data.sale.id, b.data.sale.id);
  const c = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: { ...input, idempotencyKey: randomUUID() } });
  assert.equal(c.status, 409);
  assert.equal(c.data.code, 'RECONCILIATION_REQUIRED');
  assert.equal(h.api.state.creates, 1);
});

test('total drift during payment confirmation is blocked', async t => {
  const h = await harness(t, { driftTotal: true });
  const p = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart() });
  const pay = await h.request(`/sales/${p.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 11500, confirmed: true } });
  assert.equal(pay.status, 502);
  const sale = h.sales.get(p.data.sale.id, { role: 'owner' });
  assert.equal(sale.status, 'needs_reconciliation');
  assert.notEqual(sale.status, 'paid');
});

test('currency drift during payment confirmation is blocked', async t => {
  const h = await harness(t, { driftCurrency: 'USD' });
  const p = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart() });
  const pay = await h.request(`/sales/${p.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'momo', reference: 'PROBE-USD', confirmed: true } });
  assert.equal(pay.status, 502);
  const sale = h.sales.get(p.data.sale.id, { role: 'owner' });
  assert.equal(sale.status, 'needs_reconciliation');
  assert.equal(sale.currency, 'USD');
});

test('uncertain cancellation blocks subsequent payment', async t => {
  const h = await harness(t, { failCancel: true });
  const p = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart() });
  const c = await h.request(`/sales/${p.data.sale.id}/cancel`, { method: 'POST', token: h.token, body: {} });
  assert.equal(c.status, 502);
  const pay = await h.request(`/sales/${p.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 12000, confirmed: true } });
  assert.equal(pay.status, 409);
  const sale = h.sales.get(p.data.sale.id, { role: 'owner' });
  assert.equal(sale.status, 'needs_reconciliation');
});

test('sold-individually duplicate lines are aggregated and rejected', async t => {
  const h = await harness(t, { soldIndividually: true });
  const p = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: { idempotencyKey: randomUUID(), items: [{ productId: 10, variationId: 11, quantity: 1 }, { productId: 10, variationId: 11, quantity: 1 }], note: '' } });
  assert.equal(p.status, 409);
  assert.equal(h.api.state.creates, 0);
});

test('out-of-stock parent blocks in-stock variation', async t => {
  const h = await harness(t, { parentOut: true });
  const p = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart() });
  assert.equal(p.status, 409);
  assert.equal(h.api.state.creates, 0);
});

// These responses model the WooCommerce v3 variation API. A variation can report
// manage_stock='parent', true, or false; parent stock is one pool across options.
const option = (id, manageStock, stock, backorders = 'no', status = 'instock') => ({
  id, sku: `DRESS-${id}`, price: '100.00', attributes: [{ name: 'Size', option: String(id) }],
  manage_stock: manageStock, stock_quantity: stock, stock_status: status, backorders, purchasable: true,
});
const optionCart = (...pairs) => ({ idempotencyKey: randomUUID(), items: pairs.map(([variationId, quantity]) => ({ productId: 10, variationId, quantity })), note: '' });

test('sold-individually applies across different variations', async t => {
  const h = await harness(t, { soldIndividually: true, variations: [option(11, true, 5), option(12, true, 5)] });
  const result = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([11, 1], [12, 1]) });
  assert.equal(result.status, 409);
  assert.equal(h.api.state.creates, 0);
});

test('parent-managed variations share stock before order creation and on payment recheck', async t => {
  const h = await harness(t, { product: { manage_stock: true, stock_quantity: 3 }, variations: [option(11, 'parent', 3), option(12, 'parent', 3)] });
  const excess = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([11, 2], [12, 2]) });
  assert.equal(excess.status, 409);
  assert.equal(excess.data.code, 'INSUFFICIENT_STOCK');
  assert.equal(h.api.state.creates, 0, 'reject the whole cart before creating any Woo order');
  const catalog = await h.request('/catalog', { token: h.token });
  assert.deepEqual(catalog.data.products[0].variations.map(v => [v.stockSource, v.stock]), [['parent', 3], ['parent', 3]]);
  const exact = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([11, 2], [12, 1]) });
  assert.equal(exact.status, 201);
  assert.equal(h.api.state.creates, 1);
  h.api.state.product.stock_quantity = 2; // another channel used one unit after prepare
  const payment = await h.request(`/sales/${exact.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 11500, confirmed: true } });
  assert.equal(payment.status, 409);
  assert.equal(payment.data.code, 'INSUFFICIENT_STOCK');
  assert.equal(h.api.state.updates, 0, 'do not mark the Woo order paid after stock changes');
  assert.equal(h.sales.get(exact.data.sale.id, { role: 'owner' }).status, 'needs_reconciliation');
});

test('false or missing variation management conservatively inherits a managed parent', async t => {
  const h = await harness(t, { product: { manage_stock: true, stock_quantity: 3 }, variations: [option(11, false, 99), option(12, undefined, 99)] });
  const catalog = await h.request('/catalog', { token: h.token });
  assert.deepEqual(catalog.data.products[0].variations.map(v => [v.stockSource, v.stock]), [['parent', 3], ['parent', 3]]);
  const excess = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([11, 2], [12, 2]) });
  assert.equal(excess.status, 409);
  assert.equal(excess.data.code, 'INSUFFICIENT_STOCK');
  assert.equal(h.api.state.creates, 0);
});

test('independently managed variations do not consume parent or sibling stock', async t => {
  const h = await harness(t, { product: { manage_stock: true, stock_quantity: 3 }, variations: [option(11, 'parent', 3), option(12, true, 2), option(13, true, 2)] });
  const catalog = await h.request('/catalog', { token: h.token });
  assert.deepEqual(catalog.data.products[0].variations.map(v => [v.stockSource, v.stock]), [['parent', 3], ['variation', 2], ['variation', 2]]);
  const exact = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([11, 3], [12, 2], [13, 2]) });
  assert.equal(exact.status, 201);
  assert.equal(h.api.state.creates, 1);
  const excess = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([12, 3], [13, 1]) });
  assert.equal(excess.status, 409);
  assert.equal(excess.data.code, 'INSUFFICIENT_STOCK');
  assert.equal(h.api.state.creates, 1);
});

test('untracked stock is allowed but missing ownership or managed quantities fail closed', async t => {
  const untracked = await harness(t, { variations: [option(11, false, null)] });
  const catalog = await untracked.request('/catalog', { token: untracked.token });
  assert.equal(catalog.data.products[0].variations[0].stockSource, 'untracked');
  assert.equal((await untracked.request('/sales/prepare', { method: 'POST', token: untracked.token, body: optionCart([11, 20]) })).status, 201);
  const unknown = await harness(t, { variations: [option(11, undefined, null)] });
  const missingSource = await unknown.request('/sales/prepare', { method: 'POST', token: unknown.token, body: optionCart([11, 1]) });
  assert.equal(missingSource.status, 409);
  assert.equal(missingSource.data.code, 'STOCK_UNAVAILABLE');
  assert.equal(unknown.api.state.creates, 0);
  const missingQuantity = await harness(t, { product: { manage_stock: true, stock_quantity: null }, variations: [option(11, 'parent', null)] });
  const missingStock = await missingQuantity.request('/sales/prepare', { method: 'POST', token: missingQuantity.token, body: optionCart([11, 1]) });
  assert.equal(missingStock.status, 409);
  assert.equal(missingStock.data.code, 'STOCK_UNAVAILABLE');
  assert.equal(missingQuantity.api.state.creates, 0);
});

test('contradictory parent-stock ownership cannot be sold as a backorder', async t => {
  const h = await harness(t, { product: { manage_stock: false, backorders: 'yes' }, variations: [option(11, 'parent', null, 'yes')] });
  const catalog = await h.request('/catalog', { token: h.token });
  assert.equal(catalog.data.products[0].variations[0].stockSource, 'unknown');
  const result = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([11, 1]) });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'STOCK_UNAVAILABLE');
  assert.equal(h.api.state.creates, 0);
});

test('simple products also fail closed when stock management or quantity is missing', async t => {
  for (const product of [
    { type: 'simple', manage_stock: undefined, stock_quantity: 10 },
    { type: 'simple', manage_stock: true, stock_quantity: 'not-a-number' },
  ]) {
    const h = await harness(t, { product });
    const result = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: { idempotencyKey: randomUUID(), items: [{ productId: 10, quantity: 1 }] } });
    assert.equal(result.status, 409);
    assert.equal(result.data.code, 'STOCK_UNAVAILABLE');
    assert.equal(h.api.state.creates, 0);
  }
});

test('both Woo backorder policies allow shared-parent backorders', async t => {
  for (const policy of ['yes', 'notify']) {
    const inherited = option(12, 'parent', 0, policy, 'onbackorder');
    delete inherited.backorders;
    const h = await harness(t, { product: { manage_stock: true, stock_quantity: 0, stock_status: 'onbackorder', backorders: policy }, variations: [option(11, 'parent', 0, policy, 'onbackorder'), inherited] });
    const catalog = await h.request('/catalog', { token: h.token });
    assert.equal(catalog.data.products[0].variations[1].backorders, policy);
    const result = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([11, 2], [12, 2]) });
    assert.equal(result.status, 201, `${policy} should permit a backorder`);
    assert.equal(h.api.state.creates, 1);
  }
});

test('an explicit variation no-backorders policy overrides an inherited parent permission', async t => {
  const noBackorders = option(11, 'parent', 0, 'no', 'onbackorder');
  const h = await harness(t, {
    product: { manage_stock: true, stock_quantity: 0, stock_status: 'onbackorder', backorders: 'yes', backorders_allowed: true },
    variations: [noBackorders],
  });
  const catalog = await h.request('/catalog', { token: h.token });
  assert.equal(catalog.data.products[0].variations[0].backordersAllowed, false);
  const result = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([11, 1]) });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'INSUFFICIENT_STOCK');
  assert.equal(h.api.state.creates, 0);
});

test('every variation in a shared pool must permit its stock status and backorders', async t => {
  const first = option(11, 'parent', 3, 'no', 'outofstock');
  const second = option(12, 'parent', 3, 'yes');
  const h = await harness(t, { product: { manage_stock: true, stock_quantity: 3 }, variations: [first, second] });
  const unavailable = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([11, 1], [12, 1]) });
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.data.code, 'INSUFFICIENT_STOCK');
  first.stock_status = 'instock';
  const mixedPolicy = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([11, 2], [12, 2]) });
  assert.equal(mixedPolicy.status, 409, 'a later backorderable option cannot override the first option');
  first.backorders = 'notify';
  first.backorders_allowed = false; // Woo filters can explicitly disable backorders.
  const disabled = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: optionCart([11, 2], [12, 2]) });
  assert.equal(disabled.status, 409);
  assert.equal(h.api.state.creates, 0);
});

test('reconciliation sweep prioritizes interrupted sales over pending backlog', async t => {
  const h = await harness(t);
  for (let i = 0; i < 21; i++) await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart(`probe-${i}`) });
  const newest = h.db.prepare('SELECT id FROM sales ORDER BY created_at DESC, id DESC LIMIT 1').get();
  h.db.prepare("UPDATE sales SET status='needs_reconciliation',error='probe' WHERE id=?").run(newest.id);
  const sweep = await h.sales.reconcilePending();
  const after = h.db.prepare('SELECT status,last_reconciled_at FROM sales WHERE id=?').get(newest.id);
  assert.equal(sweep.checked, 20);
  assert.equal(after.status, 'awaiting_payment');
  assert.ok(after.last_reconciled_at);
});

test('full refund updates status, net reports, and closed shift snapshot stays immutable', async t => {
  const h = await harness(t);
  const shift = (await h.request('/shifts/open', { method: 'POST', token: h.token, body: { openingFloat: 10000 } })).data.shift;
  const p = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart() });
  await h.request(`/sales/${p.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 11500, confirmed: true } });
  await h.request(`/shifts/${shift.id}/close`, { method: 'POST', token: h.token, body: { closingCash: 21500 } });
  h.api.state.orders[0].status = 'refunded';
  h.api.state.refunds = [{ total: '-115.00' }];
  const rec = await h.request(`/sales/${p.data.sale.id}/reconcile`, { method: 'POST', token: h.token, body: {} });
  assert.equal(rec.data.sale.status, 'refunded');
  const report = (await h.request('/reports?days=1', { token: h.token })).data;
  assert.equal(report.total, 0);
  assert.equal(report.refundedOrders, 1);
  assert.equal(report.items, 0);
  assert.equal(report.topProducts.length, 0);
  const shifts = (await h.request('/shifts?days=1', { token: h.token })).data.shifts;
  assert.equal(shifts[0].expectedCash, 21500);
  assert.equal(shifts[0].summary.net, 11500);
});

test('idempotency fingerprint includes note', async t => {
  const h = await harness(t);
  const input = cart();
  const a = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: input });
  const b = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: { ...input, note: 'Different' } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 409);
});

test('simple products may explicitly send variationId zero', () => {
  const parsed = prepareSchema.parse({ idempotencyKey: randomUUID(), items: [{ productId: 10, variationId: 0, quantity: 1 }], note: '' });
  assert.equal(parsed.items[0].variationId, 0);
  assert.equal(prepareSchema.safeParse({ idempotencyKey: randomUUID(), items: [{ productId: 10, variationId: -1, quantity: 1 }] }).success, false);
});

test('configured public origin rejects same-host different-port or different-scheme mutations', async t => {
  const h = await harness(t, { env: { POS_PUBLIC_ORIGIN: 'https://pos.example.com' } });
  const body = { idempotencyKey: randomUUID(), items: [{ productId: 10, variationId: 11, quantity: 1 }], note: '' };
  const wrongPort = await h.request('/sales/prepare', { method: 'POST', token: h.token, body, headers: { Origin: 'https://pos.example.com:8443' } });
  const wrongScheme = await h.request('/sales/prepare', { method: 'POST', token: h.token, body, headers: { Origin: 'http://pos.example.com' } });
  assert.equal(wrongPort.status, 403);
  assert.equal(wrongScheme.status, 403);
  assert.equal(h.api.state.creates, 0);
});

test('payment reference rejects separated full card numbers', () => {
  for (const reference of ['4111-1111-1111-1111', '4111.1111.1111.1111', '4111 1111 1111 1111']) {
    assert.equal(paymentSchema.safeParse({ method: 'card', reference, confirmed: true }).success, false);
  }
  assert.equal(paymentSchema.safeParse({ method: 'card', reference: 'TERMINAL-001', confirmed: true }).success, true);
});

test('CSV export neutralizes leading whitespace/control formula prefixes', async t => {
  const h = await harness(t);
  const p = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart() });
  await h.request(`/sales/${p.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 11500, confirmed: true } });
  h.db.prepare('UPDATE sales SET payment_reference=? WHERE id=?').run(' \t=SUM(A1:A2)', p.data.sale.id);
  const res = await fetch(`${h.base}/api/reports/export?days=1`, { headers: { Authorization: `Bearer ${h.token}` } });
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.ok(csv.includes(`"' \t=SUM(A1:A2)"`), csv);
});

test('sales pagination and reports do not silently truncate at 10000 rows', async t => {
  const h = await harness(t);
  const p = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart() });
  await h.request(`/sales/${p.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 11500, confirmed: true } });
  const row = h.db.prepare('SELECT * FROM sales LIMIT 1').get();
  const insert = h.db.prepare('INSERT INTO sales(id,idempotency_key,fingerprint,number,status,currency,cashier_id,cashier_name,note,created_at,updated_at,paid_at,total,items_json,payment_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  h.db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 10001; i++) { const id = randomUUID(); const time = new Date(Date.now() + i).toISOString(); insert.run(id, id, 'probe', `PROBE-${i}`, 'paid', 'GHS', row.cashier_id, row.cashier_name, '', time, time, time, 100, '[]', 'cash'); }
  h.db.exec('COMMIT');
  const page = (await h.request('/sales?limit=500', { token: h.token })).data;
  assert.equal(page.sales.length, 500);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);
  const report = (await h.request('/reports?days=1', { token: h.token })).data;
  assert.equal(report.orders, 10002);
});
