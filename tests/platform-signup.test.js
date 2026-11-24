// Phase 2: sign-up, email confirmation, store connection, store check, go-live,
// and the private-network guard on every outbound store request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createPlatform } from '../server/platform/platform.js';
import { storeHealthCheck } from '../server/platform/setup.js';
import { isPublicAddress, guardedLookup, createGuardedFetch } from '../server/net-guard.js';

const BASE = 'mansupos.test';
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const KEY = `ck_${'a'.repeat(40)}`, SECRET = `cs_${'b'.repeat(40)}`;

function wooFixture(overrides = {}) {
  const state = { currency: 'GHS', manage: 'yes', hold: '60', taxes: 'no', products: [{ id: 1, sku: 'DRESS', type: 'simple', manage_stock: true }, { id: 2, sku: 'TOP', type: 'variable', manage_stock: false }], calls: [], ...overrides };
  const json = (data, headers = {}) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  state.fetch = async url => {
    const u = new URL(url);
    state.calls.push(u.pathname);
    if (u.pathname.endsWith('/settings/general')) return json([{ id: 'woocommerce_currency', value: state.currency }, { id: 'woocommerce_calc_taxes', value: state.taxes }]);
    if (u.pathname.endsWith('/settings/products')) return json([{ id: 'woocommerce_manage_stock', value: state.manage }, { id: 'woocommerce_hold_stock_minutes', value: state.hold }]);
    if (u.pathname.endsWith('/products')) return json(state.products, { 'x-wp-total': String(state.products.length), 'x-wp-totalpages': '1' });
    return new Response('{}', { status: 404 });
  };
  return state;
}

