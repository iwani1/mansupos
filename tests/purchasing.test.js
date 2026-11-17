import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { RemoteError } from '../server/errors.js';

const env0 = {
  NODE_ENV: 'test', POS_MODE: 'live', WOO_BASE_URL: 'https://www.mansutrendzgh.com',
  WOO_CONSUMER_KEY: 'ck_synthetic', WOO_CONSUMER_SECRET: 'cs_synthetic', POS_ALLOW_LIVE_WRITES: 'true',
  POS_OWNER_APPROVAL_REFERENCE: 'owner-chat-2026-11-16-cash-retail', POS_REQUIRE_SHIFT: 'true',
  POS_LIVE_RETAIL_CASH_DIRECT: 'true', POS_INVENTORY_WRITES_APPROVED: 'true',
};
const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function fakeWoo() {
  const state = { stock: { 10: 2, 21: 0 }, writes: [], failFor: null };
  const simple = () => ({ id: 10, name: 'Plain Tee', type: 'simple', status: 'publish', sku: 'TEE', price: '100.00', images: [], categories: [{ name: 'Tops' }], purchasable: true, manage_stock: true, stock_quantity: state.stock[10], stock_status: 'instock', backorders: 'no' });
  const parent = () => ({ id: 20, name: 'Wrap Dress', type: 'variable', status: 'publish', sku: 'DRESS', price: '200.00', images: [], categories: [{ name: 'Dresses' }], purchasable: true, manage_stock: false, stock_status: 'instock', backorders: 'no' });
  const option = () => ({ id: 21, parent_id: 20, sku: 'DRESS-M', price: '200.00', attributes: [{ name: 'Size', option: 'M' }], manage_stock: true, stock_quantity: state.stock[21], stock_status: 'instock', backorders: 'no', purchasable: true });
  const write = (id, body) => {
    if (state.failFor === id) { state.failFor = null; throw new RemoteError('timeout', 502, false); }
    state.writes.push([id, body.stock_quantity]); state.stock[id] = body.stock_quantity;
  };
  return {
    state,
    async request() { throw new Error('unexpected'); },
    async products() { return { data: [simple(), parent()], total: 2, pages: 1 }; },
    async variations() { return { data: [option()], total: 1, pages: 1 }; },
    async product(id) { return id === 10 ? simple() : parent(); },
    async variation() { return option(); },
    async updateProduct(id, body) { write(id, body); return simple(); },
    async updateVariation(_p, id, body) { write(id, body); return option(); },
    async recentOrders() { return { data: [], total: 0, pages: 1, paginationKnown: true }; },
  };
}

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-purchasing-'));
  const api = fakeWoo();
  const instance = createApp({ env: { ...env0, POS_DATA_DIR: dir, POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'test-secret-passphrase-123' }, api, logger: silent });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (url, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  const login = async (username, password, next) => {
    let token = (await request('/auth/login', { method: 'POST', body: { username, password } })).data.token;
    await request('/auth/password', { method: 'POST', token, body: { currentPassword: password, newPassword: next } });
    return (await request('/auth/login', { method: 'POST', body: { username, password: next } })).data.token;
  };
  const owner = await login('owner', 'test-secret-passphrase-123', 'rotated-secret-passphrase-123');
  await request('/staff', { method: 'POST', token: owner, body: { username: 'manager1', name: 'Manager', role: 'manager', password: 'manager-passphrase-123' } });
  const manager = await login('manager1', 'manager-passphrase-123', 'manager-rotated-pass-123');
  t.after(async () => { await new Promise(r => server.close(r)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...instance, api, request, owner, manager };
}

async function approvedOrder(h) {
  const supplier = (await h.request('/suppliers', { method: 'POST', token: h.manager, body: { name: 'Kantamanto Textiles', phone: '024 000 0000' } })).data.supplier;
  const created = await h.request('/purchase-orders', { method: 'POST', token: h.manager, body: { supplierId: supplier.id, items: [
    { productId: 10, variationId: 0, name: 'Plain Tee', sku: 'TEE', quantity: 10, unitCost: 4000 },
    { productId: 20, variationId: 21, name: 'Wrap Dress', label: 'M', sku: 'DRESS-M', quantity: 5, unitCost: 9000 },
  ] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.order.id;
  assert.equal((await h.request(`/purchase-orders/${id}/action`, { method: 'POST', token: h.manager, body: { action: 'submit' } })).data.order.status, 'pending_approval');
  return { supplier, id, order: created.data.order };
}

test('purchase orders need owner approval before goods can be received', async t => {
  const h = await harness(t);
  const { id, order } = await approvedOrder(h);
  assert.match(order.number, /^PO-\d{5}$/);
  assert.equal(order.total, 10 * 4000 + 5 * 9000);
  const early = await h.request(`/purchase-orders/${id}/receive`, { method: 'POST', token: h.manager, body: { key: randomUUID(), lines: [{ itemId: order.items[0].id, received: 1 }] } });
  assert.equal(early.data.code, 'PO_NOT_RECEIVABLE');
  assert.equal((await h.request(`/purchase-orders/${id}/action`, { method: 'POST', token: h.manager, body: { action: 'approve' } })).status, 403, 'a manager cannot approve');
  const approved = await h.request(`/purchase-orders/${id}/action`, { method: 'POST', token: h.owner, body: { action: 'approve' } });
  assert.equal(approved.data.order.status, 'approved');
  assert.equal(approved.data.order.approvedByName, 'Store Owner');
  assert.equal((await h.request('/suppliers', { method: 'POST', token: h.manager, body: { name: 'kantamanto textiles' } })).status, 409, 'duplicate supplier name');
});

test('a partial delivery adds stock in WooCommerce once, sets the cost and keeps the rest incoming', async t => {
  const h = await harness(t);
  const { id, order } = await approvedOrder(h);
  await h.request(`/purchase-orders/${id}/action`, { method: 'POST', token: h.owner, body: { action: 'approve' } });
  const [tee, dress] = order.items.sort((a, b) => a.name.localeCompare(b.name));
  const key = randomUUID();
  const body = { key, invoiceRef: 'INV-77', lines: [{ itemId: tee.id, received: 6, damaged: 1 }, { itemId: dress.id, received: 5, unitCost: 9500 }] };
  const first = await h.request(`/purchase-orders/${id}/receive`, { method: 'POST', token: h.manager, body });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.data.failures, []);
  assert.equal(first.data.order.status, 'partially_received');
  assert.equal(h.api.state.stock[10], 8);
  assert.equal(h.api.state.stock[21], 5);
  const again = await h.request(`/purchase-orders/${id}/receive`, { method: 'POST', token: h.manager, body });
  assert.equal(again.data.replayed, true, 'the same delivery is never posted twice');
  assert.equal(h.api.state.writes.length, 2);
  const overview = (await h.request('/purchasing/overview', { token: h.manager })).data;
  const teeLine = overview.lines.find(l => l.key === '10:0');
  assert.equal(teeLine.avgCost, 4000, 'first cost on record is the delivery cost');
  assert.equal(teeLine.incoming, 4);
  assert.equal(overview.lines.find(l => l.key === '20:21').avgCost, 9500, 'cost corrected on receipt');
  assert.equal(overview.summary.incomingUnits, 4);
  assert.equal(overview.summary.costValue, 8 * 4000 + 5 * 9500);
  const history = (await h.request('/inventory/movements?productId=10', { token: h.manager })).data.movements;
  assert.match(history[0].note, /^PO-00001 · GRN-00001 · inv INV-77$/);
  const excess = await h.request(`/purchase-orders/${id}/receive`, { method: 'POST', token: h.manager, body: { key: randomUUID(), lines: [{ itemId: tee.id, received: 5 }] } });
  assert.equal(excess.data.code, 'EXCESS_DELIVERY');
  const rest = await h.request(`/purchase-orders/${id}/receive`, { method: 'POST', token: h.manager, body: { key: randomUUID(), lines: [{ itemId: tee.id, received: 4, unitCost: 5000 }] } });
  assert.equal(rest.data.order.status, 'received');
  const avg = (await h.request('/purchasing/overview', { token: h.manager })).data.lines.find(l => l.key === '10:0').avgCost;
  assert.equal(avg, Math.round((8 * 4000 + 4 * 5000) / 12), 'weighted average over stock on hand');
});

test('a line WooCommerce rejects is reported and only that line is posted on retry', async t => {
  const h = await harness(t);
  const { id, order } = await approvedOrder(h);
  await h.request(`/purchase-orders/${id}/action`, { method: 'POST', token: h.owner, body: { action: 'approve' } });
  const [tee, dress] = order.items.sort((a, b) => a.name.localeCompare(b.name));
  h.api.state.failFor = 21;
  const body = { key: randomUUID(), lines: [{ itemId: tee.id, received: 3 }, { itemId: dress.id, received: 2 }] };
  const first = await h.request(`/purchase-orders/${id}/receive`, { method: 'POST', token: h.manager, body });
  assert.equal(first.data.failures.length, 1);
  assert.equal(first.data.receipt.status, 'incomplete');
  assert.equal(h.api.state.stock[10], 5);
  assert.equal(h.api.state.stock[21], 0);
  const retry = await h.request(`/purchase-orders/${id}/receive`, { method: 'POST', token: h.manager, body: { ...body, lines: [{ itemId: tee.id, received: 99 }] } });
  assert.equal(retry.data.receipt.status, 'posted');
  assert.equal(h.api.state.stock[10], 5, 'the already-posted line is not added again, and changed quantities are ignored');
  assert.equal(h.api.state.stock[21], 2);
});

test('reorder suggestions count stock already on order', async t => {
  const h = await harness(t);
  let overview = (await h.request('/purchasing/overview', { token: h.manager })).data;
  assert.ok(overview.lines.find(l => l.key === '20:21').suggested > 0, 'out of stock with nothing on order');
  const { id } = await approvedOrder(h);
  await h.request(`/purchase-orders/${id}/action`, { method: 'POST', token: h.owner, body: { action: 'approve' } });
  overview = (await h.request('/purchasing/overview', { token: h.manager })).data;
  assert.equal(overview.lines.find(l => l.key === '20:21').incoming, 5);
  assert.equal(overview.lines.find(l => l.key === '20:21').suggested, 5, 'target 10 minus 5 already on order');
  assert.equal(overview.lines.find(l => l.key === '10:0').suggested, 0, '2 in stock + 10 on order covers the target');
  const cost = await h.request('/inventory/cost', { method: 'PUT', token: h.manager, body: { productId: 10, variationId: 0, cost: 3500 } });
  assert.equal(cost.status, 403, 'only an owner sets costs by hand');
  assert.equal((await h.request('/inventory/cost', { method: 'PUT', token: h.owner, body: { productId: 10, variationId: 0, cost: 3500 } })).status, 200);
});

test('receipt lines cannot be edited or deleted', async t => {
  const h = await harness(t);
  const { id, order } = await approvedOrder(h);
  await h.request(`/purchase-orders/${id}/action`, { method: 'POST', token: h.owner, body: { action: 'approve' } });
  await h.request(`/purchase-orders/${id}/receive`, { method: 'POST', token: h.manager, body: { key: randomUUID(), lines: [{ itemId: order.items[0].id, received: 1 }] } });
  assert.throws(() => h.db.prepare('UPDATE goods_receipt_items SET qty_received=50').run(), /append-only/);
  assert.throws(() => h.db.prepare('DELETE FROM goods_receipts').run(), /cannot be deleted/);
});
