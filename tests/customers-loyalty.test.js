import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { normalisePhone } from '../server/customers.js';

const tradingEnv = {
  NODE_ENV: 'test', POS_MODE: 'live', WOO_BASE_URL: 'https://www.mansutrendzgh.com',
  WOO_CONSUMER_KEY: 'ck_synthetic', WOO_CONSUMER_SECRET: 'cs_synthetic', POS_ALLOW_LIVE_WRITES: 'true',
  POS_OWNER_APPROVAL_REFERENCE: 'owner-chat-2026-11-16-cash-retail', POS_REQUIRE_SHIFT: 'true',
  POS_LIVE_RETAIL_CASH_DIRECT: 'true', POS_INVENTORY_WRITES_APPROVED: 'true', POS_RETURNS_APPROVED: 'true',
};

// WooCommerce with taxes off: fee lines (negative = discount) are added to the total.
function fakeWoo() {
  const state = { orders: [], creates: 0, updates: 0, stock: 10, refunds: [] };
  const product = { id: 10, name: 'Pearl Shirt', type: 'variable', sku: 'PEARL', price: '250.00', images: [], categories: [{ name: 'Tops' }], status: 'publish', purchasable: true, manage_stock: false, stock_status: 'instock', backorders: 'no', permalink: 'https://www.mansutrendzgh.com/p' };
  const variation = () => ({ id: 11, sku: 'PEARL-M', price: '250.00', attributes: [{ name: 'Size', option: 'M' }], manage_stock: true, stock_quantity: state.stock, stock_status: 'instock', backorders: 'no', purchasable: true });
  const view = o => {
    const lines = o.line_items.map((i, n) => ({ ...i, id: n + 1, name: 'Pearl Shirt - M', sku: 'PEARL-M', price: 250, subtotal: (250 * i.quantity).toFixed(2), total: (250 * i.quantity).toFixed(2), total_tax: '0.00' }));
    const fees = (o.fee_lines || []).map((f, n) => ({ ...f, id: 100 + n, total_tax: '0.00' }));
    const total = lines.reduce((s, i) => s + Number(i.total), 0) + fees.reduce((s, f) => s + Number(f.total), 0);
    return { ...o, line_items: lines, fee_lines: fees, coupon_lines: [], shipping_lines: [], shipping_total: '0.00', discount_total: '0.00', total: total.toFixed(2), total_tax: '0.00', tax_lines: [],
      refunds: state.refunds.filter(r => r.orderId === o.id).map(r => ({ id: r.id, total: `-${r.amount}` })) };
  };
  return {
    state,
    async products() { return { data: [product], total: 1, pages: 1 }; },
    async variations() { return { data: [variation()], total: 1, pages: 1 }; },
    async product() { return product; },
    async variation() { return variation(); },
    async updateVariation(_p, _v, body) { if (body.stock_quantity != null) state.stock = body.stock_quantity; return variation(); },
    async recentOrders() { return { data: state.orders.map(view), total: state.orders.length, pages: 1, paginationKnown: true }; },
    async createOrder(body) { state.creates++; const o = { ...body, id: 900 + state.creates, number: String(900 + state.creates), currency: 'GHS', date_paid: null }; state.orders.push(o); return view(o); },
    async updateOrder(id, body) { state.updates++; const o = state.orders.find(x => x.id === id); const { meta_data, ...rest } = body; Object.assign(o, rest);
      if (meta_data) o.meta_data = [...o.meta_data, ...meta_data]; if (body.set_paid) { o.date_paid = new Date().toISOString(); state.stock -= o.line_items[0].quantity; } return view(o); },
    async order(id) { return view(state.orders.find(o => o.id === id)); },
    async createRefund(orderId, body) { const r = { id: 5000 + state.refunds.length, orderId, amount: body.amount, line_items: body.line_items }; state.refunds.push(r); return { id: r.id, amount: body.amount }; },
    async refunds(orderId) { return state.refunds.filter(r => r.orderId === orderId); },
    async findOrderByKey() { return null; },
  };
}

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-loyalty-'));
  const api = fakeWoo();
  const env = { ...tradingEnv, POS_DATA_DIR: dir, POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'test-secret-passphrase-123' };
  const instance = createApp({ env, api, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  const token = (await request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'test-secret-passphrase-123' } })).data.token;
  await request('/auth/password', { method: 'POST', token, body: { currentPassword: 'test-secret-passphrase-123', newPassword: 'rotated-secret-passphrase-123' } });
  assert.equal((await request('/shifts/open', { method: 'POST', token, body: { openingFloat: 50000 } })).status, 201);
  t.after(async () => { await new Promise(r => server.close(r)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...instance, api, request, token };
}
const cart = (extra = {}, quantity = 2) => ({ idempotencyKey: randomUUID(), items: [{ productId: 10, variationId: 11, quantity }], ...extra });
const pay = (h, sale, tendered = sale.total) => h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered, confirmed: true } });

