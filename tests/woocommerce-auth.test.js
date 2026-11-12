import test from 'node:test';
import assert from 'node:assert/strict';
import { WooCommerce } from '../server/woocommerce.js';

test('POS-created REST orders retain their own origin, not customer-checkout hold semantics', async () => {
  let sent;
  const woo = new WooCommerce({ configured: true, storeUrl: 'https://staging.example.com',
    consumerKey: 'ck_fixture', consumerSecret: 'cs_fixture', liveReadOnly: false, writesEnabled: true },
  async (url, init) => {
    sent = { url: url.href, method: init.method, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: 501, status: 'pending', created_via: sent.body.created_via }), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    });
  });
  const created = await woo.createOrder({ status: 'pending', line_items: [{ product_id: 10, quantity: 1 }], created_via: 'checkout' });
  assert.equal(sent.method, 'POST');
  assert.match(sent.url, /\/wp-json\/wc\/v3\/orders$/);
  assert.equal(sent.body.created_via, 'mansu-pos', 'A future caller cannot falsely claim Woo checkout reservation and expiry.');
  assert.equal(created.created_via, 'mansu-pos');
});

test('upstream Woo credential denial never masquerades as expired POS staff session', async () => {
  for (const status of [401, 403]) {
    let attempts = 0;
    const woo = new WooCommerce({ configured: true, storeUrl: 'https://www.mansutrendzgh.com',
      consumerKey: 'ck_fixture', consumerSecret: 'cs_fixture', liveReadOnly: true, writesEnabled: false }, async () => {
      attempts++;
      return new Response(JSON.stringify({ code: 'woocommerce_rest_cannot_view' }), {
        status, headers: { 'Content-Type': 'application/json' },
      });
    });
    await assert.rejects(woo.products(), { status: 502, code: 'WOOCOMMERCE_ERROR',
      message: 'WooCommerce denied access. Check the API key permissions and server configuration.' });
    assert.equal(attempts, 1, 'Invalid credentials should not generate automatic repeat requests.');
  }
});
