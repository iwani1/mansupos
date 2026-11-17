import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { RemoteError } from '../server/errors.js';
import { stockPools, inventoryWriteState } from '../server/inventory.js';

const tradingEnv = {
  NODE_ENV: 'production', POS_MODE: 'live', WOO_BASE_URL: 'https://www.mansutrendzgh.com',
  WOO_CONSUMER_KEY: 'ck_synthetic', WOO_CONSUMER_SECRET: 'cs_synthetic',
  POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com', POS_ALLOW_LIVE_WRITES: 'true',
  POS_OWNER_APPROVAL_REFERENCE: 'owner-chat-2026-11-16-cash-retail', POS_REQUIRE_SHIFT: 'true',
  POS_LIVE_RETAIL_CASH_DIRECT: 'true',
};
const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

test('inventory writes need their own switch on live and are never allowed on the read-only pilot', () => {
  assert.equal(readConfig(tradingEnv).inventoryWritesEnabled, false);
  assert.equal(readConfig({ ...tradingEnv, POS_INVENTORY_WRITES_APPROVED: 'true' }).inventoryWritesEnabled, true);
  assert.throws(() => readConfig({ ...tradingEnv, POS_INVENTORY_WRITES_APPROVED: 'yes' }));
  assert.throws(() => readConfig({ NODE_ENV: 'production', POS_MODE: 'live', POS_LIVE_READ_ONLY: 'true', POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com',
    WOO_CONSUMER_KEY: 'ck', WOO_CONSUMER_SECRET: 'cs', POS_INVENTORY_WRITES_APPROVED: 'true' }));
  // Without approved Woo writes, the inventory switch does nothing.
  assert.equal(readConfig({ ...tradingEnv, POS_LIVE_RETAIL_CASH_DIRECT: 'false', POS_INVENTORY_WRITES_APPROVED: 'true' }).inventoryWritesEnabled, false);
  assert.equal(readConfig({ POS_MODE: 'demo' }).inventoryWritesEnabled, true);
  assert.equal(inventoryWriteState({ mode: 'live', liveReadOnly: true }).enabled, false);
});

test('stock pools count shared parent stock once and classify low/out/untracked', () => {
  const rows = stockPools([
    { id: 1, name: 'Tee', type: 'simple', manageStock: true, stock: 2, stockSource: 'product', price: 1000, variations: [] },
    { id: 2, name: 'Dress', type: 'variable', price: 0, variations: [
      { id: 21, label: 'S', stockSource: 'parent', manageStock: true, stock: 9, price: 5000 },
      { id: 22, label: 'M', stockSource: 'parent', manageStock: true, stock: 9, price: 5000 }] },
    { id: 3, name: 'Bag', type: 'variable', variations: [
      { id: 31, label: 'Red', stockSource: 'variation', manageStock: true, stock: 0, price: 100 },
      { id: 32, label: 'Blue', stockSource: 'untracked', manageStock: false, stock: null, price: 100 }] },
  ], 5);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(r => [r.key, r.status]), [['1:0', 'low'], ['2:0', 'ok'], ['3:31', 'out'], ['3:32', 'untracked']]);
  assert.equal(rows[1].priceEditable, false);
});

