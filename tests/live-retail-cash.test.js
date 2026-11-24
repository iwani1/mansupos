import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { RemoteError } from '../server/errors.js';

// Owner-chosen first release: direct cash-only RETAIL to WooCommerce on a
// separate production trading service, without the reservation bridge.
const tradingEnv = {
  NODE_ENV: 'production', POS_MODE: 'live', WOO_BASE_URL: 'https://www.mansutrendzgh.com',
  WOO_CONSUMER_KEY: 'ck_synthetic', WOO_CONSUMER_SECRET: 'cs_synthetic',
  POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com', POS_ALLOW_LIVE_WRITES: 'true',
  POS_OWNER_APPROVAL_REFERENCE: 'owner-chat-2026-11-16-cash-retail', POS_REQUIRE_SHIFT: 'true',
  POS_LIVE_RETAIL_CASH_DIRECT: 'true',
};

test('direct retail cash enables only cash retail writes on a production live trading service', () => {
  const config = readConfig(tradingEnv);
  assert.equal(config.liveRetailCashDirect, true);
  assert.equal(config.legacyLiveCheckoutBlocked, false);
  assert.equal(config.writesEnabled, true);
  assert.equal(config.wholesaleWritesEnabled, false);
  assert.deepEqual(config.paymentMethods, ['cash']);
  assert.equal(config.requireShift, true);
  assert.equal(config.websiteHoldMinutes, 60);
});

test('direct retail cash refuses unsafe combinations and the read-only pilot', () => {
  const bad = [
    { POS_LIVE_READ_ONLY: 'true', POS_ALLOW_LIVE_WRITES: 'false' },
    { POS_ALLOW_LIVE_WRITES: 'false' },
    { POS_OWNER_APPROVAL_REFERENCE: 'short' },
    { POS_REQUIRE_SHIFT: 'false' },
    { POS_LIVE_WHOLESALE_APPROVED: 'true' },
    { POS_LIVE_WHOLESALE_APPROVED: 'true', POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE: 'owner-chat-2026-11-16-cash-retail' },
    { POS_LIVE_WHOLESALE_APPROVED: 'yes', POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE: 'wholesale-reference' },
    { POS_INSTORE_CASH_APPROVED: 'true' },
    { POS_DESKTOP_SETUP_APPROVED: 'true' },
    { WOO_CONSUMER_KEY: '' },
    { POS_LIVE_RETAIL_CASH_DIRECT: 'yes' },
    { POS_WEBSITE_HOLD_MINUTES: '0' },
  ];
  for (const change of bad) assert.throws(() => readConfig({ ...tradingEnv, ...change }), Error, JSON.stringify(change));
  assert.throws(() => readConfig({ ...tradingEnv, POS_MODE: 'staging', WOO_BASE_URL: 'https://staging.example.com' }));
});

test('cash-only wholesale can be added to direct retail cash with its own acceptance reference', () => {
  const config = readConfig({ ...tradingEnv, POS_LIVE_WHOLESALE_APPROVED: 'true', POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE: 'owner-chat-2026-11-24-wholesale' });
  assert.equal(config.liveRetailCashDirect, true);
  assert.equal(config.wholesaleWritesEnabled, true);
  assert.deepEqual(config.paymentMethods, ['cash'], 'Wholesale on the live till is cash only');
  assert.equal(readConfig({ ...tradingEnv, POS_LIVE_WHOLESALE_APPROVED: 'false', POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE: 'owner-chat-2026-11-24-wholesale' }).wholesaleWritesEnabled, false);
});

test('without the explicit switch, production live checkout stays locked', () => {
  const config = readConfig({ ...tradingEnv, POS_LIVE_RETAIL_CASH_DIRECT: 'false' });
  assert.equal(config.legacyLiveCheckoutBlocked, true);
  assert.equal(config.writesEnabled, false);
});