test('Ghana phone numbers are normalised to +233', () => {
  assert.equal(normalisePhone('024 412 3456'), '+233244123456');
  assert.equal(normalisePhone('233244123456'), '+233244123456');
  assert.equal(normalisePhone('+233 (24) 412-3456'), '+233244123456');
  assert.equal(normalisePhone('+447700900123'), '+447700900123');
  assert.equal(normalisePhone('12345'), null);
});

test('customers are created once per phone and found by phone or name', async t => {
  const h = await harness(t);
  const created = await h.request('/customers', { method: 'POST', token: h.token, body: { name: 'Akosua Mensah', phone: '024 412 3456' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.customer.phone, '+233244123456');
  assert.equal(created.data.customer.points, 0);
  const dup = await h.request('/customers', { method: 'POST', token: h.token, body: { name: 'Someone Else', phone: '+233244123456' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, 'CUSTOMER_EXISTS');
  assert.equal((await h.request('/customers?q=0244123456', { token: h.token })).data.customers.length, 1);
  assert.equal((await h.request('/customers?q=akosua', { token: h.token })).data.customers.length, 1);
  assert.equal((await h.request('/customers?q=4123', { token: h.token })).data.customers.length, 1);
  assert.equal((await h.request('/customers?q=0244', { token: h.token })).data.customers.length, 1, 'Partial local number with its leading 0');
  assert.equal((await h.request('/customers', { method: 'POST', token: h.token, body: { name: '<b>x</b>', phone: '0201112222' } })).status, 400);
});

test('a paid retail sale earns 1 point per GH₵1 and is linked to the customer and the Woo order', async t => {
  const h = await harness(t);
  const { customer } = (await h.request('/customers', { method: 'POST', token: h.token, body: { name: 'Akosua Mensah', phone: '0244123456', email: 'akosua@example.com' } })).data;
  const prepared = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart({ customerId: customer.id }) });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const order = h.api.state.orders[0];
  assert.equal(order.billing.phone, '+233244123456');
  assert.equal(order.billing.first_name, 'Akosua Mensah');
  assert.ok(order.meta_data.some(m => m.key === '_mansu_pos_customer_id' && m.value === customer.id));
  assert.equal((await h.request(`/customers/${customer.id}`, { token: h.token })).data.customer.points, 0, 'No points before payment');
  assert.equal((await pay(h, prepared.data.sale)).status, 200);
  const detail = (await h.request(`/customers/${customer.id}`, { token: h.token })).data;
  assert.equal(detail.customer.points, 500, 'GH₵500 paid -> 500 points');
  assert.equal(detail.customer.visits, 1);
  assert.equal(detail.customer.spent, 50000);
  assert.equal(detail.sales[0].id, prepared.data.sale.id);
  assert.deepEqual(detail.history.map(e => [e.kind, e.points]), [['earn', 500]]);
});

test('points are redeemed as a Woo fee-line discount, taken at once and given back if the sale is cancelled', async t => {
  const h = await harness(t);
  const { customer } = (await h.request('/customers', { method: 'POST', token: h.token, body: { name: 'Kwame Asante', phone: '0201234567' } })).data;
  await h.request(`/customers/${customer.id}/points`, { method: 'POST', token: h.token, body: { points: 800, note: 'Opening balance from paper card' } });
  const odd = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart({ customerId: customer.id, redeemPoints: 150 }) });
  assert.equal(odd.status, 400); assert.equal(odd.data.code, 'POINTS_INVALID');
  const tooMany = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart({ customerId: customer.id, redeemPoints: 900 }) });
  assert.equal(tooMany.status, 409); assert.equal(tooMany.data.code, 'POINTS_INSUFFICIENT');
  const prepared = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart({ customerId: customer.id, redeemPoints: 500 }) });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  assert.equal(prepared.data.sale.total, 49500, 'GH₵500 less GH₵5 of points');
  const order = h.api.state.orders.at(-1);
  assert.deepEqual(order.fee_lines, [{ name: 'Loyalty points (500)', total: '-5.00', tax_status: 'none' }]);
  assert.equal((await h.request(`/customers/${customer.id}`, { token: h.token })).data.customer.points, 300, 'Points taken when the order is prepared');
  const second = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart({ customerId: customer.id, redeemPoints: 500 }, 1) });
  assert.equal(second.data.code, 'POINTS_INSUFFICIENT', 'The same points cannot be spent twice');
  assert.equal((await h.request(`/sales/${prepared.data.sale.id}/cancel`, { method: 'POST', token: h.token })).status, 200);
  assert.equal((await h.request(`/customers/${customer.id}`, { token: h.token })).data.customer.points, 800, 'Given back on cancel');
});

