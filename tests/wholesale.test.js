import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { openDatabase, saleView, SCHEMA_VERSION } from '../server/db.js';
import { RemoteError } from '../server/errors.js';

const decimal = cents => (cents / 100).toFixed(2);
function fakeWoo(options = {}) {
  const state = { orders: [], creates: 0, reprices: 0, payments: 0, stock: 10, loseReprice: false, losePayment: false, exemptDress: false };
  const product = { id: 10, name: 'Wholesale dress', type: 'variable', sku: 'WHOLESALE', price: '100.00', images: [], categories: [], status: 'publish', purchasable: true, manage_stock: false, stock_status: 'instock', backorders: 'no' };
  const variation = { id: 11, sku: 'WHOLESALE-M', price: '100.00', attributes: [{ name: 'Size', option: 'M' }], manage_stock: true, stock_quantity: state.stock, stock_status: 'instock', backorders: 'no', purchasable: true };
  const simple = { id: 20, name: 'Wholesale accessory', type: 'simple', sku: 'ACCESSORY', price: '60.00', images: [], categories: [], status: 'publish', purchasable: true, manage_stock: true, stock_quantity: state.stock, stock_status: 'instock', backorders: 'no', tax_status: 'none' };
  const tax = (net, id) => options.noTax || id === 20 || state.exemptDress ? 0 : Math.round(net * 0.15);
  const view = order => {
    if (!order) return null;
    const line_items = order.lines.map(line => ({ id: line.id, product_id: line.product_id, variation_id: line.variation_id, quantity: line.quantity, name: line.product_id === 20 ? simple.name : product.name, sku: line.product_id === 20 ? simple.sku : variation.sku, price: line.net / line.quantity / 100, subtotal: decimal(line.net), total: decimal(line.net), subtotal_tax: decimal(tax(line.net, line.product_id)), total_tax: decimal(tax(line.net, line.product_id)), meta_data: [...(line.product_id === 20 ? [] : [{ key: 'Size', value: 'M' }]), ...(line.meta_data || [])] }));
    const totalTax = order.lines.reduce((sum, line) => sum + tax(line.net, line.product_id), 0);
    return { ...order, lines: undefined, line_items, total: decimal(order.lines.reduce((sum, line) => sum + line.net + tax(line.net, line.product_id), 0)), total_tax: decimal(totalTax), tax_lines: totalTax ? [{ tax_total: decimal(totalTax), shipping_tax_total: '0.00' }] : [], currency: order.currency, shipping_total: '0.00', discount_total: '0.00', fee_lines: [], coupon_lines: [], shipping_lines: [], refunds: [] };
  };
  return {
    state,
    async products() { return { data: [product, simple], pages: 1 }; },
    async variations() { return { data: [{ ...variation, stock_quantity: state.stock }], pages: 1 }; },
    async product(id) { return id === 20 ? { ...simple, stock_quantity: state.stock } : product; },
    async variation() { return { ...variation, stock_quantity: state.stock }; },
    async createOrder(body) {
      state.creates++;
      const order = { ...body, id: 900 + state.creates, number: String(900 + state.creates), status: 'pending', currency: 'GHS', date_paid: null,
        lines: body.line_items.map((line, index) => ({ ...line, variation_id: line.variation_id || 0, id: 3000 + state.creates * 100 + index, net: (line.product_id === 20 ? 6000 : 10000) * line.quantity })) };
      delete order.line_items;
      state.orders.push(order);
      return view(order);
    },
    async updateOrder(id, body) {
      const order = state.orders.find(item => item.id === id);
      if (!order) throw new Error('Unexpected Woo order ID');
      if (body.line_items) {
        state.reprices++;
        for (const update of body.line_items) {
          const line = order.lines.find(item => item.id === update.id);
          if (!line || update.total !== update.subtotal) throw new Error('Wholesale repricing must update the exact order line subtotal and total.');
          line.net = Math.round(Number(update.total) * 100);
        }
        if (state.loseReprice) { state.loseReprice = false; throw new RemoteError('Lost response after Woo applied the repricing', 502, true); }
      }
      if (body.set_paid) {
        state.payments++;
        order.status = body.status;
        order.payment_method = body.payment_method;
        order.transaction_id = body.transaction_id;
        order.date_paid_gmt = new Date().toISOString();
      }
      if (body.status === 'cancelled') order.status = 'cancelled';
      if (body.meta_data) for (const item of body.meta_data) {
        const previous = order.meta_data.find(entry => entry.key === item.key);
        if (previous) previous.value = item.value; else order.meta_data.push(item);
      }
      if (body.set_paid && state.losePayment) { state.losePayment = false; throw new RemoteError('Lost response after Woo applied payment', 502, true); }
      return view(order);
    },
    async order(id) { return view(state.orders.find(item => item.id === id)); },
    async findOrderByKey(key) { return view(state.orders.find(item => item.meta_data.some(meta => meta.key === '_mansu_pos_key' && meta.value === key))); },
  };
}