function fakeApi() {
  const state = { orders: [], recent: [], creates: 0, updates: 0, stock: 1, recentFails: false };
  const product = { id: 10, name: 'Test Dress', type: 'variable', sku: 'DRESS', price: '100.00', images: [], categories: [{ name: 'Dresses' }], status: 'publish', purchasable: true, manage_stock: false, stock_status: 'instock', backorders: 'no', permalink: 'https://www.mansutrendzgh.com/p' };
  const variation = () => ({ id: 11, sku: 'DRESS-M', price: '100.00', attributes: [{ name: 'Size', option: 'M' }], manage_stock: true, stock_quantity: state.stock, stock_status: state.stock > 0 ? 'instock' : 'outofstock', backorders: 'no', purchasable: true });
  const view = o => ({ ...o, line_items: o.line_items.map(i => ({ ...i, id: 1, name: 'Test Dress', sku: 'DRESS-M', price: 100, subtotal: '100.00', total: '100.00', total_tax: '0.00' })), refunds: [] });
  return {
    state,
    async request() { throw new Error('Unexpected request'); },
    async products() { return { data: [product], total: 1, pages: 1 }; },
    async variations() { return { data: [variation()], total: 1, pages: 1 }; },
    async product() { return product; },
    async variation() { return variation(); },
    async recentOrders() {
      if (state.recentFails) throw new RemoteError('timeout', 502);
      return { data: [...state.recent, ...state.orders.map(view)], total: state.recent.length + state.orders.length, pages: 1, paginationKnown: true };
    },
    async createOrder(body) { state.creates++; const o = { ...body, id: 900 + state.creates, number: String(900 + state.creates), currency: 'GHS', total: '100.00', total_tax: '0.00', date_paid: null }; state.orders.push(o); return view(o); },
    async updateOrder(id, body) { state.updates++; const o = state.orders.find(x => x.id === id); const { meta_data, ...rest } = body; Object.assign(o, rest); if (meta_data) o.meta_data = [...o.meta_data, ...meta_data]; if (body.set_paid) { o.date_paid = new Date().toISOString(); state.stock -= 1; } return view(o); },
    async order(id) { return view(state.orders.find(o => o.id === id)); },
    async findOrderByKey() { return null; },
  };
}

async function harness(t, extraEnv = {}, api = fakeApi()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-retail-cash-'));
  // NODE_ENV=test keeps cookies/origin checks simple; the gate itself is the
  // same explicit switch and still requires shifts, approval and no wholesale.
  const env = { ...tradingEnv, NODE_ENV: 'test', POS_PUBLIC_ORIGIN: '', POS_DATA_DIR: dir, POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'test-secret-passphrase-123', ...extraEnv };
  const instance = createApp({ env, api, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  let token = (await request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'test-secret-passphrase-123' } })).data.token;
  await request('/auth/password', { method: 'POST', token, body: { currentPassword: 'test-secret-passphrase-123', newPassword: 'rotated-secret-passphrase-123' } });
  assert.equal((await request('/shifts/open', { method: 'POST', token, body: { openingFloat: 5000 } })).status, 201);
  t.after(async () => { await new Promise(r => server.close(r)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...instance, api, request, token };
}
const cartOf = () => ({ idempotencyKey: randomUUID(), items: [{ productId: 10, variationId: 11, quantity: 1 }] });
const websiteHold = { id: 777, number: '777', status: 'pending', line_items: [{ product_id: 10, variation_id: 11, quantity: 1 }] };

test('a last unit held by an unpaid website checkout cannot be sold or create a Woo order', async t => {
  const h = await harness(t);
  h.api.state.recent = [websiteHold];
  const blocked = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cartOf() });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'LAST_UNIT_HELD');
  assert.match(blocked.data.error, /#777/);
  assert.equal(h.api.state.creates, 0, 'No Woo order is created while the unit is held');
});