function fakeWoo() {
  const state = { simple: { stock: 4, manage: true, regular: '100.00', sale: '' }, option: { stock: 1, manage: true, regular: '200.00', sale: '' }, untracked: { manage: false, stock: null }, writes: [], failNext: null };
  const simple = () => ({ id: 10, name: 'Plain Tee', type: 'simple', status: 'publish', sku: 'TEE', price: state.simple.sale || state.simple.regular, regular_price: state.simple.regular, sale_price: state.simple.sale, images: [], categories: [{ name: 'Tops' }], purchasable: true, manage_stock: state.simple.manage, stock_quantity: state.simple.stock, stock_status: state.simple.stock > 0 ? 'instock' : 'outofstock', backorders: 'no' });
  const parent = () => ({ id: 20, name: 'Wrap Dress', type: 'variable', status: 'publish', sku: 'DRESS', price: '200.00', images: [], categories: [{ name: 'Dresses' }], purchasable: true, manage_stock: false, stock_status: 'instock', backorders: 'no' });
  const option = () => ({ id: 21, parent_id: 20, sku: 'DRESS-M', price: state.option.regular, regular_price: state.option.regular, sale_price: state.option.sale, attributes: [{ name: 'Size', option: 'M' }], manage_stock: state.option.manage, stock_quantity: state.option.stock, stock_status: 'instock', backorders: 'no', purchasable: true });
  const loose = () => ({ id: 22, parent_id: 20, sku: 'DRESS-L', price: '200.00', regular_price: '200.00', sale_price: '', attributes: [{ name: 'Size', option: 'L' }], manage_stock: state.untracked.manage, stock_quantity: state.untracked.stock, stock_status: 'instock', backorders: 'no', purchasable: true });
  const apply = (target, body) => {
    if (state.failNext) { const error = state.failNext; state.failNext = null; throw error; }
    state.writes.push({ target, body });
    const record = target === 10 ? state.simple : target === 21 ? state.option : state.untracked;
    if ('stock_quantity' in body) { record.stock = body.stock_quantity; record.manage = true; }
    if ('regular_price' in body) { record.regular = body.regular_price; record.sale = body.sale_price; }
  };
  return {
    state,
    async request() { throw new Error('Unexpected request'); },
    async products() { return { data: [simple(), parent()], total: 2, pages: 1 }; },
    async variations() { return { data: [option(), loose()], total: 2, pages: 1 }; },
    async product(id) { return id === 10 ? simple() : parent(); },
    async variation(_p, id) { return id === 21 ? option() : loose(); },
    async updateProduct(id, body) { apply(id, body); return simple(); },
    async updateVariation(_p, id, body) { apply(id, body); return id === 21 ? option() : loose(); },
    async recentOrders() { return { data: [], total: 0, pages: 1, paginationKnown: true }; },
  };
}

async function harness(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-inventory-'));
  const api = fakeWoo();
  const env = { ...tradingEnv, NODE_ENV: 'test', POS_PUBLIC_ORIGIN: '', POS_DATA_DIR: dir, POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'test-secret-passphrase-123', POS_INVENTORY_WRITES_APPROVED: 'true', ...extraEnv };
  const instance = createApp({ env, api, logger: silent });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  let token = (await request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'test-secret-passphrase-123' } })).data.token;
  await request('/auth/password', { method: 'POST', token, body: { currentPassword: 'test-secret-passphrase-123', newPassword: 'rotated-secret-passphrase-123' } });
  token = (await request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'rotated-secret-passphrase-123' } })).data.token;
  t.after(async () => { await new Promise(r => server.close(r)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...instance, api, request, token };
}
const adjust = (h, body) => h.request('/inventory/adjust', { method: 'POST', token: h.token, body: { key: randomUUID(), variationId: 0, note: '', ...body } });

test('overview lists every stock line with POS-shared WooCommerce quantities', async t => {
  const h = await harness(t);
  const res = await h.request('/inventory', { token: h.token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.writes.enabled, true);
  assert.deepEqual(res.data.lines.map(l => [l.key, l.stock, l.status]), [['10:0', 4, 'low'], ['20:21', 1, 'low'], ['20:22', null, 'untracked']]);
  assert.equal(res.data.summary.unitsOnHand, 5);
  assert.equal(res.data.summary.retailValue, 4 * 10000 + 20000);
});

test('receiving and removing stock writes the new quantity to WooCommerce and records a movement', async t => {
  const h = await harness(t);
  const received = await adjust(h, { productId: 10, type: 'receive', quantity: 6, reason: 'delivery', note: 'Supplier invoice 42' });
  assert.equal(received.status, 200, JSON.stringify(received.data));
  assert.equal(received.data.movement.before, 4);
  assert.equal(received.data.movement.after, 10);
  assert.deepEqual(h.api.state.writes.at(-1), { target: 10, body: { manage_stock: true, stock_quantity: 10 } });
  const removed = await adjust(h, { productId: 20, variationId: 21, type: 'remove', quantity: 1, reason: 'damaged' });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(h.api.state.option.stock, 0);
  const tooMany = await adjust(h, { productId: 20, variationId: 21, type: 'remove', quantity: 1, reason: 'lost' });
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.data.code, 'INSUFFICIENT_STOCK');
  const wrongReason = await adjust(h, { productId: 10, type: 'receive', quantity: 1, reason: 'damaged' });
  assert.equal(wrongReason.status, 400);
  const history = await h.request('/inventory/movements?productId=10', { token: h.token });
  assert.equal(history.data.movements.length, 1);
  assert.equal(history.data.movements[0].delta, 6);
  assert.equal(history.data.movements[0].note, 'Supplier invoice 42');
});

test('a repeated request key is not applied twice', async t => {
  const h = await harness(t);
  const key = randomUUID();
  const first = await adjust(h, { key, productId: 10, type: 'receive', quantity: 2, reason: 'delivery' });
  const again = await adjust(h, { key, productId: 10, type: 'receive', quantity: 2, reason: 'delivery' });
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.data.replayed, true);
  assert.equal(h.api.state.simple.stock, 6);
  assert.equal(h.api.state.writes.length, 1);
});