test('a points sale is paid for the discounted total and earns on what was paid', async t => {
  const h = await harness(t);
  const { customer } = (await h.request('/customers', { method: 'POST', token: h.token, body: { name: 'Kwame Asante', phone: '0201234567' } })).data;
  await h.request(`/customers/${customer.id}/points`, { method: 'POST', token: h.token, body: { points: 1000, note: 'Welcome bonus' } });
  const prepared = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart({ customerId: customer.id, redeemPoints: 1000 }) });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const paid = await pay(h, prepared.data.sale);
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.total, 49000);
  const detail = (await h.request(`/customers/${customer.id}`, { token: h.token })).data;
  assert.equal(detail.customer.points, 490, '1000 - 1000 redeemed + 490 earned on GH₵490');
});

test('a return refunds the discounted price and takes back the points earned on it', async t => {
  const h = await harness(t);
  const { customer } = (await h.request('/customers', { method: 'POST', token: h.token, body: { name: 'Esi Owusu', phone: '0551112222' } })).data;
  await h.request(`/customers/${customer.id}/points`, { method: 'POST', token: h.token, body: { points: 1000, note: 'Welcome bonus' } });
  const prepared = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: cart({ customerId: customer.id, redeemPoints: 1000 }) });
  await pay(h, prepared.data.sale);
  const ret = await h.request('/returns', { method: 'POST', token: h.token, body: { key: randomUUID(), saleId: prepared.data.sale.id, reason: 'wrong_size', lines: [{ productId: 10, variationId: 11, quantity: 1, disposition: 'restock' }] } });
  assert.equal(ret.status, 200, JSON.stringify(ret.data));
  assert.equal(ret.data.return.refundTotal, 24500, 'Half of the GH₵490 actually paid, not the GH₵250 shelf price');
  const detail = (await h.request(`/customers/${customer.id}`, { token: h.token })).data;
  assert.equal(detail.customer.points, 490 - 245);
  assert.equal(detail.history[0].kind, 'return');
});

test('only an owner can change points by hand, never below zero; wholesale cannot use loyalty', async t => {
  const h = await harness(t);
  const { customer } = (await h.request('/customers', { method: 'POST', token: h.token, body: { name: 'Yaw Boateng', phone: '0277000000' } })).data;
  const below = await h.request(`/customers/${customer.id}/points`, { method: 'POST', token: h.token, body: { points: -10, note: 'Mistake' } });
  assert.equal(below.status, 409);
  await h.request('/staff', { method: 'POST', token: h.token, body: { username: 'ama', name: 'Ama', role: 'cashier', password: 'cashier-secret-phrase-1' } });
  let cashier = (await h.request('/auth/login', { method: 'POST', body: { username: 'ama', password: 'cashier-secret-phrase-1' } })).data.token;
  await h.request('/auth/password', { method: 'POST', token: cashier, body: { currentPassword: 'cashier-secret-phrase-1', newPassword: 'cashier-rotated-phrase-2' } });
  assert.equal((await h.request(`/customers/${customer.id}/points`, { method: 'POST', token: cashier, body: { points: 100, note: 'Free points' } })).status, 403);
  assert.equal((await h.request('/customers?q=yaw', { token: cashier })).status, 200, 'Cashiers can find customers at the till');
  const wholesale = await h.request('/sales/prepare', { method: 'POST', token: h.token, body: { ...cart({ customerId: customer.id }), saleType: 'wholesale', wholesaleApproved: true, items: [{ productId: 10, variationId: 11, quantity: 1, agreedUnitPrice: 10000 }] } });
  assert.equal(wholesale.status, 400);
  assert.throws(() => h.db.prepare('DELETE FROM customers').run(), /cannot be deleted/);
  h.db.prepare("INSERT INTO loyalty_ledger(customer_id,kind,points,balance_after,actor_id,created_at) VALUES (?,'adjust',1,1,'x','now')").run(customer.id);
  assert.throws(() => h.db.prepare('DELETE FROM loyalty_ledger').run(), /append-only/);
});