test('a hold that appears after preparation blocks payment but keeps the sale payable', async t => {
  const h = await harness(t);
  const prepared = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cartOf() });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  h.api.state.recent = [websiteHold];
  const id = prepared.data.sale.id;
  const blocked = await h.request(`/sales/${id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 10000, confirmed: true } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'LAST_UNIT_HELD');
  assert.equal(h.api.state.updates, 0, 'No paid write to Woo');
  assert.equal(h.db.prepare('SELECT status FROM sales WHERE id=?').get(id).status, 'awaiting_payment');
  h.api.state.recent = [{ ...websiteHold, status: 'cancelled' }];
  const paid = await h.request(`/sales/${id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 10000, confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.status, 'paid');
  assert.equal(h.api.state.stock, 0);
});

test('own POS order is ignored, but another unpaid POS order for the last unit blocks a second sale', async t => {
  const h = await harness(t);
  const first = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cartOf() });
  assert.equal(first.status, 201);
  const second = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: { ...cartOf(), note: 'second till' } });
  assert.equal(second.status, 409);
  assert.equal(second.data.code, 'LAST_UNIT_HELD');
});

test('if the order list cannot be read, a last-unit sale fails closed; plentiful stock is unaffected', async t => {
  const h = await harness(t);
  h.api.state.recentFails = true;
  const blocked = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cartOf() });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.data.code, 'LAST_UNIT_UNVERIFIED');
  h.api.state.stock = 5;
  const ok = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cartOf() });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
});

test('wholesale stays locked under direct retail cash', async t => {
  const h = await harness(t);
  const res = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: { ...cartOf(), saleType: 'wholesale', wholesaleApproved: true, items: [{ productId: 10, variationId: 11, quantity: 1, agreedUnitPrice: 5000 }] } });
  assert.equal(res.status, 403);
  assert.equal(res.data.code, 'WHOLESALE_CHECKOUT_LOCKED');
});

// Woo with taxes off (the live store's setting): line totals follow REST
// updates and the order total is recalculated, as WooCommerce does.
function wholesaleApi() {
  const api = fakeApi();
  const view = o => ({ ...o, fee_lines: [], coupon_lines: [], shipping_lines: [], shipping_total: '0.00', discount_total: '0.00', total: o.line_items.reduce((s, i) => s + Number(i.total), 0).toFixed(2), total_tax: '0.00', tax_lines: [], refunds: [],
    line_items: o.line_items.map(i => ({ ...i, name: 'Test Dress', sku: 'DRESS-M', total_tax: '0.00' })) });
  api.createOrder = async body => { api.state.creates++; const o = { ...body, id: 900 + api.state.creates, number: String(900 + api.state.creates), currency: 'GHS', date_paid: null,
    line_items: body.line_items.map((i, n) => ({ ...i, id: n + 1, price: 100, subtotal: (100 * i.quantity).toFixed(2), total: (100 * i.quantity).toFixed(2) })) }; api.state.orders.push(o); return view(o); };
  api.updateOrder = async (id, body) => { api.state.updates++; const o = api.state.orders.find(x => x.id === id);
    const { meta_data, line_items, ...rest } = body; Object.assign(o, rest);
    for (const change of line_items || []) Object.assign(o.line_items.find(i => i.id === change.id), { subtotal: change.subtotal, total: change.total });
    if (meta_data) o.meta_data = [...o.meta_data, ...meta_data];
    if (body.set_paid) { o.date_paid = new Date().toISOString(); api.state.stock -= o.line_items.reduce((s, i) => s + i.quantity, 0); }
    return view(o); };
  api.order = async id => view(api.state.orders.find(o => o.id === id));
  api.recentOrders = async () => ({ data: api.state.orders.map(view), total: api.state.orders.length, pages: 1, paginationKnown: true });
  return api;
}
const wholesaleEnv = { POS_LIVE_WHOLESALE_APPROVED: 'true', POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE: 'owner-chat-2026-11-24-wholesale' };
const wholesaleCart = (price = 8000, quantity = 2) => ({ idempotencyKey: randomUUID(), saleType: 'wholesale', wholesaleApproved: true, buyerName: 'Ama Boutique',
  items: [{ productId: 10, variationId: 11, quantity, agreedUnitPrice: price }] });

