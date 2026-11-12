import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { WooCommerce, fetchLiveCatalog } from '../server/woocommerce.js';

const pilotEnvironment = {
  NODE_ENV: 'production', POS_MODE: 'live', POS_LIVE_READ_ONLY: 'true',
  WOO_BASE_URL: 'https://mansutrendzgh.com', WOO_CONSUMER_KEY: 'ck_test', WOO_CONSUMER_SECRET: 'cs_test',
  POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com', POS_ALLOW_LIVE_WRITES: 'false',
};

test('live catalogue pilot cannot be mistaken for staging or unlocked through a copied approval', () => {
  const pilot = readConfig(pilotEnvironment);
  assert.equal(pilot.mode, 'live');
  assert.equal(pilot.liveReadOnly, true);
  assert.equal(pilot.writesEnabled, false);
  assert.equal(pilot.wholesaleWritesEnabled, false);
  assert.throws(() => readConfig({ ...pilotEnvironment, POS_ALLOW_LIVE_WRITES: 'true', POS_OWNER_APPROVAL_REFERENCE: 'written-owner-approval' }), /read-only live pilot/);
  assert.throws(() => readConfig({ ...pilotEnvironment, POS_MODE: 'staging', WOO_BASE_URL: 'https://staging.example.com' }), /POS_LIVE_READ_ONLY/);
  assert.throws(() => readConfig({ ...pilotEnvironment, POS_LIVE_READ_ONLY: 'maybe' }), /POS_LIVE_READ_ONLY/);
  assert.throws(() => readConfig({ ...pilotEnvironment, WOO_BASE_URL: 'http://mansutrendzgh.com' }), /HTTPS origin/);
  assert.throws(() => readConfig({ ...pilotEnvironment, WOO_BASE_URL: 'https://mansutrendzgh.com/stagings/' }), /HTTPS origin/);
  assert.equal(readConfig({ ...pilotEnvironment, POS_LIVE_READ_ONLY: 'false', POS_ALLOW_LIVE_WRITES: 'true', POS_OWNER_APPROVAL_REFERENCE: 'written-owner-approval' }).writesEnabled, true,
    'The future live write route still requires explicit owner approval; do not use the pilot unit for it.');
});

test('preflight accepts a locked live catalogue pilot but requires an owner and configured Woo credentials', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-pilot-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...pilotEnvironment, NODE_ENV: 'test', POS_DATA_DIR: dir,
    POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'pilot-secret-passphrase-123' };
  const run = overrides => spawnSync(process.execPath, ['server/preflight.js'], {
    cwd: path.resolve('.'), env: { ...env, ...overrides }, encoding: 'utf8',
  });
  const good = run();
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /PASS {2}Live catalogue pilot — live WooCommerce reads only; retail and wholesale checkout locked/);
  assert.match(good.stdout, /PASS {2}Live approval — writes locked/);
  assert.equal(fs.existsSync(path.join(dir, 'pos-live.db')), false, 'Preflight must not create a live ledger');
  const missingKey = run({ WOO_CONSUMER_KEY: '' });
  assert.notEqual(missingKey.status, 0);
  assert.match(missingKey.stdout, /FAIL {2}WooCommerce credentials/);
  const missingOwner = run({ POS_OWNER_PASSWORD: '' });
  assert.notEqual(missingOwner.status, 0);
  assert.match(missingOwner.stdout, /FAIL {2}Owner sign-in available/);
});