async function harness(t, { woo = wooFixture(), env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-signup-'));
  const sent = [];
  const mailer = { driver: 'memory', async send(message) { sent.push(message); }, list: () => sent };
  const platform = createPlatform({
    env: { NODE_ENV: 'test', PLATFORM_BASE_DOMAIN: BASE, PLATFORM_DATA_DIR: dir, PLATFORM_MASTER_KEY: randomBytes(32).toString('hex'), PLATFORM_SIGNUPS_PER_HOUR: '50', PLATFORM_SIGNUP_MODE: 'open', ...env },
    logger: quiet, mailer, setupFetch: (...args) => woo.fetch(...args),
    appFactory: ({ env, logger, extend }) => createApp({ env, logger, extend, api: { async products() { return { data: [], total: 0, pages: 1 }; }, async request() { return { data: [], total: 0, pages: 1 }; } } }),
  });
  const server = http.createServer(platform.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (host, url, { method = 'GET', body, token, origin } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { Host: host, 'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let parsed = text; try { parsed = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode, data: parsed, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  const site = (url, opts = {}) => call(BASE, url, { origin: `https://${BASE}`, ...opts });
  const form = (over = {}) => ({ shopName: 'Ama Boutique', slug: 'amaboutique', storeUrl: 'https://amaboutique.example.com', ownerName: 'Ama Owusu',
    email: 'Ama@Example.com', phone: '+233 20 000 0000', username: 'ama', password: 'chosen-passphrase-123', acceptTerms: true, ...over });
  const tokenFrom = message => /#token=([A-Za-z0-9_-]+)/.exec(message.text)[1];
  async function signedUpShop(over = {}) {
    const res = await site('/api/signup', { method: 'POST', body: form(over) });
    assert.equal(res.status, 202, JSON.stringify(res.data));
    const verified = await site('/api/signup/verify', { method: 'POST', body: { token: tokenFrom(sent.at(-1)) } });
    assert.equal(verified.status, 201, JSON.stringify(verified.data));
    const slug = over.slug || 'amaboutique', host = `${slug}.${BASE}`, origin = `https://${host}`;
    const login = await call(host, '/api/auth/login', { method: 'POST', origin, body: { username: over.username || 'ama', password: over.password || 'chosen-passphrase-123' } });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    return { host, origin, token: login.data.token, user: login.data.user, shop: platform.registry.bySlug(slug), verified };
  }
  async function connect(s) {
    const started = await call(s.host, '/api/setup/woo/connect', { method: 'POST', origin: s.origin, token: s.token, body: {} });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    const url = new URL(started.data.url);
    const nonce = url.searchParams.get('user_id');
    const cb = await call(s.host, '/api/setup/woo/callback', { method: 'POST', body: { key_id: 7, user_id: nonce, consumer_key: KEY, consumer_secret: SECRET, key_permissions: 'read_write' } });
    return { url, nonce, cb };
  }
  return { platform, call, site, form, sent, tokenFrom, signedUpShop, connect, woo, dir };
}

test('private, loopback, link-local and metadata addresses are never connected to', async () => {
  for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.20.1.1', '192.168.1.10', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '64:ff9b::a00:1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '41.215.160.1', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
  const lookup = answers => guardedLookup((_host, _opts, cb) => cb(null, answers));
  await new Promise(done => lookup([{ address: '93.184.216.34', family: 4 }])('ok.example', { all: true }, (err, list) => { assert.equal(err, null); assert.equal(list.length, 1); done(); }));
  await new Promise(done => lookup([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])('mixed.example', { all: true }, err => { assert.equal(err?.code, 'EPRIVATEADDR', 'one private answer blocks the host'); done(); }));
  // A real fetch whose name resolves to loopback is refused before any connection.
  const guarded = createGuardedFetch({ resolver: (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) });
  try {
    const error = await guarded('https://rebind.example.com/wp-json/wc/v3/products').then(() => null, e => e);
    assert.ok(error, 'request refused');
    assert.equal(error.cause?.code || error.code, 'EPRIVATEADDR');
    await assert.rejects(() => guarded('http://shop.example.com/'), /HTTPS/);
    await assert.rejects(() => guarded('https://127.0.0.1/'), /private or internal/);
    await assert.rejects(() => guarded('https://8.8.8.8/'), /domain name/);
  } finally { await guarded.close(); }
});

test('the store check explains private addresses and failing settings in plain words', async () => {
  const blocked = await storeHealthCheck({ storeUrl: 'https://s.example.com', keys: { woo_key: KEY, woo_secret: SECRET },
    fetchImpl: async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'EPRIVATEADDR' }; throw e; } });
  assert.equal(blocked.ok, false);
  assert.match(blocked.items[0].detail, /private network/);
  const woo = wooFixture({ currency: 'USD', manage: 'no', hold: '', taxes: 'yes', products: [{ id: 1, sku: '', type: 'simple', manage_stock: false }, { id: 2, sku: 'X', type: 'simple', manage_stock: true }, { id: 3, sku: 'x', type: 'simple', manage_stock: true }] });
  const result = await storeHealthCheck({ storeUrl: 'https://s.example.com', keys: { woo_key: KEY, woo_secret: SECRET }, fetchImpl: woo.fetch });
  const status = Object.fromEntries(result.items.map(i => [i.key, i.status]));
  assert.deepEqual(status, { connection: 'pass', currency: 'fail', stock: 'fail', hold: 'warn', tax: 'warn', products: 'pass', sku: 'warn', duplicates: 'warn', tracking: 'warn' });
  assert.equal(result.ok, false);
  const good = await storeHealthCheck({ storeUrl: 'https://s.example.com', keys: { woo_key: KEY, woo_secret: SECRET }, fetchImpl: wooFixture().fetch });
  assert.equal(good.ok, true);
});

test('sign-up, email confirmation and first sign-in create a shop the owner controls', async t => {
  const h = await harness(t);
  assert.equal((await h.call(BASE, '/')).status, 200);
  assert.match(String((await h.call(BASE, '/')).headers['content-security-policy']), /script-src 'self'/);
  assert.deepEqual((await h.site('/api/signup/check?slug=amaboutique')).data.available, true);
  assert.equal((await h.site('/api/signup/check?slug=admin')).data.available, false);
  const s = await h.signedUpShop();
  assert.equal(s.user.mustChangePassword, false, 'the owner chose their own password');
  assert.equal(s.user.role, 'owner');
  assert.equal(s.user.name, 'Ama Owusu');
  assert.equal(s.shop.stage, 'setup');
  assert.equal(s.shop.owner.email, 'ama@example.com');
  assert.ok(Math.abs(Date.parse(s.shop.trialEndsAt) - Date.now() - 14 * 86400000) < 60000, '14-day trial');
  assert.equal(s.verified.data.shopUrl, 'https://amaboutique.mansupos.test');
  assert.match(h.sent.at(-1).text, /amaboutique\.mansupos\.test/);
  // The chosen password is never stored in plain text.
  const raw = fs.readFileSync(path.join(h.dir, 'platform.db'));
  assert.equal(raw.includes(Buffer.from('chosen-passphrase-123')), false);
  assert.equal(JSON.stringify(h.platform.registry.list()).includes('chosen-passphrase'), false);
  // Clicking the link again just points to the shop; the slug is now taken.
  const again = await h.site('/api/signup/verify', { method: 'POST', body: { token: h.tokenFrom(h.sent.at(-2)) } });
  assert.equal(again.status, 200);
  assert.equal(again.data.already, true);
  assert.equal((await h.site('/api/signup/check?slug=amaboutique')).data.available, false);
  // A practice shop has no MansutRENDZGH tooling and reports its stage.
  const session = await h.call(s.host, '/api/session', { token: s.token });
  assert.equal(session.data.config.platformStage, 'setup');
  assert.equal(session.data.config.liveReadOnly, true);
});

test('sign-up refuses bad input, taken or reserved addresses, cross-site posts and bad links', async t => {
  const h = await harness(t);
  const post = (body, opts) => h.site('/api/signup', { method: 'POST', body, ...opts });
  for (const [over, pattern] of [[{ slug: 'admin' }, /reserved/], [{ storeUrl: 'http://shop.example.com' }, /https/], [{ storeUrl: 'https://192.168.1.4' }, /IP address/],
    [{ storeUrl: 'https://intranet.local' }, /public/], [{ password: 'short' }, /12 characters/], [{ password: 'ama-ama-ama-ama' }, /username/],
    [{ email: 'not-an-email' }, /email/], [{ acceptTerms: false }, /terms/]]) {
    const res = await post(h.form(over));
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.match(res.data.error, pattern, JSON.stringify(over));
  }
  assert.equal((await post({ ...h.form(), extra: 'field' })).status, 400, 'unknown fields refused');
  assert.equal((await post(h.form(), { origin: 'https://evil.example' })).status, 403);
  assert.equal(h.sent.length, 0, 'no email for refused sign-ups');
  await h.signedUpShop();
  assert.match((await post(h.form({ email: 'other@example.com' }))).data.error, /taken/);
  assert.equal((await h.site('/api/signup/verify', { method: 'POST', body: { token: 'x'.repeat(43) } })).status, 404);
  // An expired link is refused.
  await post(h.form({ slug: 'kofistyles', username: 'kofi' }));
  h.platform.registry.db.prepare('UPDATE signups SET expires_at=?').run(Date.now() - 1);
  assert.equal((await h.site('/api/signup/verify', { method: 'POST', body: { token: h.tokenFrom(h.sent.at(-1)) } })).status, 410);
  assert.equal(h.platform.registry.bySlug('kofistyles'), null);
});

test('the store connects through WooCommerce\'s own approval, once, and only for this shop', async t => {
  const h = await harness(t);
  const a = await h.signedUpShop();
  const b = await h.signedUpShop({ slug: 'kofistyles', username: 'kofi', email: 'kofi@example.com' });
  const { url, nonce, cb } = await h.connect(a);
  assert.equal(url.origin, 'https://amaboutique.example.com');
  assert.equal(url.pathname, '/wc-auth/v1/authorize');
  assert.equal(url.searchParams.get('scope'), 'read_write');
  assert.equal(url.searchParams.get('callback_url'), 'https://amaboutique.mansupos.test/api/setup/woo/callback');
  assert.equal(url.searchParams.get('return_url'), 'https://amaboutique.mansupos.test/?setup=connected');
  assert.equal(cb.status, 200, JSON.stringify(cb.data));
  const shop = h.platform.registry.bySlug('amaboutique');
  assert.equal(shop.stage, 'read_only', 'connected shops move to practice mode');
  assert.deepEqual(h.platform.registry.secretsFor(shop.id), { woo_key: KEY, woo_secret: SECRET });
  // Replay, wrong shop, wrong permission and junk are all refused.
  const replay = await h.call(a.host, '/api/setup/woo/callback', { method: 'POST', body: { user_id: nonce, consumer_key: KEY, consumer_secret: SECRET, key_permissions: 'read_write' } });
  assert.equal(replay.status, 400);
  const fresh = new URL((await h.call(a.host, '/api/setup/woo/connect', { method: 'POST', origin: a.origin, token: a.token, body: {} })).data.url).searchParams.get('user_id');
  assert.equal((await h.call(b.host, '/api/setup/woo/callback', { method: 'POST', body: { user_id: fresh, consumer_key: KEY, consumer_secret: SECRET, key_permissions: 'read_write' } })).status, 400, 'a code for shop A cannot connect shop B');
  assert.equal((await h.call(a.host, '/api/setup/woo/callback', { method: 'POST', body: { user_id: fresh, consumer_key: KEY, consumer_secret: SECRET, key_permissions: 'read' } })).status, 400);
  assert.equal(h.platform.registry.hasSecret(h.platform.registry.bySlug('kofistyles').id, 'woo_key'), false);
  assert.equal((await h.call(a.host, '/api/setup/woo/callback', { method: 'POST', body: 'not json' })).status, 400);
  // Only the owner can start a connection.
  await h.call(a.host, '/api/staff', { method: 'POST', origin: a.origin, token: a.token, body: { name: 'Cashier One', username: 'cash1', role: 'cashier', password: 'cashier-passphrase-123' } });
  const cashier = await h.call(a.host, '/api/auth/login', { method: 'POST', origin: a.origin, body: { username: 'cash1', password: 'cashier-passphrase-123' } });
  assert.equal(cashier.status, 200);
  const changed = await h.call(a.host, '/api/auth/password', { method: 'POST', origin: a.origin, token: cashier.data.token, body: { currentPassword: 'cashier-passphrase-123', newPassword: 'cashier-new-passphrase-456' } });
  assert.equal(changed.status, 200);
  assert.equal((await h.call(a.host, '/api/setup/woo/connect', { method: 'POST', origin: a.origin, token: cashier.data.token, body: {} })).status, 403);
  assert.equal((await h.call(a.host, '/api/setup', { token: cashier.data.token })).status, 403);
});

test('selling starts only after a passing store check and an explicit confirmation', async t => {
  const woo = wooFixture({ currency: 'USD' });
  const h = await harness(t, { woo });
  const s = await h.signedUpShop();
  const stage = body => h.call(s.host, '/api/setup/stage', { method: 'POST', origin: s.origin, token: s.token, body });
  assert.equal((await stage({ stage: 'read_only' })).status, 409, 'not connected yet');
  await h.connect(s);
  const failing = await h.call(s.host, '/api/setup/health', { method: 'POST', origin: s.origin, token: s.token, body: {} });
  assert.equal(failing.status, 200);
  assert.equal(failing.data.setup.health.ok, false);
  assert.equal((await stage({ stage: 'selling', confirm: true })).data.code, 'HEALTH_REQUIRED');
  woo.currency = 'GHS';
  const passing = await h.call(s.host, '/api/setup/health', { method: 'POST', origin: s.origin, token: s.token, body: {} });
  assert.equal(passing.data.setup.health.ok, true);
  assert.equal((await stage({ stage: 'selling' })).data.code, 'CONFIRM_REQUIRED');
  const business = await h.call(s.host, '/api/setup/business', { method: 'PUT', origin: s.origin, token: s.token, body: { address: 'Osu, Accra', phone: '020 000 0000', receiptWidth: '58' } });
  assert.equal(business.status, 200);
  assert.equal((await h.call(s.host, '/api/setup/business', { method: 'PUT', origin: s.origin, token: s.token, body: { receiptWidth: '99' } })).status, 400);
  const live = await stage({ stage: 'selling', confirm: true });
  assert.equal(live.status, 200, JSON.stringify(live.data));
  const session = await h.call(s.host, '/api/session', { token: s.token });
  assert.equal(session.data.config.platformStage, 'selling');
  assert.equal(session.data.config.writesEnabled, true);
  assert.equal(session.data.config.businessAddress, 'Osu, Accra');
  assert.equal(session.data.config.receiptWidth, '58');
  // A stale check no longer counts.
  h.platform.registry.db.prepare('UPDATE shops SET health_at=? WHERE id=?').run(new Date(Date.now() - 25 * 3600000).toISOString(), s.shop.id);
  await stage({ stage: 'read_only' });
  assert.equal((await stage({ stage: 'selling', confirm: true })).data.code, 'HEALTH_REQUIRED');
});

test('sign-ups are rate limited per connection', async t => {
  const h = await harness(t, { env: { PLATFORM_SIGNUPS_PER_HOUR: '2' } });
  const post = slug => h.site('/api/signup', { method: 'POST', body: h.form({ slug, username: slug.slice(0, 10) }) });
  assert.equal((await post('shop-one')).status, 202);
  assert.equal((await post('shop-two')).status, 202);
  const third = await post('shop-three');
  assert.equal(third.status, 429);
  assert.equal(h.sent.length, 2);
});