test('switched on, a live wholesale sale is repriced in Woo, paid in cash on the shift and lowers stock', async t => {
  const api = wholesaleApi(); api.state.stock = 5;
  const h = await harness(t, wholesaleEnv, api);
  const prepared = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: wholesaleCart() });
  assert.equal(prepared.status, 201, JSON.stringify(h.db.prepare('SELECT error FROM sales').all()));
  assert.equal(prepared.data.sale.total, 16000, 'Agreed GH₵80 x 2, not the GH₵100 catalogue price');
  assert.equal(api.state.orders[0].line_items[0].total, '160.00');
  assert.equal(api.state.orders[0].billing.first_name, 'Ama Boutique');
  const momo = await h.request(`/sales/${prepared.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'momo', reference: 'MOMO-1', confirmed: true } });
  assert.equal(momo.status, 403);
  assert.equal(momo.data.code, 'PAYMENT_METHOD_LOCKED');
  const paid = await h.request(`/sales/${prepared.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 20000, confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.status, 'paid');
  assert.equal(paid.data.sale.changeDue, 4000);
  assert.equal(api.state.stock, 3);
  assert.equal(api.state.orders[0].line_items[0].price, 100, 'Catalogue price is untouched');
});

test('live wholesale still refuses cashiers and last units held by unpaid orders', async t => {
  const api = wholesaleApi();
  const h = await harness(t, wholesaleEnv, api);
  const created = await h.request('/staff', { method: 'POST', token: h.token, body: { username: 'kofi', name: 'Kofi', role: 'cashier', password: 'cashier-secret-phrase-1' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const cashier = (await h.request('/auth/login', { method: 'POST', body: { username: 'kofi', password: 'cashier-secret-phrase-1' } })).data.token;
  await h.request('/auth/password', { method: 'POST', token: cashier, body: { currentPassword: 'cashier-secret-phrase-1', newPassword: 'cashier-rotated-phrase-2' } });
  const refused = await h.request('/sales/prepare', { method: 'POST', token: cashier, body: wholesaleCart(8000, 1) });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.code, 'WHOLESALE_ROLE_REQUIRED');
  api.state.orders.push({ ...websiteHold, currency: 'GHS', line_items: [{ ...websiteHold.line_items[0], id: 1, total: '100.00', subtotal: '100.00' }] });
  const held = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: wholesaleCart(8000, 1) });
  assert.equal(held.status, 409);
  assert.equal(held.data.code, 'LAST_UNIT_HELD');
});

test('the live till refuses items whose stock WooCommerce does not track', async t => {
  const h = await harness(t);
  const original = h.api.variation;
  h.api.variation = async () => ({ ...(await original()), manage_stock: false, stock_quantity: null });
  const res = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cartOf() });
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'STOCK_NOT_TRACKED');
  assert.equal(h.api.state.creates, 0, 'No Woo order for an untracked item');
});

test('untouched unpaid POS orders are cancelled after the abandon window; fresh and attempted ones are kept', async t => {
  const h = await harness(t);
  h.api.state.stock = 5;
  const old = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cartOf() });
  const fresh = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: { ...cartOf(), note: 'fresh' } });
  assert.equal(old.status, 201); assert.equal(fresh.status, 201);
  const longAgo = new Date(Date.now() - 3 * 3600000).toISOString();
  h.db.prepare('UPDATE sales SET created_at=? WHERE id=?').run(longAgo, old.data.sale.id);
  const result = await h.sales.cancelAbandoned();
  assert.deepEqual(result, { checked: 1, cancelled: 1 });
  assert.equal(h.db.prepare('SELECT status FROM sales WHERE id=?').get(old.data.sale.id).status, 'cancelled');
  assert.equal(h.api.state.orders[0].status, 'cancelled', 'Woo order cancelled too');
  assert.equal(h.db.prepare('SELECT status FROM sales WHERE id=?').get(fresh.data.sale.id).status, 'awaiting_payment');
  // A sale with a recorded payment attempt is never auto-cancelled.
  h.db.prepare("UPDATE sales SET created_at=?, payment_method='cash' WHERE id=?").run(longAgo, fresh.data.sale.id);
  assert.deepEqual(await h.sales.cancelAbandoned(), { checked: 0, cancelled: 0 });
});