async function harness(t, mode = 'demo', options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-wholesale-'));
  const api = fakeWoo(options.woo || {});
  const env = { POS_MODE: mode, POS_DATA_DIR: dir, NODE_ENV: 'test', WOO_BASE_URL: mode === 'staging' ? 'https://staging.example.com' : 'https://www.mansutrendzgh.com', WOO_CONSUMER_KEY: 'ck_test', WOO_CONSUMER_SECRET: 'cs_test', POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'original-secret-passphrase-123', POS_REQUIRE_SHIFT: 'false', POS_STAGING_APPROVED: 'true', ...options.env };
  const instance = createApp({ env, api, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, { method = 'GET', body, token } = {}) {
    const response = await fetch(`${base}/api${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const token = mode === 'demo'
    ? (await request('/auth/demo', { method: 'POST', body: {} })).data.token
    : (await request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'original-secret-passphrase-123' } })).data.token;
  if (mode !== 'demo') assert.equal((await request('/auth/password', { method: 'POST', token, body: { currentPassword: 'original-secret-passphrase-123', newPassword: 'changed-secret-passphrase-123' } })).status, 200);
  const addBuyer = async (name = 'Wholesale buyer', as = token) => {
    const result = await request('/wholesale-buyers', { method: 'POST', token: as, body: { name } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.buyer;
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const buyer = instance.config.wholesaleWritesEnabled ? await addBuyer() : { id: randomUUID(), name: 'Wholesale buyer' };
  return { ...instance, base, request, token, api, buyer, addBuyer };
}
const wholesale = (h, price = 9200, buyerId = h.buyer.id) => ({ idempotencyKey: randomUUID(), saleType: 'wholesale', buyerId, wholesaleApproved: true, items: [{ productId: 10, variationId: 11, quantity: 1, agreedUnitPrice: price }] });
const wholesaleWithoutBuyer = (price = 9200) => ({ idempotencyKey: randomUUID(), saleType: 'wholesale', wholesaleApproved: true, items: [{ productId: 10, variationId: 11, quantity: 1, agreedUnitPrice: price }] });
const wholesaleWithName = (buyerName, price = 9200) => ({ ...wholesaleWithoutBuyer(price), buyerName });
const prepare = (h, body, token = h.token) => h.request('/sales/prepare', { method: 'POST', token, body });

test('wholesale approval and separate staging/live write gates fail closed; retail cannot submit prices', async t => {
  const demo = await harness(t);
  const quote = wholesale(demo);
  for (const invalid of [
    { ...quote, saleType: 'retail' },
    { ...quote, saleType: 'trade', wholesaleApproved: undefined, tradeApproved: true },
    { ...quote, wholesaleApproved: false },
    { ...quote, buyerName: 'Another buyer' },
    wholesaleWithName('X'),
    wholesaleWithName('Bad\nBuyer'),
    wholesaleWithName('B'.repeat(121)),
    { ...wholesaleWithoutBuyer(), buyerName: 'Buyer Studio', wholesaleApproved: false },
    { ...quote, items: [{ ...quote.items[0], agreedUnitPrice: 0 }] },
    { ...quote, items: [{ ...quote.items[0], agreedUnitPrice: 1.5 }] },
    { ...quote, items: [{ ...quote.items[0], agreedUnitPrice: undefined }] },
    { ...quote, items: [{ ...quote.items[0], quantity: 999, agreedUnitPrice: 100000000 }] },
  ]) assert.equal((await prepare(demo, { ...invalid, idempotencyKey: randomUUID() })).status, 400);
  assert.equal((await prepare(demo, { idempotencyKey: randomUUID(), buyerName: 'Buyer Studio', items: [{ productId: 10, variationId: 11, quantity: 1 }] })).status, 400, 'Retail must not record a negotiated buyer name.');
  const staging = await harness(t, 'staging');
  assert.equal(staging.config.writesEnabled, true);
  assert.equal(staging.config.wholesaleWritesEnabled, false);
  const disabled = await prepare(staging, wholesale(staging));
  assert.equal(disabled.status, 403);
  assert.equal(disabled.data.code, 'WHOLESALE_CHECKOUT_LOCKED');
  assert.equal(staging.api.state.creates, 0);
  assert.equal((await staging.request('/wholesale-buyers', { method: 'POST', token: staging.token, body: { name: 'Locked buyer' } })).status, 403);
  assert.equal((await staging.request('/trade-buyers', { token: staging.token })).status, 404);
  assert.equal(readConfig({ POS_MODE: 'staging', WOO_BASE_URL: 'https://staging.example.com', WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's', POS_STAGING_APPROVED: 'true', POS_STAGING_TRADE_APPROVED: 'true' }).wholesaleWritesEnabled, false, 'Legacy approval cannot authorize a new wholesale flow.');
  assert.equal(readConfig({ POS_MODE: 'live', WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's', POS_ALLOW_LIVE_WRITES: 'true', POS_OWNER_APPROVAL_REFERENCE: 'written-owner-approval', POS_STAGING_WHOLESALE_APPROVED: 'true' }).wholesaleWritesEnabled, false);
});

test('cashier cannot create wholesale orders; named manager may negotiate when staging gate is open', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  for (const [role, username] of [['cashier', 'wholesalecash'], ['manager', 'wholesalemgr']]) {
    assert.equal((await h.request('/staff', { method: 'POST', token: h.token, body: { name: username, username, role, password: 'person-secret-passphrase-123' } })).status, 201);
    const token = (await h.request('/auth/login', { method: 'POST', body: { username, password: 'person-secret-passphrase-123' } })).data.token;
    assert.equal((await h.request('/auth/password', { method: 'POST', token, body: { currentPassword: 'person-secret-passphrase-123', newPassword: 'person-rotated-passphrase-123' } })).status, 200);
    const result = await prepare(h, wholesale(h), token);
    assert.equal(result.status, role === 'cashier' ? 403 : 201, JSON.stringify(result.data));
    if (role === 'cashier') assert.equal(result.data.code, 'WHOLESALE_ROLE_REQUIRED');
  }
  assert.equal(h.api.state.creates, 1);
});

test('demo wholesale quote uses all-in agreed unit prices, full payment, a durable buyer and idempotency', async t => {
  const h = await harness(t);
  const initialStock = h.db.prepare('SELECT stock FROM demo_stock WHERE line_key=?').get('7331:0').stock;
  const buyer = await h.addBuyer('Buyer Studio');
  const input = { ...wholesale(h, 7800, buyer.id), items: [{ productId: 7331, variationId: 0, quantity: 2, agreedUnitPrice: 7800 }] };
  const prepared = await prepare(h, input);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  assert.equal(prepared.data.sale.total, 15600);
  assert.equal(prepared.data.sale.agreedTotal, 15600);
  assert.equal(prepared.data.sale.saleType, 'wholesale');
  assert.equal(prepared.data.sale.buyerName, 'Buyer Studio');
  assert.equal(prepared.data.sale.items[0].agreedUnitPrice, 7800);
  assert.equal((await prepare(h, input)).data.sale.id, prepared.data.sale.id);
  assert.equal((await prepare(h, { ...input, buyerId: (await h.addBuyer('Other buyer')).id })).status, 409);
  assert.equal((await prepare(h, { ...input, idempotencyKey: randomUUID(), items: [{ ...input.items[0], agreedUnitPrice: 8100 }] })).status, 409);
  const id = prepared.data.sale.id;
  assert.equal((await h.request(`/sales/${id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 15599, confirmed: true } })).status, 400);
  const paid = await h.request(`/sales/${id}/pay`, { method: 'POST', token: h.token, body: { method: 'momo', reference: 'MERCHANT-WHOLESALE-001', confirmed: true } });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.sale.status, 'paid');
  assert.equal(paid.data.sale.total, 15600);
  assert.equal(h.db.prepare('SELECT stock FROM demo_stock WHERE line_key=?').get('7331:0').stock, initialStock - 2);
  assert.ok(h.db.prepare("SELECT 1 FROM audit WHERE action='sale.wholesale_prepared' AND actor='demo-owner' AND subject=?").get(id));
  assert.equal(h.api.state.creates, 0);
});

