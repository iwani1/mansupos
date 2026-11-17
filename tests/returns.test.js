import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { RemoteError } from '../server/errors.js';

const env0 = {
  NODE_ENV: 'test', POS_MODE: 'live', WOO_BASE_URL: 'https://www.mansutrendzgh.com',
  WOO_CONSUMER_KEY: 'ck_synthetic', WOO_CONSUMER_SECRET: 'cs_synthetic', POS_ALLOW_LIVE_WRITES: 'true',
  POS_OWNER_APPROVAL_REFERENCE: 'owner-chat-2026-11-16-cash-retail', POS_REQUIRE_SHIFT: 'true',
  POS_LIVE_RETAIL_CASH_DIRECT: 'true', POS_INVENTORY_WRITES_APPROVED: 'true', POS_RETURNS_APPROVED: 'true',
};
const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

test('returns have their own live switch', () => {
  assert.equal(readConfig({ ...env0, NODE_ENV: 'production', POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com', POS_RETURNS_APPROVED: 'false' }).returnsEnabled, false);
  assert.equal(readConfig({ ...env0, NODE_ENV: 'production', POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com' }).returnsEnabled, true);
  assert.throws(() => readConfig({ ...env0, POS_RETURNS_APPROVED: 'yes' }));
});

function fakeWoo() {
  const state = { stock: { 10: 3, 21: 1 }, refunds: [], creates: 0, failRefund: null, lostResponse: false };
  const simple = () => ({ id: 10, name: 'Plain Tee', type: 'simple', status: 'publish', sku: 'TEE', price: '100.00', images: [], categories: [], purchasable: true, manage_stock: true, stock_quantity: state.stock[10], stock_status: 'instock', backorders: 'no' });
  const parent = () => ({ id: 20, name: 'Wrap Dress', type: 'variable', status: 'publish', sku: 'DRESS', price: '200.00', images: [], categories: [], purchasable: true, manage_stock: false, stock_status: 'instock', backorders: 'no' });
  const option = () => ({ id: 21, parent_id: 20, sku: 'DRESS-M', price: '200.00', attributes: [{ name: 'Size', option: 'M' }], manage_stock: true, stock_quantity: state.stock[21], stock_status: 'instock', backorders: 'no', purchasable: true });
  return {
    state,
    async request() { throw new Error('unexpected'); },
    async products() { return { data: [simple(), parent()], total: 2, pages: 1 }; },
    async variations() { return { data: [option()], total: 1, pages: 1 }; },
    async product(id) { return id === 10 ? simple() : parent(); },
    async variation() { return option(); },
    async updateProduct(id, body) { state.stock[id] = body.stock_quantity; return simple(); },
    async updateVariation(_p, id, body) { state.stock[id] = body.stock_quantity; return option(); },
    async recentOrders() { return { data: [], total: 0, pages: 1, paginationKnown: true }; },
    async order(id) { return { id, line_items: [{ id: 501, product_id: 10, variation_id: 0, quantity: 2, total: '200.00' }, { id: 502, product_id: 20, variation_id: 21, quantity: 1, total: '200.00' }] }; },
    async refunds() { return state.refunds; },
    async createRefund(orderId, body) {
      if (state.failRefund) { const e = state.failRefund; state.failRefund = null; throw e; }
      state.creates++;
      const refund = { id: 900 + state.creates, ...body };
      state.refunds.push(refund);
      if (state.lostResponse) { state.lostResponse = false; throw new RemoteError('lost', 502, true); }
      return refund;
    },
  };
}

async function harness(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-returns-'));
  const api = fakeWoo();
  const instance = createApp({ env: { ...env0, POS_DATA_DIR: dir, POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'test-secret-passphrase-123', ...extraEnv }, api, logger: silent });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (url, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  let token = (await request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'test-secret-passphrase-123' } })).data.token;
  await request('/auth/password', { method: 'POST', token, body: { currentPassword: 'test-secret-passphrase-123', newPassword: 'rotated-secret-passphrase-123' } });
  token = (await request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'rotated-secret-passphrase-123' } })).data.token;
  const shift = (await request('/shifts/open', { method: 'POST', token, body: { openingFloat: 5000 } })).data.shift;
  const owner = instance.db.prepare("SELECT id,name FROM users WHERE username='owner'").get();
  // A paid cash sale of 2 tees (GH₵100 each) and 1 dress (GH₵200) on this shift.
  const saleId = randomUUID();
  const items = [{ productId: 10, variationId: 0, name: 'Plain Tee', label: '', sku: 'TEE', price: 10000, quantity: 2, total: 20000 },
    { productId: 20, variationId: 21, name: 'Wrap Dress', label: 'M', sku: 'DRESS-M', price: 20000, quantity: 1, total: 20000 }];
  const time = new Date().toISOString();
  instance.db.prepare(`INSERT INTO sales(id,idempotency_key,fingerprint,number,woo_order_id,status,payment_method,total,tax,subtotal,refunded,currency,cashier_id,cashier_name,items_json,created_at,updated_at,paid_at,shift_id,prepared_total)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(saleId, randomUUID(), 'fp', 'WC-4001', 4001, 'paid', 'cash', 40000, 0, 40000, 0, 'GHS', owner.id, owner.name, JSON.stringify(items), time, time, time, shift.id, 40000);
  t.after(async () => { await new Promise(r => server.close(r)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...instance, api, request, token, saleId, shiftId: shift.id };
}
const ret = (h, lines, extra = {}) => h.request('/returns', { method: 'POST', token: h.token, body: { key: randomUUID(), saleId: h.saleId, reason: 'wrong_size', note: '', lines, ...extra } });

test('a cash return refunds on the Woo order, pays from the drawer, and restocks only sellable items', async t => {
  const h = await harness(t);
  const found = await h.request('/returns/find?q=4001', { token: h.token });
  assert.equal(found.data.sales[0].number, 'WC-4001');
  const before = (await h.request('/shifts/current', { token: h.token })).data.shift.expectedCash;
  const res = await ret(h, [{ productId: 10, variationId: 0, quantity: 1, disposition: 'restock' }, { productId: 20, variationId: 21, quantity: 1, disposition: 'damaged' }]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const r = res.data.return;
  assert.equal(r.status, 'completed');
  assert.equal(r.refundTotal, 30000);
  assert.equal(r.cashRecorded, true);
  const refund = h.api.state.refunds[0];
  assert.equal(refund.amount, '300.00');
  assert.equal(refund.api_restock, false, 'WooCommerce must not restock by itself');
  assert.equal(refund.api_refund, false, 'manual cash refund');
  assert.deepEqual(refund.line_items.map(l => [l.id, l.quantity, l.refund_total]), [[501, 1, '100.00'], [502, 1, '200.00']]);
  assert.match(refund.reason, /^POS return RTN-00001 — Wrong size/);
  assert.equal(h.api.state.stock[10], 4, 'resellable tee back in stock');
  assert.equal(h.api.state.stock[21], 1, 'damaged dress NOT added to website stock');
  assert.equal((await h.request('/shifts/current', { token: h.token })).data.shift.expectedCash, before - 30000);
  const sale = h.db.prepare('SELECT status,refunded FROM sales WHERE id=?').get(h.saleId);
  assert.deepEqual({ ...sale }, { status: 'partially_refunded', refunded: 30000 });
  const summary = (await h.request('/returns/summary', { token: h.token })).data;
  assert.equal(summary.awaiting.length, 1);
  assert.equal(summary.awaiting[0].dispositionLabel, 'Damaged');
  const decided = await h.request(`/returns/items/${summary.awaiting[0].id}/resolve`, { method: 'POST', token: h.token, body: { action: 'restock', note: 'stain washed out' } });
  assert.equal(decided.status, 200, JSON.stringify(decided.data));
  assert.equal(h.api.state.stock[21], 2);
  assert.equal((await h.request(`/returns/items/${summary.awaiting[0].id}/resolve`, { method: 'POST', token: h.token, body: { action: 'write_off' } })).data.code, 'ALREADY_RESOLVED');
  const history = (await h.request('/inventory/movements?productId=10', { token: h.token })).data.movements;
  assert.equal(history[0].reasonLabel, 'Customer return');
});

test('returns can never exceed what was sold, across several returns', async t => {
  const h = await harness(t);
  assert.equal((await ret(h, [{ productId: 10, variationId: 0, quantity: 3, disposition: 'restock' }])).data.code, 'RETURN_EXCEEDS_SALE');
  assert.equal((await ret(h, [{ productId: 10, variationId: 0, quantity: 2, disposition: 'quarantine' }])).status, 200);
  assert.equal((await ret(h, [{ productId: 10, variationId: 0, quantity: 1, disposition: 'restock' }])).data.code, 'RETURN_EXCEEDS_SALE');
  const info = (await h.request(`/returns/sale/${h.saleId}`, { token: h.token })).data;
  assert.equal(info.lines.find(l => l.productId === 10).returnable, 0);
  assert.equal(info.lines.find(l => l.productId === 20).returnable, 1);
  assert.equal((await ret(h, [{ productId: 99, variationId: 0, quantity: 1, disposition: 'restock' }])).status, 400);
});

test('a lost Woo response is never refunded twice', async t => {
  const h = await harness(t);
  h.api.state.lostResponse = true;
  const body = { key: randomUUID(), saleId: h.saleId, reason: 'faulty', note: '', lines: [{ productId: 10, variationId: 0, quantity: 1, disposition: 'restock' }] };
  const first = await h.request('/returns', { method: 'POST', token: h.token, body });
  assert.equal(first.data.code, 'REFUND_UNCONFIRMED');
  assert.equal(h.api.state.stock[10], 3, 'nothing restocked before the refund is confirmed');
  const retry = await h.request('/returns', { method: 'POST', token: h.token, body });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(h.api.state.creates, 1, 'the existing Woo refund was adopted, not repeated');
  assert.equal(retry.data.return.wooRefundId, 901);
  assert.equal(h.api.state.stock[10], 4);
  const again = await h.request('/returns', { method: 'POST', token: h.token, body });
  assert.equal(again.data.return.status, 'completed');
  assert.equal(h.api.state.stock[10], 4, 'a third press changes nothing');
  const movements = h.db.prepare("SELECT COUNT(*) AS n FROM cash_movements WHERE reason LIKE 'Refund RTN-%'").get().n;
  assert.equal(movements, 1, 'cash paid out once');
});

test('a refund WooCommerce rejects changes nothing; a short drawer is refused before refunding', async t => {
  const h = await harness(t);
  h.api.state.failRefund = Object.assign(new RemoteError('rejected', 502), { wooStatus: 400, wooMessage: 'Invalid refund amount.' });
  const rejected = await ret(h, [{ productId: 10, variationId: 0, quantity: 1, disposition: 'restock' }]);
  assert.equal(rejected.data.code, 'REFUND_REJECTED');
  assert.equal(h.api.state.stock[10], 3);
  assert.equal(h.db.prepare('SELECT refunded FROM sales WHERE id=?').get(h.saleId).refunded, 0);
  assert.equal((await ret(h, [{ productId: 10, variationId: 0, quantity: 1, disposition: 'restock' }])).status, 200, 'the failed return does not use up the returnable quantity');
  h.db.prepare("INSERT INTO cash_movements(id,shift_id,user_id,type,amount,reason,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), h.shiftId, h.db.prepare("SELECT id FROM users WHERE username='owner'").get().id, 'out', 40000, 'banked', new Date().toISOString());
  const short = await ret(h, [{ productId: 20, variationId: 21, quantity: 1, disposition: 'restock' }]);
  assert.equal(short.data.code, 'DRAWER_SHORT');
  assert.equal(h.api.state.creates, 1);
});

test('taxed sales go to WooCommerce, and returns stay locked without the switch', async t => {
  const h = await harness(t);
  h.db.prepare('UPDATE sales SET tax=500 WHERE id=?').run(h.saleId);
  assert.equal((await ret(h, [{ productId: 10, variationId: 0, quantity: 1, disposition: 'restock' }])).data.code, 'TAXED_SALE');
  const off = await harness(t, { POS_RETURNS_APPROVED: 'false' });
  assert.equal((await off.request('/returns/summary', { token: off.token })).data.writes.enabled, false);
  assert.equal((await ret(off, [{ productId: 10, variationId: 0, quantity: 1, disposition: 'restock' }])).data.code, 'RETURNS_LOCKED');
});

test('return records cannot be deleted and a line is resolved only once', async t => {
  const h = await harness(t);
  await ret(h, [{ productId: 10, variationId: 0, quantity: 1, disposition: 'write_off' }]);
  assert.throws(() => h.db.prepare('DELETE FROM customer_returns').run(), /cannot be deleted/);
  assert.throws(() => h.db.prepare("UPDATE customer_return_items SET resolution='restock'").run(), /only once/);
});

test('a POS return with its cash out recorded is not flagged as an unproven cash refund', async t => {
  const h = await harness(t);
  await ret(h, [{ productId: 10, variationId: 0, quantity: 1, disposition: 'restock' }]);
  const recon = (await h.request('/payments/reconciliation', { token: h.token })).data;
  const flagged = (recon.cases || recon.items || []).filter(c => c.saleId === h.saleId || c.id === h.saleId);
  assert.ok(flagged.every(c => !(c.issueCodes || []).includes('cash_refund_payout_unverified')), JSON.stringify(flagged));
  // A refund made only in WooCommerce (no POS cash out) is still flagged.
  h.db.prepare('UPDATE sales SET refunded=refunded+5000 WHERE id=?').run(h.saleId);
  const after = (await h.request('/payments/reconciliation', { token: h.token })).data;
  assert.ok((after.cases || after.items || []).some(c => (c.saleId === h.saleId || c.id === h.saleId) && c.issueCodes.includes('cash_refund_payout_unverified')));
});