test('a stock count refuses to overwrite a quantity that changed while counting', async t => {
  const h = await harness(t);
  h.api.state.simple.stock = 3; // a website sale since the counter loaded 4
  const stale = await adjust(h, { productId: 10, type: 'count', quantity: 4, reason: 'stock_count', expectedStock: 4 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'STOCK_CHANGED');
  assert.equal(h.api.state.writes.length, 0);
  const counted = await h.request('/inventory/count', { method: 'POST', token: h.token, body: { key: randomUUID(), note: 'Saturday count', lines: [
    { productId: 10, variationId: 0, counted: 2, expectedStock: 3 },
    { productId: 20, variationId: 21, counted: 1, expectedStock: 1 },
    { productId: 20, variationId: 22, counted: 5, expectedStock: null },
    { productId: 20, variationId: 22 + 0, counted: 5, expectedStock: null, enableTracking: true },
  ] } });
  assert.equal(counted.status, 400, 'duplicate lines are rejected');
  const ok = await h.request('/inventory/count', { method: 'POST', token: h.token, body: { key: randomUUID(), note: 'Saturday count', lines: [
    { productId: 10, variationId: 0, counted: 2, expectedStock: 3 },
    { productId: 20, variationId: 21, counted: 1, expectedStock: 1 },
    { productId: 20, variationId: 22, counted: 5, expectedStock: null },
  ] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.results.map(r => r.ok), [true, true, false]);
  assert.equal(ok.data.results[2].code, 'STOCK_UNTRACKED');
  assert.equal(ok.data.results[1].movement.written, false, 'matching count confirmed without a Woo write');
  assert.equal(h.api.state.simple.stock, 2);
  const tracked = await h.request('/inventory/count', { method: 'POST', token: h.token, body: { key: randomUUID(), lines: [
    { productId: 20, variationId: 22, counted: 5, expectedStock: null, enableTracking: true }] } });
  assert.equal(tracked.data.results[0].ok, true);
  assert.equal(h.api.state.untracked.stock, 5);
  assert.equal(h.api.state.untracked.manage, true);
});

test('an unconfirmed Woo write is recorded as uncertain and blocks a blind retry', async t => {
  const h = await harness(t);
  const key = randomUUID();
  h.api.state.failNext = new RemoteError('timeout', 502, true);
  const failed = await adjust(h, { key, productId: 10, type: 'receive', quantity: 1, reason: 'delivery' });
  assert.equal(failed.status, 502);
  assert.equal(failed.data.code, 'INVENTORY_UNCERTAIN');
  const retry = await adjust(h, { key, productId: 10, type: 'receive', quantity: 1, reason: 'delivery' });
  assert.equal(retry.status, 409);
  assert.equal(retry.data.code, 'INVENTORY_UNCERTAIN');
});

test('owners can change retail prices on WooCommerce; managers and cashiers cannot', async t => {
  const h = await harness(t);
  const price = await h.request('/inventory/price', { method: 'POST', token: h.token, body: { key: randomUUID(), productId: 20, variationId: 21, regularPrice: '250', salePrice: '199.99', expectedRegularPrice: '200.00' } });
  assert.equal(price.status, 200, JSON.stringify(price.data));
  assert.deepEqual(h.api.state.writes.at(-1).body, { regular_price: '250.00', sale_price: '199.99' });
  const stale = await h.request('/inventory/price', { method: 'POST', token: h.token, body: { key: randomUUID(), productId: 20, variationId: 21, regularPrice: '300', expectedRegularPrice: '200.00' } });
  assert.equal(stale.status, 409);
  const parentPrice = await h.request('/inventory/price', { method: 'POST', token: h.token, body: { key: randomUUID(), productId: 10, variationId: 0, regularPrice: '120', salePrice: '130' } });
  assert.equal(parentPrice.status, 400, 'sale price must be below regular price');

  const created = await h.request('/staff', { method: 'POST', token: h.token, body: { username: 'cashier1', name: 'Cashier', role: 'cashier', password: 'cashier-passphrase-123' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  let cashier = (await h.request('/auth/login', { method: 'POST', body: { username: 'cashier1', password: 'cashier-passphrase-123' } })).data.token;
  await h.request('/auth/password', { method: 'POST', token: cashier, body: { currentPassword: 'cashier-passphrase-123', newPassword: 'cashier-rotated-pass-123' } });
  cashier = (await h.request('/auth/login', { method: 'POST', body: { username: 'cashier1', password: 'cashier-rotated-pass-123' } })).data.token;
  assert.equal((await h.request('/inventory', { token: cashier })).status, 403);
  assert.equal((await h.request('/inventory/adjust', { method: 'POST', token: cashier, body: { key: randomUUID(), productId: 10, variationId: 0, type: 'receive', quantity: 1, reason: 'delivery' } })).status, 403);
});

test('without the inventory switch the live service reads stock but cannot change it', async t => {
  const h = await harness(t, { POS_INVENTORY_WRITES_APPROVED: 'false' });
  const overview = await h.request('/inventory', { token: h.token });
  assert.equal(overview.data.writes.enabled, false);
  const blocked = await adjust(h, { productId: 10, type: 'receive', quantity: 1, reason: 'delivery' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'INVENTORY_WRITES_LOCKED');
  assert.equal(h.api.state.writes.length, 0);
});

test('demo inventory adjusts local sample stock only', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-inventory-demo-'));
  const instance = createApp({ env: { POS_MODE: 'demo', NODE_ENV: 'test', POS_DATA_DIR: dir }, logger: silent });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (url, opts = {}) => { const res = await fetch(base + url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } }); return { status: res.status, data: await res.json() }; };
  const token = (await call('/auth/demo', { method: 'POST', body: '{}' })).data.token;
  const auth = { Authorization: `Bearer ${token}` };
  const overview = await call('/inventory', { headers: auth });
  assert.equal(overview.status, 200);
  const line = overview.data.lines.find(l => l.stock != null);
  const res = await call('/inventory/adjust', { method: 'POST', headers: auth, body: JSON.stringify({ key: randomUUID(), productId: line.productId, variationId: line.variationId, type: 'receive', quantity: 3, reason: 'delivery', note: '' }) });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.movement.after, line.stock + 3);
  const after = await call('/inventory', { headers: auth });
  assert.equal(after.data.lines.find(l => l.key === line.key).stock, line.stock + 3);
});
