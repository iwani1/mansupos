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
  const product = { id: 10, name: 'Trade dress', type: 'variable', sku: 'TRADE', price: '100.00', images: [], categories: [], status: 'publish', purchasable: true, manage_stock: false, stock_status: 'instock', backorders: 'no' };
  const variation = { id: 11, sku: 'TRADE-M', price: '100.00', attributes: [{ name: 'Size', option: 'M' }], manage_stock: true, stock_quantity: state.stock, stock_status: 'instock', backorders: 'no', purchasable: true };
  const simple = { id: 20, name: 'Trade accessory', type: 'simple', sku: 'ACCESSORY', price: '60.00', images: [], categories: [], status: 'publish', purchasable: true, manage_stock: true, stock_quantity: state.stock, stock_status: 'instock', backorders: 'no', tax_status: 'none' };
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
          if (!line || update.total !== update.subtotal) throw new Error('Trade repricing must update the exact order line subtotal and total.');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-trade-'));
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
  const addBuyer = async (name = 'Trade buyer', as = token) => {
    const result = await request('/trade-buyers', { method: 'POST', token: as, body: { name } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.buyer;
  };
  const buyer = await addBuyer();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...instance, base, request, token, api, buyer, addBuyer };
}
const trade = (h, price = 9200, buyerId = h.buyer.id) => ({ idempotencyKey: randomUUID(), saleType: 'trade', buyerId, tradeApproved: true, items: [{ productId: 10, variationId: 11, quantity: 1, agreedUnitPrice: price }] });
const prepare = (h, body, token = h.token) => h.request('/sales/prepare', { method: 'POST', token, body });

test('trade approval and separate staging/live write gates fail closed; retail cannot submit prices', async t => {
  const demo = await harness(t);
  const quote = trade(demo);
  for (const invalid of [
    { ...quote, saleType: 'retail' },
    { ...quote, tradeApproved: false },
    { ...quote, buyerId: undefined },
    { ...quote, items: [{ ...quote.items[0], agreedUnitPrice: 0 }] },
    { ...quote, items: [{ ...quote.items[0], agreedUnitPrice: 1.5 }] },
    { ...quote, items: [{ ...quote.items[0], agreedUnitPrice: undefined }] },
    { ...quote, items: [{ ...quote.items[0], quantity: 999, agreedUnitPrice: 100000000 }] },
  ]) assert.equal((await prepare(demo, { ...invalid, idempotencyKey: randomUUID() })).status, 400);
  const staging = await harness(t, 'staging');
  assert.equal(staging.config.writesEnabled, true);
  assert.equal(staging.config.tradeWritesEnabled, false);
  const disabled = await prepare(staging, trade(staging));
  assert.equal(disabled.status, 403);
  assert.equal(disabled.data.code, 'TRADE_CHECKOUT_LOCKED');
  assert.equal(staging.api.state.creates, 0);
  assert.equal(readConfig({ POS_MODE: 'live', WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's', POS_ALLOW_LIVE_WRITES: 'true', POS_OWNER_APPROVAL_REFERENCE: 'written-owner-approval', POS_STAGING_TRADE_APPROVED: 'true' }).tradeWritesEnabled, false);
});

test('cashier cannot create trade orders; named manager may negotiate when staging gate is open', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  for (const [role, username] of [['cashier', 'tradecash'], ['manager', 'trademgr']]) {
    assert.equal((await h.request('/staff', { method: 'POST', token: h.token, body: { name: username, username, role, password: 'person-secret-passphrase-123' } })).status, 201);
    const token = (await h.request('/auth/login', { method: 'POST', body: { username, password: 'person-secret-passphrase-123' } })).data.token;
    assert.equal((await h.request('/auth/password', { method: 'POST', token, body: { currentPassword: 'person-secret-passphrase-123', newPassword: 'person-rotated-passphrase-123' } })).status, 200);
    const result = await prepare(h, trade(h), token);
    assert.equal(result.status, role === 'cashier' ? 403 : 201, JSON.stringify(result.data));
    if (role === 'cashier') assert.equal(result.data.code, 'TRADE_ROLE_REQUIRED');
  }
  assert.equal(h.api.state.creates, 1);
});

