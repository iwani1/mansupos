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
    { POS_LIVE_WHOLESALE_APPROVED: 'true', POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE: 'wholesale-reference' },
    { POS_INSTORE_CASH_APPROVED: 'true' },
    { POS_DESKTOP_SETUP_APPROVED: 'true' },
    { WOO_CONSUMER_KEY: '' },
    { POS_LIVE_RETAIL_CASH_DIRECT: 'yes' },
    { POS_WEBSITE_HOLD_MINUTES: '0' },
  ];
  for (const change of bad) assert.throws(() => readConfig({ ...tradingEnv, ...change }), Error, JSON.stringify(change));
  assert.throws(() => readConfig({ ...tradingEnv, POS_MODE: 'staging', WOO_BASE_URL: 'https://staging.example.com' }));
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

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-retail-cash-'));
  const api = fakeApi();
  // NODE_ENV=test keeps cookies/origin checks simple; the gate itself is the
  // same explicit switch and still requires shifts, approval and no wholesale.
  const env = { ...tradingEnv, NODE_ENV: 'test', POS_PUBLIC_ORIGIN: '', POS_DATA_DIR: dir, POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'test-secret-passphrase-123' };
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
