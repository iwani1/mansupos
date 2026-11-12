import test from 'node:test';
import assert from 'node:assert/strict';
import { WooCommerce } from '../server/woocommerce.js';

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