test('demo trade quote uses all-in agreed unit prices, full payment, a durable buyer and idempotency', async t => {
  const h = await harness(t);
  const initialStock = h.db.prepare('SELECT stock FROM demo_stock WHERE line_key=?').get('7331:0').stock;
  const buyer = await h.addBuyer('Buyer Studio');
  const input = { ...trade(h, 7800, buyer.id), items: [{ productId: 7331, variationId: 0, quantity: 2, agreedUnitPrice: 7800 }] };
  const prepared = await prepare(h, input);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  assert.equal(prepared.data.sale.total, 15600);
  assert.equal(prepared.data.sale.agreedTotal, 15600);
  assert.equal(prepared.data.sale.saleType, 'trade');
  assert.equal(prepared.data.sale.buyerName, 'Buyer Studio');
  assert.equal(prepared.data.sale.items[0].agreedUnitPrice, 7800);
  assert.equal((await prepare(h, input)).data.sale.id, prepared.data.sale.id);
  assert.equal((await prepare(h, { ...input, buyerId: (await h.addBuyer('Other buyer')).id })).status, 409);
  assert.equal((await prepare(h, { ...input, idempotencyKey: randomUUID(), items: [{ ...input.items[0], agreedUnitPrice: 8100 }] })).status, 409);
  const id = prepared.data.sale.id;
  assert.equal((await h.request(`/sales/${id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 15599, confirmed: true } })).status, 400);
  const paid = await h.request(`/sales/${id}/pay`, { method: 'POST', token: h.token, body: { method: 'momo', reference: 'MERCHANT-TRADE-001', confirmed: true } });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.sale.status, 'paid');
  assert.equal(paid.data.sale.total, 15600);
  assert.equal(h.db.prepare('SELECT stock FROM demo_stock WHERE line_key=?').get('7331:0').stock, initialStock - 2);
  assert.ok(h.db.prepare("SELECT 1 FROM audit WHERE action='sale.trade_prepared' AND actor='demo-owner' AND subject=?").get(id));
  assert.equal(h.api.state.creates, 0);
});

test('Woo reprices each trade line using Woo tax, verifies the exact all-in quote, and preserves it on retry', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  const buyer = await h.addBuyer('Buyer Studio');
  const input = trade(h, 9200, buyer.id);
  const prepared = await prepare(h, input);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  assert.equal(h.api.state.creates, 1);
  assert.equal(h.api.state.reprices, 1);
  assert.equal(prepared.data.sale.total, 9200);
  assert.equal(prepared.data.sale.tax, 1200);
  assert.equal(prepared.data.sale.items[0].agreedUnitPrice, 9200);
  assert.equal(h.api.state.orders[0].lines[0].net, 8000);
  assert.equal(h.api.state.orders[0].meta_data.find(meta => meta.key === '_mansu_pos_trade_buyer').value, 'Buyer Studio');
  assert.equal((await prepare(h, input)).data.sale.id, prepared.data.sale.id);
  const paid = await h.request(`/sales/${prepared.data.sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 9200, confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.status, 'paid');
  assert.equal(paid.data.sale.total, 9200);
  assert.equal(h.api.state.payments, 1);
});

test('trade price drift, metadata drift and unrepresentable tax-included amounts never become payable', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  const prepared = await prepare(h, trade(h));
  assert.equal(prepared.status, 201);
  const id = prepared.data.sale.id;
  h.api.state.orders[0].lines[0].net = 9000;
  const drift = await h.request(`/sales/${id}/pay`, { method: 'POST', token: h.token, body: { method: 'momo', reference: 'MERCHANT-TRADE-002', confirmed: true } });
  assert.equal(drift.status, 409);
  assert.equal(drift.data.code, 'TOTAL_CHANGED');
  assert.equal(h.api.state.payments, 0);
  assert.equal(h.sales.get(id, { role: 'owner' }).status, 'needs_reconciliation');
  const badMeta = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  const approved = await prepare(badMeta, trade(badMeta));
  assert.equal(approved.status, 201);
  badMeta.api.state.orders[0].meta_data.find(meta => meta.key === '_mansu_pos_quote_hash').value = 'changed';
  const tampered = await badMeta.request(`/sales/${approved.data.sale.id}/pay`, { method: 'POST', token: badMeta.token, body: { method: 'momo', reference: 'MERCHANT-TRADE-003', confirmed: true } });
  assert.equal(tampered.status, 409);
  assert.equal(tampered.data.code, 'TRADE_QUOTE_CHANGED');
  assert.equal(badMeta.api.state.payments, 0);
  assert.equal(badMeta.sales.get(approved.data.sale.id, { role: 'owner' }).status, 'needs_reconciliation');
  const unrepresentable = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  const gap = await prepare(unrepresentable, trade(unrepresentable, 4));
  assert.notEqual(gap.status, 201);
  assert.equal(unrepresentable.api.state.creates, 1);
  assert.equal(unrepresentable.api.state.payments, 0);
  assert.equal(unrepresentable.db.prepare("SELECT status FROM sales WHERE sale_type='trade' ORDER BY created_at DESC LIMIT 1").get().status, 'needs_reconciliation');
});

test('lost repricing response reconciles the same Woo order instead of creating a second one', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  h.api.state.loseReprice = true;
  const buyer = await h.addBuyer('Reconciled Buyer');
  const input = trade(h, 9200, buyer.id);
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
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  assert.equal((await h.request('/trade-buyers', { token: h.token })).data.buyers[0].name, 'Trade buyer');
  assert.equal((await h.request('/trade-buyers', { method: 'POST', token: h.token, body: { name: ' TRADE buyer ' } })).status, 409);
  assert.equal((await h.request('/trade-buyers', { method: 'POST', token: h.token, body: { name: 'Bad\nBuyer' } })).status, 400);
  assert.equal((await prepare(h, trade(h, 9200, randomUUID()))).status, 400);
  const cashier = (await h.request('/staff', { method: 'POST', token: h.token, body: { name: 'Trade Cashier', username: 'tradecash', role: 'cashier', password: 'cashier-secret-passphrase-123' } })).data.user;
  const cashierToken = (await h.request('/auth/login', { method: 'POST', body: { username: 'tradecash', password: 'cashier-secret-passphrase-123' } })).data.token;
  assert.equal((await h.request('/auth/password', { method: 'POST', token: cashierToken, body: { currentPassword: 'cashier-secret-passphrase-123', newPassword: 'cashier-rotated-secret-123' } })).status, 200);
  assert.equal((await h.request('/trade-buyers', { token: cashierToken })).status, 403);
  assert.equal((await h.request('/trade-buyers', { method: 'POST', token: cashierToken, body: { name: 'Forbidden buyer' } })).status, 403);
  assert.equal((await prepare(h, trade(h), cashierToken)).data.code, 'TRADE_ROLE_REQUIRED');
  assert.equal(h.api.state.creates, 0);
  const manager = (await h.request('/staff', { method: 'POST', token: h.token, body: { name: 'Trade Manager', username: 'trademgr', role: 'manager', password: 'manager-secret-passphrase-123' } })).data.user;
  const managerToken = (await h.request('/auth/login', { method: 'POST', body: { username: 'trademgr', password: 'manager-secret-passphrase-123' } })).data.token;
  assert.equal((await h.request('/auth/password', { method: 'POST', token: managerToken, body: { currentPassword: 'manager-secret-passphrase-123', newPassword: 'manager-rotated-secret-123' } })).status, 200);
  const buyer = await h.addBuyer('Studio buyer', managerToken);
  const prepared = await prepare(h, trade(h, 9200, buyer.id), managerToken);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const sale = prepared.data.sale;
  assert.equal(sale.buyerId, buyer.id);
  assert.equal(sale.buyerName, buyer.name);
  assert.equal(sale.tradeApprovedById, manager.id);
  assert.equal(sale.tradeApprovedByName, manager.name);
  assert.ok(sale.tradeApprovedAt);
  assert.equal(sale.agreedTotal, 9200);
  assert.equal(sale.items[0].cataloguePrice, 10000);
  const remote = h.api.state.orders[0];
  assert.equal(remote.billing.first_name, buyer.name);
  const meta = new Map(remote.meta_data.map(item => [item.key, item.value]));
  assert.equal(meta.get('_mansu_pos_trade_buyer_id'), buyer.id);
  assert.equal(meta.get('_mansu_pos_trade_approver'), manager.id);
  assert.equal(meta.get('_mansu_pos_trade_approver_name'), manager.name);
  assert.equal(meta.get('_mansu_pos_trade_approved_at'), sale.tradeApprovedAt);
  assert.equal(remote.lines[0].meta_data.find(item => item.key === 'Mansu agreed unit gross (GHS)').value, '92.00');
  assert.equal(remote.lines[0].meta_data.find(item => item.key === 'Mansu catalogue unit (GHS)').value, '100.00');
  assert.equal(h.db.prepare('SELECT actor FROM audit WHERE action=? AND subject=?').get('sale.trade_prepared', sale.id).actor, manager.id);
  assert.notEqual(cashier.id, sale.tradeApprovedById);
});

test('mixed tax classes, multiple individually negotiated goods and quantity preserve each final unit amount', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  const input = { ...trade(h, 9200), items: [
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
    body: { method: 'momo', reference: 'MERCHANT-TRADE-MIXED', confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.total, 25900);
  assert.equal(paid.data.sale.items[0].agreedUnitPrice, 9200);
  assert.equal(paid.data.sale.items[1].agreedUnitPrice, 7500);
  assert.equal(paid.data.sale.paymentReference, 'MERCHANT-TRADE-MIXED');
  assert.equal(h.db.prepare('SELECT prepared_total,trade_verified_json FROM sales WHERE id=?').get(paid.data.sale.id).prepared_total, 25900);
  const report = await h.request('/reports?days=1', { token: h.token });
  assert.equal(report.status, 200);
  assert.equal(report.data.total, 25900);
  assert.equal(report.data.sales.find(s => s.id === paid.data.sale.id).saleType, 'trade');
  assert.equal(report.data.sales.find(s => s.id === paid.data.sale.id).agreedTotal, 25900);
  assert.deepEqual(report.data.saleTypes, [{ type: 'retail', count: 0, total: 0 }, { type: 'trade', count: 1, total: 25900 }]);
  const exportResponse = await fetch(`${h.base}/api/reports/export?days=1`, { headers: { Authorization: `Bearer ${h.token}` } });
  assert.equal(exportResponse.status, 200);
  const csv = await exportResponse.text();
  assert.match(csv, /"Sale type","Trade buyer","Trade approved by","Agreed trade total GHS"/);
  assert.match(csv, /,"trade","Trade buyer","Store Owner","259\.00"/);
});

test('untaxed trade products do not gain tax, and conflicting agreed prices for one option fail before Woo creation', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' }, woo: { noTax: true } });
  const conflicting = trade(h);
  conflicting.items.push({ ...conflicting.items[0], agreedUnitPrice: 9300 });
  assert.equal((await prepare(h, conflicting)).status, 400);
  assert.equal(h.api.state.creates, 0);
  const exempt = await prepare(h, trade(h, 8500));
  assert.equal(exempt.status, 201, JSON.stringify(exempt.data));
  assert.equal(exempt.data.sale.tax, 0);
  assert.equal(exempt.data.sale.total, 8500);
  assert.equal(h.api.state.orders[0].lines[0].net, 8500);
  assert.equal(h.api.state.orders[0].lines[0].meta_data.find(item => item.key === 'Mansu agreed unit gross (GHS)').value, '85.00');
});

test('tax composition drift at the same gross total is blocked and fixed Woo data can be reconciled', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  const { sale } = (await prepare(h, trade(h))).data;
  const immutable = h.db.prepare('SELECT trade_verified_json FROM sales WHERE id=?').get(sale.id).trade_verified_json;
  h.api.state.exemptDress = true;
  h.api.state.orders[0].lines[0].net = 9200; // Gross remains GH₵92.00 but included tax was removed.
  const drift = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 9200, confirmed: true } });
  assert.equal(drift.status, 409);
  assert.equal(drift.data.code, 'TRADE_QUOTE_CHANGED');
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
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  const { sale } = (await prepare(h, trade(h))).data;
  h.api.state.losePayment = true;
  const first = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'card', reference: 'TERMINAL-TRADE-999', confirmed: true } });
  assert.equal(first.status, 502);
  assert.equal(first.data.code, 'RECONCILIATION_REQUIRED');
  assert.equal(h.api.state.payments, 1);
  assert.equal(h.sales.get(sale.id, { role: 'owner' }).status, 'needs_reconciliation');
  assert.equal((await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'card', reference: 'TERMINAL-TRADE-999', confirmed: true } })).status, 409);
  const checked = await h.request(`/sales/${sale.id}/reconcile`, { method: 'POST', token: h.token, body: {} });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.sale.status, 'paid');
  assert.equal(checked.data.sale.paymentReference, 'TERMINAL-TRADE-999');
  assert.equal(checked.data.sale.total, 9200);
  assert.equal(h.api.state.payments, 1);
});

