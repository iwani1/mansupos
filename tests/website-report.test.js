import test from 'node:test';
import assert from 'node:assert/strict';
import { WebsiteReport, summariseWebsiteOrders, isPosOrder } from '../server/website-report.js';

const today = new Date().toISOString().slice(0, 10);
const order = (over = {}) => ({ id: 1, status: 'completed', created_via: 'checkout', currency: 'GHS', total: '250.00', date_created_gmt: `${today}T09:00:00`, date_paid_gmt: `${today}T09:01:00`,
  payment_method: 'paystack', payment_method_title: 'Paystack', refunds: [], line_items: [{ product_id: 10, variation_id: 11, name: 'Pearl Shirt - M', quantity: 1, total: '250.00' }], meta_data: [], ...over });

test('POS orders are recognised by created_via or channel meta', () => {
  assert.equal(isPosOrder(order({ created_via: 'mansu-pos' })), true);
  assert.equal(isPosOrder(order({ created_via: 'rest-api', meta_data: [{ key: '_mansu_pos_channel', value: 'mansu-pos' }] })), true);
  assert.equal(isPosOrder(order()), false);
});

test('website summary excludes POS orders, nets refunds and groups by day, method and product', () => {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const result = summariseWebsiteOrders([
    order(),
    order({ id: 2, total: '100.00', refunds: [{ total: '-40.00' }], payment_method_title: 'Mobile Money', line_items: [{ product_id: 10, variation_id: 11, name: 'Pearl Shirt - M', quantity: 2, total: '100.00' }] }),
    order({ id: 3, created_via: 'mansu-pos', total: '999.00' }),
    order({ id: 4, status: 'pending', total: '500.00' }),
    order({ id: 5, currency: 'USD', total: '10.00' }),
  ], { since, days: 1 });
  assert.equal(result.orders, 2);
  assert.equal(result.gross, 35000);
  assert.equal(result.refunded, 4000);
  assert.equal(result.total, 31000);
  assert.equal(result.items, 3);
  assert.deepEqual(result.daily, [{ date: today, total: 31000, count: 2 }]);
  assert.deepEqual(result.methods.map(m => [m.name, m.total]), [['Paystack', 25000], ['Mobile Money', 6000]]);
  assert.deepEqual(result.topProducts[0], { name: 'Pearl Shirt - M', quantity: 3, total: 35000 });
});

test('the report reads only paid orders from WooCommerce, pages through them and caches briefly', async () => {
  const calls = [];
  const api = { request: async (resource, { query }) => { calls.push({ resource, query });
    const data = query.page === 1 ? Array.from({ length: 100 }, (_, i) => order({ id: i + 1 })) : [order({ id: 101 })];
    return { data, pages: 2 }; } };
  const report = new WebsiteReport(api, { mode: 'live', configured: true, liveReadOnly: false });
  const first = await report.report(7);
  assert.equal(first.orders, 101);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].resource, 'orders');
  assert.equal(calls[0].query.status, 'processing,completed,refunded');
  assert.equal(calls[0].query.dates_are_gmt, true);
  await report.report(7);
  assert.equal(calls.length, 2, 'Second load within a minute uses the cache');
});

test('demo and the read-only pilot have no website report', async () => {
  await assert.rejects(new WebsiteReport({}, { mode: 'demo' }).report(7), /demo has no website/);
  await assert.rejects(new WebsiteReport({}, { mode: 'live', configured: true, liveReadOnly: true }).report(7), err => err.code === 'WEBSITE_REPORT_UNAVAILABLE');
});
