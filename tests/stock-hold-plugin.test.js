import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import PhpParser from 'php-parser';
import { WooCommerce } from '../server/woocommerce.js';

const source = fs.readFileSync(new URL('../woocommerce/mansu-pos-stock-hold/mansu-pos-stock-hold.php', import.meta.url), 'utf8');

test('stock hold plugin parses and uses WooCommerce\'s own reservation helper', () => {
  new PhpParser.Engine({ parser: { php7: true, extractDoc: true }, ast: { withPositions: false } }).parseCode(source, 'mansu-pos-stock-hold.php');
  assert.match(source, /register_rest_route\(\s*'wc-mansu-pos\/v1'/, 'A wc- namespace lets WooCommerce authenticate the POS REST key');
  assert.match(source, /new \\Automattic\\WooCommerce\\Checkout\\Helpers\\ReserveStock\(\)/);
  assert.match(source, /reserve_stock_for_order\( \$order, \(int\) \$request\['minutes'\] \)/);
  assert.match(source, /'mansu-pos' !== \$order->get_meta\( '_mansu_pos_channel' \)/, 'Only till orders can be held');
  assert.match(source, /'pending' !== \$order->get_status\(\)/);
  assert.match(source, /current_user_can\( 'edit_shop_orders' \)/);
  assert.match(source, /'maximum' => 1440/);
  assert.doesNotMatch(source, /'_stock'|update_post_meta|wc_update_product_stock|set_stock_quantity/, 'The plugin never changes a stock quantity');
});

test('the POS calls the plugin route with its WooCommerce key and reads a refusal', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/status')) return new Response(JSON.stringify({ ok: true, version: '1.0.0', woocommerce: '11.3.1' }), { status: 200 });
    return new Response(JSON.stringify({ code: 'mansu_stock_unavailable', message: 'Not enough units of <b>Dress</b> are available.' }), { status: 409 });
  };
  const woo = new WooCommerce({ configured: true, writesEnabled: true, storeUrl: 'https://www.mansutrendzgh.com', consumerKey: 'ck_x', consumerSecret: 'cs_y' }, fetchImpl);
  assert.equal((await woo.stockHoldStatus()).ok, true);
  await assert.rejects(woo.stockHold(901, 135), error => error.wooCode === 'mansu_stock_unavailable' && error.wooMessage === 'Not enough units of Dress are available.');
  assert.equal(calls[1].url, 'https://www.mansutrendzgh.com/wp-json/wc-mansu-pos/v1/stock-hold');
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), { order_id: 901, minutes: 135 });
  assert.equal(calls[1].init.headers.Authorization, `Basic ${Buffer.from('ck_x:cs_y').toString('base64')}`);
});

test('a locked POS never sends the hold write', async () => {
  const woo = new WooCommerce({ configured: true, writesEnabled: false, storeUrl: 'https://www.mansutrendzgh.com', consumerKey: 'k', consumerSecret: 's' }, async () => { throw new Error('must not fetch'); });
  await assert.rejects(woo.stockHold(1, 60), /locked/);
});