test('wholesale can start without any buyer, recover the same quote, and record full payment', async t => {
  const h = await harness(t);
  const input = { ...wholesaleWithoutBuyer(7800), items: [{ productId: 7331, variationId: 0, quantity: 2, agreedUnitPrice: 7800 }] };
  const prepared = await prepare(h, input);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const sale = prepared.data.sale;
  assert.equal(sale.saleType, 'wholesale');
  assert.equal(sale.buyerId, null);
  assert.equal(sale.buyerName, '');
  assert.equal(sale.agreedTotal, 15600);
  const saved = h.db.prepare('SELECT buyer_id,buyer_name FROM sales WHERE id=?').get(sale.id);
  assert.equal(saved.buyer_id, null);
  assert.equal(saved.buyer_name, '');
  assert.equal((await prepare(h, input)).data.sale.id, sale.id);
  assert.equal((await prepare(h, { ...input, buyerName: 'Optional name' })).status, 409, 'Changing the name cannot reuse the checkout key.');
  assert.equal((await prepare(h, { ...input, idempotencyKey: randomUUID(), buyerName: 'Optional name', items: [{ ...input.items[0], agreedUnitPrice: 8000 }] })).status, 409, 'Changing the name and price after an uncertain response cannot create a second order.');
  assert.equal((await prepare(h, { ...input, idempotencyKey: randomUUID(), items: [{ ...input.items[0], agreedUnitPrice: 8000 }] })).status, 409, 'An unpaid unnamed quote cannot be duplicated by changing its price.');
  const paid = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 15600, confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.status, 'paid');
  const report = await h.request('/reports?days=1', { token: h.token });
  assert.equal(report.data.sales.find(entry => entry.id === sale.id).buyerName, '');
  const csv = await fetch(`${h.base}/api/reports/export?days=1`, { headers: { Authorization: `Bearer ${h.token}` } });
  assert.match(await csv.text(), /,"wholesale","","Demo Owner","156\.00"/);
});