test('native pilot units override unsafe env flags and cannot bind an existing app port', () => {
  const service = fs.readFileSync('deploy/mansu-pos-live-pilot.service', 'utf8');
  const startLines = service.split('\n').filter(line => /^ExecStart(Pre)?=/.test(line));
  assert.equal(startLines.length, 2);
  assert.match(service, /^User=mansu-pos-pilot$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/mansu-pos-live-pilot\/pos\.env$/m);
  const unsafeEnv = {
    ...pilotEnvironment, POS_MODE: 'staging', POS_LIVE_READ_ONLY: 'false', POS_ALLOW_LIVE_WRITES: 'true',
    POS_STAGING_APPROVED: 'true', POS_STAGING_WHOLESALE_APPROVED: 'true', POS_LIVE_WHOLESALE_APPROVED: 'true',
    POS_OWNER_APPROVAL_REFERENCE: 'written-owner-approval', POS_BIND_HOST: '0.0.0.0', PORT: '3000',
    POS_DATA_DIR: '/var/lib/other-app', POS_TRUST_PROXY: '1', POS_REQUIRE_SHIFT: 'true',
    POS_PUBLIC_ORIGIN: 'https://mansutrendzgh.com',
  };
  for (const line of startLines) {
    assert.match(line, /\/usr\/bin\/env .* \/usr\/bin\/node server\/(preflight|index)\.js$/);
    const assignments = line.slice(line.indexOf('/usr/bin/env ') + 13, line.indexOf(' /usr/bin/node'));
    const effective = { ...unsafeEnv };
    for (const part of assignments.split(' ')) {
      const equals = part.indexOf('=');
      assert.notEqual(equals, -1);
      effective[part.slice(0, equals)] = part.slice(equals + 1);
    }
    const config = readConfig(effective);
    assert.equal(config.mode, 'live');
    assert.equal(config.liveReadOnly, true);
    assert.equal(config.writesEnabled, false);
    assert.equal(config.wholesaleWritesEnabled, false);
    assert.equal(config.bindHost, '127.0.0.1');
    assert.equal(config.port, 3187);
    assert.equal(config.dataDir, '/var/lib/mansu-pos-live-pilot');
    assert.equal(config.publicOrigin, 'https://pos.mansutrendzgh.com');
    assert.equal(config.trustProxy, 'loopback');
    assert.equal(config.requireShift, false);
  }
  const backup = fs.readFileSync('deploy/mansu-pos-live-pilot-backup.service', 'utf8');
  assert.match(backup, /^User=mansu-pos-pilot$/m);
  assert.match(backup, /^ExecStart=.*POS_MODE=live POS_LIVE_READ_ONLY=true POS_ALLOW_LIVE_WRITES=false POS_PUBLIC_ORIGIN=https:\/\/pos\.mansutrendzgh\.com POS_DATA_DIR=\/var\/lib\/mansu-pos-live-pilot .*server\/backup\.js \/var\/lib\/mansu-pos-live-pilot\/backups$/m);
});

test('WooCommerce adapter never sends remote writes when the pilot or any write gate is locked', async () => {
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url: String(url), method: options.method });
    return new Response(JSON.stringify([{ id: 7, name: 'Product' }]), {
      headers: { 'Content-Type': 'application/json', 'x-wp-total': '1' },
    });
  };
  const woo = new WooCommerce(readConfig(pilotEnvironment), fakeFetch);
  const catalogue = await woo.products();
  assert.equal(catalogue.total, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.match(requests[0].url, /^https:\/\/mansutrendzgh\.com\/wp-json\/wc\/v3\/products\?/);
  await woo.variations(7);
  assert.match(requests[1].url, /\/products\/7\/variations\?/);
  for (const request of [
    () => woo.request('orders'),
    () => woo.order(1),
    () => woo.once(new URL('https://other.example/wp-json/wc/v3/products'), { method: 'GET' }),
    () => woo.createOrder({ status: 'pending' }),
    () => woo.updateOrder(1, { set_paid: true }),
    () => woo.request('products/7', { method: 'DELETE' }),
    () => woo.once(new URL('https://mansutrendzgh.com/wp-json/wc/v3/orders'), { method: 'POST', body: {} }),
  ]) await assert.rejects(request(), { status: 403 });
  assert.equal(requests.length, 2, 'Only live product and variation reads were sent');
  const staging = new WooCommerce(readConfig({ POS_MODE: 'staging', WOO_BASE_URL: 'https://staging.example.com', WOO_CONSUMER_KEY: 'ck', WOO_CONSUMER_SECRET: 'cs', POS_STAGING_APPROVED: 'true' }), fakeFetch);
  await staging.createOrder({ status: 'pending' });
  assert.equal(requests.at(-1).method, 'POST', 'Approved staging writes remain available for isolated acceptance tests');
});

test('standard WooCommerce pagination reads every product and variation page without writes', async () => {
  const calls = [];
  const product = id => ({
    id, name: `Product ${id}`, type: 'simple', status: 'publish', sku: `SKU-${id}`,
    price: '10.00', manage_stock: true, stock_quantity: 5, stock_status: 'instock',
    purchasable: true, images: [], categories: [],
  });
  const variation = id => ({
    id, price: '10.00', manage_stock: 'parent', stock_status: 'instock', purchasable: true,
    attributes: [{ name: 'Size', option: String(id) }],
  });
  const firstPage = Array.from({ length: 100 }, (_, i) => product(i + 1));
  firstPage[0].type = 'variable';
  const secondPage = Array.from({ length: 15 }, (_, i) => product(i + 101));
  const api = new WooCommerce(readConfig(pilotEnvironment), async (input, options) => {
    assert.equal(options.method, 'GET');
    const url = new URL(input);
    const page = Number(url.searchParams.get('page'));
    const products = url.pathname === '/wp-json/wc/v3/products';
    const variations = url.pathname === '/wp-json/wc/v3/products/1/variations';
    assert.ok(products || variations, `Unexpected Woo request: ${url.pathname}`);
    assert.equal(url.searchParams.get('per_page'), '100');
    calls.push(`${products ? 'products' : 'variations'}:${page}`);
    const data = products ? page === 1 ? firstPage : secondPage
      : page === 1 ? Array.from({ length: 100 }, (_, i) => variation(i + 1)) : [variation(101)];
    return new Response(JSON.stringify(data), { headers: {
      'Content-Type': 'application/json', 'X-WP-Total': products ? '115' : '101', 'X-WP-TotalPages': '2',
    } });
  });
  const catalogue = await fetchLiveCatalog(api);
  assert.equal(catalogue.products.length, 115, 'The second product page must not be silently omitted');
  assert.equal(catalogue.products[0].variations.length, 101, 'The second variation page must not be silently omitted');
  assert.equal(catalogue.complete, true);
  assert.deepEqual(calls, ['products:1', 'variations:1', 'variations:2', 'products:2']);
});