test('Woo paid flag without a matching POS verification never releases a trade order', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  const { sale } = (await prepare(h, trade(h))).data;
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

test('concurrent trade submissions for one named buyer cannot create two pending Woo orders', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  const [a, b] = await Promise.all([prepare(h, trade(h)), prepare(h, trade(h))]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(h.api.state.creates, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM sales WHERE sale_type='trade'").get().count, 1);
});

test('closing the separate trade gate blocks payment of an already prepared trade order', async t => {
  const h = await harness(t, 'staging', { env: { POS_STAGING_TRADE_APPROVED: 'true' } });
  const { sale } = (await prepare(h, trade(h))).data;
  h.config.tradeWritesEnabled = false;
  const blocked = await h.request(`/sales/${sale.id}/pay`, { method: 'POST', token: h.token, body: { method: 'cash', tendered: 9200, confirmed: true } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'TRADE_CHECKOUT_LOCKED');
  assert.equal(h.api.state.payments, 0);
  assert.equal(h.sales.get(sale.id, { role: 'owner' }).status, 'awaiting_payment');
  assert.equal(readConfig({ POS_MODE: 'live', WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's', POS_ALLOW_LIVE_WRITES: 'true', POS_OWNER_APPROVAL_REFERENCE: 'written-owner-approval', POS_LIVE_TRADE_APPROVED: 'true' }).tradeWritesEnabled, false);
});

test('schema upgrade keeps previous paid retail receipts unchanged and introduces empty trade fields', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-trade-migration-'));
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
  assert.equal(sale.tradeApprovedById, null);
  assert.deepEqual(sale.items, [{ productId: 7331, variationId: 0, name: 'Demo fan', price: 19900, quantity: 1, total: 19900 }]);
});