test('Woo reprices a freely entered buyer name without requiring a directory selection', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const input = wholesaleWithName('  Buyer  Studio  ');
  const prepared = await prepare(h, input);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  assert.equal(h.api.state.creates, 1);
  assert.equal(h.api.state.reprices, 1);
  assert.equal(prepared.data.sale.total, 9200);
  assert.equal(prepared.data.sale.tax, 1200);
  assert.equal(prepared.data.sale.items[0].agreedUnitPrice, 9200);
  assert.equal(prepared.data.sale.buyerId, null);
  assert.equal(prepared.data.sale.buyerName, 'Buyer Studio');
  assert.equal(h.api.state.orders[0].lines[0].net, 8000);
  assert.equal(h.api.state.orders[0].billing.first_name, 'Buyer Studio');
  assert.equal(h.api.state.orders[0].meta_data.find(meta => meta.key === '_mansu_pos_wholesale_buyer').value, 'Buyer Studio');
  assert.equal(h.api.state.orders[0].meta_data.some(meta => meta.key === '_mansu_pos_wholesale_buyer_id'), false);
  assert.equal((await prepare(h, input)).data.sale.id, prepared.data.sale.id);
  assert.equal((await prepare(h, { ...input, buyerName: 'Other Studio' })).status, 409);
  assert.equal((await prepare(h, wholesaleWithoutBuyer(9300))).status, 409, 'Clearing a name and changing price cannot duplicate the pending order.');
  const paid = await h.request(`/sales/${prepared.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 9200, confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.status, 'paid');
  assert.equal(paid.data.sale.total, 9200);
  assert.equal(h.api.state.payments, 1);
});

test('unnamed Woo wholesale order verifies its quote and pays without inventing buyer metadata', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const input = wholesaleWithoutBuyer();
  const prepared = await prepare(h, input);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const sale = prepared.data.sale;
  assert.equal(sale.buyerId, null);
  assert.equal(sale.buyerName, '');
  assert.equal(sale.total, 9200);
  assert.equal(sale.tax, 1200);
  const remote = h.api.state.orders[0];
  assert.equal(remote.billing, undefined);
  assert.equal(remote.meta_data.some(meta => ['_mansu_pos_wholesale_buyer', '_mansu_pos_wholesale_buyer_id'].includes(meta.key)), false);
  assert.ok(remote.meta_data.find(meta => meta.key === '_mansu_pos_quote_hash')?.value);
  assert.equal((await prepare(h, input)).data.sale.id, sale.id);
  const paid = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 9200, confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.status, 'paid');
  assert.equal(h.api.state.payments, 1);
});

test('an unnamed wholesale quote refuses a remotely added buyer or altered billing name', async t => {
  for (const kind of ['billing', 'metadata']) {
    const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
    const { sale } = (await prepare(h, wholesaleWithoutBuyer())).data;
    const order = h.api.state.orders[0];
    if (kind === 'billing') order.billing = { first_name: 'Injected buyer' };
    else order.meta_data.push({ key: '_mansu_pos_wholesale_buyer', value: 'Injected buyer' });
    const payment = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 9200, confirmed: true } });
    assert.equal(payment.status, 409, `${kind}: ${JSON.stringify(payment.data)}`);
    assert.equal(payment.data.code, 'WHOLESALE_QUOTE_CHANGED');
    assert.equal(h.api.state.payments, 0);
  }
});

test('wholesale price drift, metadata drift and unrepresentable tax-included amounts never become payable', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const prepared = await prepare(h, wholesale(h));
  assert.equal(prepared.status, 201);
  const id = prepared.data.sale.id;
  h.api.state.orders[0].lines[0].net = 9000;
  const drift = await h.request(`/sales/${id}/pay`, { method: 'POST', token: h.token, body: { method: 'momo', reference: 'MERCHANT-WHOLESALE-002', confirmed: true } });
  assert.equal(drift.status, 409);
  assert.equal(drift.data.code, 'TOTAL_CHANGED');
  assert.equal(h.api.state.payments, 0);
  assert.equal(h.sales.get(id, { role: 'owner' }).status, 'needs_reconciliation');
  const badMeta = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const approved = await prepare(badMeta, wholesale(badMeta));
  assert.equal(approved.status, 201);
  badMeta.api.state.orders[0].meta_data.find(meta => meta.key === '_mansu_pos_quote_hash').value = 'changed';
  const tampered = await badMeta.request(`/sales/${approved.data.sale.id}/pay`, { method: 'POST', token: badMeta.token, body: { method: 'momo', reference: 'MERCHANT-WHOLESALE-003', confirmed: true } });
  assert.equal(tampered.status, 409);
  assert.equal(tampered.data.code, 'WHOLESALE_QUOTE_CHANGED');
  assert.equal(badMeta.api.state.payments, 0);
  assert.equal(badMeta.sales.get(approved.data.sale.id, { role: 'owner' }).status, 'needs_reconciliation');
  const unrepresentable = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const gap = await prepare(unrepresentable, wholesale(unrepresentable, 4));
  assert.notEqual(gap.status, 201);
  assert.equal(unrepresentable.api.state.creates, 1);
  assert.equal(unrepresentable.api.state.payments, 0);
  assert.equal(unrepresentable.db.prepare("SELECT status FROM sales WHERE sale_type='trade' ORDER BY created_at DESC LIMIT 1").get().status, 'needs_reconciliation');
});

test('lost unnamed repricing response reconciles the same Woo order instead of creating a second one', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  h.api.state.loseReprice = true;
  const input = wholesaleWithoutBuyer();
  const interrupted = await prepare(h, input);
  assert.equal(interrupted.status, 502);
  assert.equal(interrupted.data.code, 'RECONCILIATION_REQUIRED');
  const retry = await prepare(h, input);
  assert.equal(retry.status, 201, JSON.stringify(retry.data));
  assert.equal(retry.data.sale.total, 9200);
  assert.equal(h.api.state.creates, 1);
  assert.equal(h.api.state.reprices, 1);
});

test('buyer directory is manager-only and the approving account is snapshotted on the Woo order and audit record', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  assert.equal((await h.request('/wholesale-buyers', { token: h.token })).data.buyers[0].name, 'Wholesale buyer');
  assert.equal((await h.request('/wholesale-buyers', { method: 'POST', token: h.token, body: { name: ' WHOLESALE buyer ' } })).status, 409);
  assert.equal((await h.request('/wholesale-buyers', { method: 'POST', token: h.token, body: { name: 'Bad\nBuyer' } })).status, 400);
  assert.equal((await prepare(h, wholesale(h, 9200, randomUUID()))).status, 400);
  const cashier = (await h.request('/staff', { method: 'POST', token: h.token, body: { name: 'Wholesale Cashier', username: 'wholesalecash', role: 'cashier', password: 'cashier-secret-passphrase-123' } })).data.user;
  const cashierToken = (await h.request('/auth/login', { method: 'POST', body: { username: 'wholesalecash', password: 'cashier-secret-passphrase-123' } })).data.token;
  assert.equal((await h.request('/auth/password', { method: 'POST', token: cashierToken, body: { currentPassword: 'cashier-secret-passphrase-123', newPassword: 'cashier-rotated-secret-123' } })).status, 200);
  assert.equal((await h.request('/wholesale-buyers', { token: cashierToken })).status, 403);
  assert.equal((await h.request('/wholesale-buyers', { method: 'POST', token: cashierToken, body: { name: 'Forbidden buyer' } })).status, 403);
  assert.equal((await prepare(h, wholesale(h), cashierToken)).data.code, 'WHOLESALE_ROLE_REQUIRED');
  assert.equal(h.api.state.creates, 0);
  const manager = (await h.request('/staff', { method: 'POST', token: h.token, body: { name: 'Wholesale Manager', username: 'wholesalemgr', role: 'manager', password: 'manager-secret-passphrase-123' } })).data.user;
  const managerToken = (await h.request('/auth/login', { method: 'POST', body: { username: 'wholesalemgr', password: 'manager-secret-passphrase-123' } })).data.token;
  assert.equal((await h.request('/auth/password', { method: 'POST', token: managerToken, body: { currentPassword: 'manager-secret-passphrase-123', newPassword: 'manager-rotated-secret-123' } })).status, 200);
  const buyer = await h.addBuyer('Studio buyer', managerToken);
  const prepared = await prepare(h, wholesale(h, 9200, buyer.id), managerToken);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const sale = prepared.data.sale;
  assert.equal(sale.buyerId, buyer.id);
  assert.equal(sale.buyerName, buyer.name);
  assert.equal(sale.wholesaleApprovedById, manager.id);
  assert.equal(sale.wholesaleApprovedByName, manager.name);
  assert.ok(sale.wholesaleApprovedAt);
  assert.equal(sale.agreedTotal, 9200);
  assert.equal(sale.items[0].cataloguePrice, 10000);
  const remote = h.api.state.orders[0];
  assert.equal(remote.billing.first_name, buyer.name);
  const meta = new Map(remote.meta_data.map(item => [item.key, item.value]));
  assert.equal(meta.get('_mansu_pos_wholesale_buyer_id'), buyer.id);
  assert.equal(meta.get('_mansu_pos_wholesale_approver'), manager.id);
  assert.equal(meta.get('_mansu_pos_wholesale_approver_name'), manager.name);
  assert.equal(meta.get('_mansu_pos_wholesale_approved_at'), sale.wholesaleApprovedAt);
  assert.equal(remote.lines[0].meta_data.find(item => item.key === 'Mansu agreed unit gross (GHS)').value, '92.00');
  assert.equal(remote.lines[0].meta_data.find(item => item.key === 'Mansu catalogue unit (GHS)').value, '100.00');
  assert.equal(h.db.prepare('SELECT actor FROM audit WHERE action=? AND subject=?').get('sale.wholesale_prepared', sale.id).actor, manager.id);
  assert.notEqual(cashier.id, sale.wholesaleApprovedById);
});

test('mixed tax classes, multiple individually negotiated goods and quantity preserve each final unit amount', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const input = { ...wholesale(h, 9200), items: [
    { productId: 10, variationId: 11, quantity: 2, agreedUnitPrice: 9200 },
    { productId: 20, variationId: 0, quantity: 1, agreedUnitPrice: 7500 },
  ] };
  const prepared = await prepare(h, input);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  assert.equal(prepared.data.sale.total, 25900);
  assert.equal(prepared.data.sale.agreedTotal, 25900);
  assert.equal(prepared.data.sale.tax, 2400);
  assert.deepEqual(prepared.data.sale.items.map(item => item.agreedLineTotal).sort((a,b) => a-b), [7500, 18400]);
  assert.equal(h.api.state.creates, 1);
  assert.equal(h.api.state.reprices, 1);
  assert.deepEqual(h.api.state.orders[0].lines.map(line => line.net).sort((a,b) => a-b), [7500, 16000]);
  assert.equal(h.api.state.orders[0].lines.find(line => line.product_id === 10).quantity, 2);
  assert.equal((await prepare(h, input)).data.sale.id, prepared.data.sale.id);
  const paid = await h.request(`/sales/${prepared.data.sale.id}/pay`, { method: 'POST', token: h.token,
    body: { method: 'momo', reference: 'MERCHANT-WHOLESALE-MIXED', confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.total, 25900);
  assert.equal(paid.data.sale.items[0].agreedUnitPrice, 9200);
  assert.equal(paid.data.sale.items[1].agreedUnitPrice, 7500);
  assert.equal(paid.data.sale.paymentReference, 'MERCHANT-WHOLESALE-MIXED');
  assert.equal(h.db.prepare('SELECT prepared_total,trade_verified_json FROM sales WHERE id=?').get(paid.data.sale.id).prepared_total, 25900);
  const report = await h.request('/reports?days=1', { token: h.token });
  assert.equal(report.status, 200);
  assert.equal(report.data.total, 25900);
  assert.equal(report.data.sales.find(s => s.id === paid.data.sale.id).saleType, 'wholesale');
  assert.equal(report.data.sales.find(s => s.id === paid.data.sale.id).agreedTotal, 25900);
  assert.deepEqual(report.data.saleTypes, [{ type: 'retail', count: 0, total: 0 }, { type: 'wholesale', count: 1, total: 25900 }]);
  const exportResponse = await fetch(`${h.base}/api/reports/export?days=1`, { headers: { Authorization: `Bearer ${h.token}` } });
  assert.equal(exportResponse.status, 200);
  const csv = await exportResponse.text();
  assert.match(csv, /"Sale type","Wholesale buyer","Wholesale approved by","Agreed wholesale total GHS"/);
  assert.match(csv, /,"wholesale","Wholesale buyer","Store Owner","259\.00"/);
});

test('untaxed wholesale products do not gain tax, and conflicting agreed prices for one option fail before Woo creation', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' }, woo: { noTax: true } });
  const conflicting = wholesale(h);
  conflicting.items.push({ ...conflicting.items[0], agreedUnitPrice: 9300 });
  assert.equal((await prepare(h, conflicting)).status, 400);
  assert.equal(h.api.state.creates, 0);
  const exempt = await prepare(h, wholesale(h, 8500));
  assert.equal(exempt.status, 201, JSON.stringify(exempt.data));
  assert.equal(exempt.data.sale.tax, 0);
  assert.equal(exempt.data.sale.total, 8500);
  assert.equal(h.api.state.orders[0].lines[0].net, 8500);
  assert.equal(h.api.state.orders[0].lines[0].meta_data.find(item => item.key === 'Mansu agreed unit gross (GHS)').value, '85.00');
});

test('tax composition drift at the same gross total is blocked and fixed Woo data can be reconciled', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const { sale } = (await prepare(h, wholesale(h))).data;
  const immutable = h.db.prepare('SELECT trade_verified_json FROM sales WHERE id=?').get(sale.id).trade_verified_json;
  h.api.state.exemptDress = true;
  h.api.state.orders[0].lines[0].net = 9200; // Gross remains GH₵92.00 but included tax was removed.
  const drift = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 9200, confirmed: true } });
  assert.equal(drift.status, 409);
  assert.equal(drift.data.code, 'WHOLESALE_QUOTE_CHANGED');
  assert.equal(h.api.state.payments, 0);
  assert.equal(h.db.prepare('SELECT trade_verified_json FROM sales WHERE id=?').get(sale.id).trade_verified_json, immutable);
  h.api.state.exemptDress = false;
  h.api.state.orders[0].lines[0].net = 8000;
  const resolved = await h.request(`/sales/${sale.id}/reconcile`, { method: 'POST', token: h.token, body: {} });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.sale.status, 'awaiting_payment');
  const paid = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 9200, confirmed: true } });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.sale.status, 'paid');
});

test('lost paid-order response reconciles the original verified payment without collecting twice', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const { sale } = (await prepare(h, wholesale(h))).data;
  h.api.state.losePayment = true;
  const first = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'card', reference: 'TERMINAL-WHOLESALE-999', confirmed: true } });
  assert.equal(first.status, 502);
  assert.equal(first.data.code, 'RECONCILIATION_REQUIRED');
  assert.equal(h.api.state.payments, 1);
  assert.equal(h.sales.get(sale.id, { role: 'owner' }).status, 'needs_reconciliation');
  assert.equal((await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'card', reference: 'TERMINAL-WHOLESALE-999', confirmed: true } })).status, 409);
  const checked = await h.request(`/sales/${sale.id}/reconcile`, { method: 'POST', token: h.token, body: {} });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.sale.status, 'paid');
  assert.equal(checked.data.sale.paymentReference, 'TERMINAL-WHOLESALE-999');
  assert.equal(checked.data.sale.total, 9200);
  assert.equal(h.api.state.payments, 1);
});

test('Woo paid flag without a matching POS verification never releases a wholesale order', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const { sale } = (await prepare(h, wholesale(h))).data;
  const order = h.api.state.orders[0];
  order.status = 'completed'; order.date_paid_gmt = new Date().toISOString(); order.payment_method = 'some_gateway';
  const checked = await h.request(`/sales/${sale.id}/reconcile`, { method: 'POST', token: h.token, body: {} });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.sale.status, 'needs_reconciliation');
  assert.match(checked.data.sale.error, /verified POS payment record/);
  assert.equal((await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 9200, confirmed: true } })).status, 409);
  assert.equal(h.api.state.payments, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM audit WHERE action=?').get('sale.paid').count, 0);
});

test('concurrent wholesale submissions for one named buyer cannot create two pending Woo orders', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const [a, b] = await Promise.all([prepare(h, wholesale(h)), prepare(h, wholesale(h))]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(h.api.state.creates, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM sales WHERE sale_type='trade'").get().count, 1);
});

test('concurrent unnamed and free-text name orders cannot bypass pending-quote recovery', async t => {
  for (const makeQuote of [() => wholesaleWithoutBuyer(), () => wholesaleWithName('Buyer Studio')]) {
    const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
    const [a, b] = await Promise.all([prepare(h, makeQuote()), prepare(h, makeQuote())]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(h.api.state.creates, 1);
  }
});

test('an older pending wholesale cart cannot be duplicated by a different approver and name', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const original = await prepare(h, wholesaleWithoutBuyer());
  assert.equal(original.status, 201);
  h.db.prepare('UPDATE sales SET created_at=? WHERE id=?').run(new Date(Date.now() - 60 * 60000).toISOString(), original.data.sale.id);
  assert.equal((await h.request('/staff', { method: 'POST', token: h.token, body: { name: 'Second Approver', username: 'secondapprover', role: 'manager', password: 'manager-secret-passphrase-123' } })).status, 201);
  const token = (await h.request('/auth/login', { method: 'POST', body: { username: 'secondapprover', password: 'manager-secret-passphrase-123' } })).data.token;
  assert.equal((await h.request('/auth/password', { method: 'POST', token, body: { currentPassword: 'manager-secret-passphrase-123', newPassword: 'manager-rotated-secret-123' } })).status, 200);
  const duplicate = await prepare(h, wholesaleWithName('Different buyer', 9300), token);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'RECONCILIATION_REQUIRED');
  assert.equal(h.api.state.creates, 1);
  const unrelated = await prepare(h, { ...wholesaleWithName('Different buyer', 7500), items: [{ productId: 20, variationId: 0, quantity: 1, agreedUnitPrice: 7500 }] }, token);
  assert.equal(unrelated.status, 201, JSON.stringify(unrelated.data));
  assert.equal(h.api.state.creates, 2, 'A different cart remains available.');
});

test('simulated live Wholesale requires its distinct acceptance gate and can record cash only', async t => {
  const h = await harness(t, 'live', { env: {
    POS_STAGING_WHOLESALE_APPROVED: 'false', POS_ALLOW_LIVE_WRITES: 'true',
    POS_OWNER_APPROVAL_REFERENCE: 'written-owner-approval', POS_LIVE_WHOLESALE_APPROVED: 'true',
    POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE: 'simulated-only-not-real-acceptance',
  } });
  assert.equal(h.config.wholesaleWritesEnabled, true);
  const prepared = await prepare(h, wholesaleWithoutBuyer());
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const sale = prepared.data.sale;
  const blocked = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token,
    body: { method: 'momo', reference: 'TEST-EXTERNAL', confirmed: true } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'PAYMENT_METHOD_LOCKED');
  assert.equal(h.api.state.payments, 0);
  const paid = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token,
    body: { method: 'cash', tendered: 10000, confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.status, 'paid');
  assert.equal(h.api.state.orders[0].payment_method, 'pos_cash');
  assert.equal(h.api.state.payments, 1);
});

test('closing the separate wholesale gate blocks payment of an already prepared wholesale order', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const { sale } = (await prepare(h, wholesale(h))).data;
  h.config.wholesaleWritesEnabled = false;
  const blocked = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 9200, confirmed: true } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'WHOLESALE_CHECKOUT_LOCKED');
  assert.equal(h.api.state.payments, 0);
  assert.equal((await h.request(`/sales/${sale.id}/cancel`, { method: 'POST', token: h.token, body: {} })).data.code, 'WHOLESALE_CHECKOUT_LOCKED');
  assert.equal(h.api.state.orders[0].status, 'pending', 'Revoked approval must also block remote cancellation writes.');
  assert.equal(h.sales.get(sale.id, { role: 'owner' }).status, 'awaiting_payment');
  assert.throws(() => readConfig({ POS_MODE: 'live', WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's', POS_ALLOW_LIVE_WRITES: 'true', POS_OWNER_APPROVAL_REFERENCE: 'written-owner-approval', POS_LIVE_WHOLESALE_APPROVED: 'true' }), /POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE/);
  assert.equal(readConfig({ POS_MODE: 'live', WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's', POS_ALLOW_LIVE_WRITES: 'true', POS_OWNER_APPROVAL_REFERENCE: 'written-owner-approval', POS_STAGING_WHOLESALE_APPROVED: 'false', POS_LIVE_WHOLESALE_APPROVED: 'true', POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE: 'documented-live-acceptance' }).wholesaleWritesEnabled, true, 'Documented live acceptance can authorize Wholesale without falsely claiming staging was passed.');
  assert.equal(readConfig({ POS_MODE: 'live', WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's', POS_ALLOW_LIVE_WRITES: 'true', POS_OWNER_APPROVAL_REFERENCE: 'written-owner-approval', POS_STAGING_WHOLESALE_APPROVED: 'true', POS_LIVE_WHOLESALE_APPROVED: 'false', POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE: 'documented-live-acceptance' }).wholesaleWritesEnabled, false, 'Staging approval cannot enable live Wholesale.');
});

test('revoking the general write gate blocks payment and cancellation for retail and wholesale pending orders', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const retail = (await prepare(h, { idempotencyKey: randomUUID(), items: [{ productId: 10, variationId: 11, quantity: 1 }] })).data.sale;
  const negotiated = (await prepare(h, wholesale(h))).data.sale;
  h.config.writesEnabled = false;
  for (const sale of [retail, negotiated]) {
    const payment = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: sale.total, confirmed: true } });
    assert.equal(payment.status, 403); assert.equal(payment.data.code, 'CHECKOUT_LOCKED');
    const cancellation = await h.request(`/sales/${sale.id}/cancel`, { method: 'POST', token: h.token, body: {} });
    assert.equal(cancellation.status, 403); assert.equal(cancellation.data.code, 'CHECKOUT_LOCKED');
    assert.equal(h.sales.get(sale.id, { role: 'owner' }).status, 'awaiting_payment');
  }
  assert.equal(h.api.state.payments, 0);
  assert.deepEqual(h.api.state.orders.map(order => order.status), ['pending', 'pending']);
});

test('v4 historical orders and named buyers remain readable and payable after the wholesale replacement', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_WHOLESALE_APPROVED: 'true' } });
  const { sale } = (await prepare(h, wholesale(h))).data;
  assert.equal(sale.saleType, 'wholesale');
  assert.equal(h.db.prepare('SELECT sale_type FROM sales WHERE id=?').get(sale.id).sale_type, 'trade', 'The v4 ledger constraint and stored buyer references are preserved.');
  // Simulate a v4 order created before the replacement: old Woo metadata must
  // still reconcile against the immutable ledger agreement, not be discarded.
  const order = h.api.state.orders[0];
  for (const meta of order.meta_data) {
    if (meta.key === '_mansu_pos_sale_type') meta.value = 'trade';
    else if (meta.key.startsWith('_mansu_pos_wholesale_')) meta.key = meta.key.replace('_mansu_pos_wholesale_', '_mansu_pos_trade_');
  }
  const reconciled = await h.request(`/sales/${sale.id}/reconcile`, { method: 'POST', token: h.token, body: {} });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  assert.equal(reconciled.data.sale.status, 'awaiting_payment');
  assert.equal(reconciled.data.sale.saleType, 'wholesale');
  assert.equal(reconciled.data.sale.buyerName, h.buyer.name);
  assert.equal(reconciled.data.sale.wholesaleApprovedByName, 'Store Owner');
  assert.equal(reconciled.data.sale.agreedTotal, 9200);
  assert.equal((await h.request('/wholesale-buyers', { token: h.token })).data.buyers.some(b => b.id === h.buyer.id), true);
  const paid = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 9200, confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.status, 'paid');
  assert.equal(h.api.state.payments, 1);
  const report = await h.request('/reports?days=1', { token: h.token });
  assert.equal(report.data.sales.find(entry => entry.id === sale.id).saleType, 'wholesale');
  assert.deepEqual(report.data.saleTypes, [{ type: 'retail', count: 0, total: 0 }, { type: 'wholesale', count: 1, total: 9200 }]);
  const csv = await fetch(`${h.base}/api/reports/export?days=1`, { headers: { Authorization: `Bearer ${h.token}` } });
  assert.match(await csv.text(), /,"wholesale","Wholesale buyer","Store Owner","92\.00"/);
});

test('schema upgrade keeps previous paid retail receipts unchanged and introduces empty wholesale fields', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-wholesale-migration-'));
  const legacy = new DatabaseSync(path.join(dir, 'pos-demo.db'));
  legacy.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(3, '2026-11-03');
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
      password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE demo_stock (line_key TEXT PRIMARY KEY, stock INTEGER NOT NULL);
    CREATE TABLE sales (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
      number TEXT NOT NULL, woo_order_id INTEGER, status TEXT NOT NULL, payment_method TEXT, payment_reference TEXT,
      total INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0, subtotal INTEGER NOT NULL DEFAULT 0,
      refunded INTEGER NOT NULL DEFAULT 0, tendered INTEGER, change_due INTEGER, currency TEXT NOT NULL,
      cashier_id TEXT NOT NULL, cashier_name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      items_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      paid_at TEXT, error TEXT, shift_id TEXT, prepared_total INTEGER NOT NULL DEFAULT 0,
      last_reconciled_at TEXT, reconcile_attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sales(id,idempotency_key,fingerprint,number,status,payment_method,total,tax,subtotal,currency,cashier_id,cashier_name,items_json,created_at,updated_at,paid_at,prepared_total)
      VALUES ('old-retail','old-key','old-hash','DEMO-OLD','paid','cash',19900,0,19900,'GHS','demo-owner','Demo Owner',
        '[{"productId":7331,"variationId":0,"name":"Demo fan","price":19900,"quantity":1,"total":19900}]',
        '2026-11-03T00:00:00Z','2026-11-03T00:00:00Z','2026-11-03T00:00:00Z',19900);
  `);
  legacy.close();
  const db = openDatabase(readConfig({ POS_MODE: 'demo', POS_DATA_DIR: dir }));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, SCHEMA_VERSION);
  const sale = saleView(db.prepare('SELECT * FROM sales WHERE id=?').get('old-retail'));
  assert.equal(sale.status, 'paid');
  assert.equal(sale.saleType, 'retail');
  assert.equal(sale.total, 19900);
  assert.equal(sale.buyerId, null);
  assert.equal(sale.agreedTotal, null);
  assert.equal(sale.wholesaleApprovedById, null);
  assert.deepEqual(sale.items, [{ productId: 7331, variationId: 0, name: 'Demo fan', price: 19900, quantity: 1, total: 19900 }]);
});