test('WooCommerce infers a second product page when a proxy strips X-WP-TotalPages', async () => {
  const api = new WooCommerce(readConfig(pilotEnvironment), async () => new Response('[]', {
    headers: { 'Content-Type': 'application/json', 'X-WP-Total': '115' },
  }));
  assert.equal((await api.products(1)).pages, 2);
});

test('pilot API can read the catalogue but cannot prepare retail/wholesale orders or log cash', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-live-pilot-'));
  const calls = [];
  const product = {
    id: 73, name: 'Read-only item', type: 'simple', status: 'publish', sku: 'READ-73',
    price: '12.34', manage_stock: true, stock_quantity: 3, stock_status: 'instock',
    purchasable: true, images: [], categories: [],
  };
  const api = {
    async products() { calls.push('products'); return { data: [product], total: 1, pages: 1 }; },
    async request(resource) { calls.push(resource); if (resource === 'products') return { data: [product], total: 1, pages: 1 }; throw new Error('Orders must not be read in a catalogue pilot'); },
    async createOrder() { calls.push('create'); throw new Error('A remote order write was attempted'); },
    async updateOrder() { calls.push('update'); throw new Error('A remote order write was attempted'); },
  };
  const { app, db } = createApp({ env: {
    ...pilotEnvironment, NODE_ENV: 'test', POS_DATA_DIR: dir, POS_OWNER_USERNAME: 'owner',
    POS_OWNER_PASSWORD: 'pilot-secret-passphrase-123', POS_REQUIRE_SHIFT: 'false',
  }, api, logger: { info() {}, warn() {}, error() {} } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, { method = 'GET', token, body } = {}) => {
    const response = await fetch(base + path, { method, headers: {
      'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  assert.deepEqual((await request('/health')).data.liveReadOnly, true);
  assert.equal((await request('/ready')).status, 200, 'Read-only pilot is ready without a live write gate');
  const login = await request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'pilot-secret-passphrase-123' } });
  assert.equal(login.status, 200);
  const token = login.data.token;
  assert.equal((await request('/auth/password', { method: 'POST', token, body: { currentPassword: 'pilot-secret-passphrase-123', newPassword: 'pilot-rotated-passphrase-123' } })).status, 200);
  const session = await request('/session', { token });
  assert.equal(session.data.config.liveReadOnly, true);
  assert.equal(session.data.config.writesEnabled, false);
  assert.equal(session.data.config.wholesaleWritesEnabled, false);
  const catalogue = await request('/catalog', { token });
  assert.equal(catalogue.status, 200);
  assert.equal(catalogue.data.products[0].name, 'Read-only item');
  assert.equal((await request('/connection/test', { method: 'POST', token, body: {} })).status, 200);
  const diagnostics = await request('/connection/diagnostics', { token });
  assert.equal(diagnostics.status, 200);
  assert.equal(diagnostics.data.ok, true);
  assert.equal(diagnostics.data.checks.some(check => check.name === 'WooCommerce orders read'), false);
  const retail = await request('/sales/prepare', { method: 'POST', token, body: { idempotencyKey: randomUUID(), items: [{ productId: 73, quantity: 1 }] } });
  assert.equal(retail.status, 403);
  assert.equal(retail.data.code, 'CHECKOUT_LOCKED');
  const wholesale = await request('/sales/prepare', { method: 'POST', token, body: {
    idempotencyKey: randomUUID(), saleType: 'wholesale', wholesaleApproved: true,
    items: [{ productId: 73, quantity: 1, agreedUnitPrice: 1234 }],
  } });
  assert.equal(wholesale.status, 403);
  assert.equal((await request('/wholesale-buyers', { method: 'POST', token, body: { name: 'Test buyer' } })).status, 403);
  assert.equal((await request('/shifts/open', { method: 'POST', token, body: { openingFloat: 10000 } })).status, 403);
  assert.equal((await request('/shifts/demo/close', { method: 'POST', token, body: { closingCash: 10000 } })).status, 403);
  assert.equal((await request('/shifts/demo/cash', { method: 'POST', token, body: { type: 'in', amount: 100, reason: 'Test' } })).status, 403);
  assert.equal(calls.includes('orders'), false);
  assert.equal(calls.includes('create'), false);
  assert.equal(calls.includes('update'), false);
  assert.equal((await request('/sales', { token })).data.sales.length, 0);
});