// Last-unit protection: the Mansu POS Stock Hold plugin reserves the order's
// stock with WooCommerce's own checkout reservation.
const holdEnv = { POS_STOCK_HOLD_ENABLED: 'true' };
function holdApi(result = 'ok') {
  const api = fakeApi();
  api.state.stock = 5;
  api.state.holds = [];
  api.state.holdResult = result;
  api.stockHold = async (orderId, minutes) => {
    api.state.holds.push({ orderId, minutes });
    if (api.state.holdResult === 'refused') {
      const error = new RemoteError('WooCommerce rejected the request (HTTP 409).', 502);
      error.wooStatus = 409; error.wooCode = 'mansu_stock_unavailable'; error.wooMessage = 'Not enough units of Test Dress are available in stock to fulfil this order.';
      throw error;
    }
    if (api.state.holdResult === 'down') throw new RemoteError('The store could not be reached.', 502, true);
    return { held: true, orderId, minutes };
  };
  return api;
}

test('stock hold switch is validated and never active in demo', () => {
  assert.equal(readConfig({ ...tradingEnv, ...holdEnv }).stockHoldEnabled, true);
  assert.equal(readConfig(tradingEnv).stockHoldEnabled, false);
  assert.throws(() => readConfig({ ...tradingEnv, POS_STOCK_HOLD_ENABLED: 'yes' }), /POS_STOCK_HOLD_ENABLED/);
  assert.equal(readConfig({ POS_MODE: 'demo', POS_STOCK_HOLD_ENABLED: 'true' }).stockHoldEnabled, false);
});

test('with the stock hold on, a sale holds its stock when prepared and again just before payment', async t => {
  const api = holdApi();
  const h = await harness(t, holdEnv, api);
  const prepared = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cartOf() });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  assert.equal(api.state.holds.length, 1);
  assert.equal(api.state.holds[0].orderId, api.state.orders[0].id);
  assert.equal(api.state.holds[0].minutes, 135, 'Covers the 120-minute abandon window');
  const paid = await h.request(`/sales/${prepared.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 10000, confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(api.state.holds.length, 2, 'Hold renewed before the paid write');
  const events = h.db.prepare("SELECT event FROM sale_events WHERE event LIKE 'woo.stock_%'").all().map(e => e.event);
  assert.deepEqual(events, ['woo.stock_held', 'woo.stock_held']);
});

test('when Woo refuses the hold (someone else is paying for the last unit), the till order is cancelled', async t => {
  const api = holdApi('refused');
  const h = await harness(t, holdEnv, api);
  const res = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cartOf() });
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'LAST_UNIT_HELD');
  assert.match(res.data.error, /Not enough units of Test Dress/);
  assert.equal(api.state.orders[0].status, 'cancelled', 'Woo order cancelled, so it holds nothing');
  assert.equal(h.db.prepare('SELECT status FROM sales').get().status, 'cancelled');
});

test('if the hold cannot be confirmed (plugin missing or store down), the sale fails closed', async t => {
  const api = holdApi('down');
  const h = await harness(t, holdEnv, api);
  const res = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cartOf() });
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'STOCK_HOLD_UNVERIFIED');
  assert.equal(api.state.orders[0].status, 'cancelled');
  assert.equal(h.db.prepare('SELECT status FROM sales').get().status, 'cancelled');
});

test('a hold refused at payment keeps the order unpaid and payable, with nothing written to Woo', async t => {
  const api = holdApi();
  const h = await harness(t, holdEnv, api);
  const prepared = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cartOf() });
  assert.equal(prepared.status, 201);
  api.state.holdResult = 'refused';
  const blocked = await h.request(`/sales/${prepared.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 10000, confirmed: true } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'LAST_UNIT_HELD');
  assert.equal(api.state.updates, 0);
  const row = h.db.prepare('SELECT status, payment_method FROM sales').get();
  assert.equal(row.status, 'awaiting_payment');
  assert.equal(row.payment_method, null);
});
