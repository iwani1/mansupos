// Phase 1 gate: two shops on one platform never see each other's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { RemoteError } from '../server/errors.js';
import { createPlatform } from '../server/platform/platform.js';
import { slugFromHost, slugProblem } from '../server/platform/slug.js';
import { normaliseStoreUrl } from '../server/platform/store-url.js';
import { sealSecret, openSecret } from '../server/platform/secrets.js';

const BASE = 'mansupos.test';
const quiet = { debug() {}, info() {}, warn() {}, error(f) { if (process.env.SHOW_PLATFORM_ERRORS) console.error('PLATFORM', JSON.stringify(f)); }, child() { return this; } };
const NEW_PASSWORD = 'rotated-secret-passphrase-123';

function fakeApi() {
  const state = { orders: [], creates: 0 };
  const product = { id: 10, name: 'Test Dress', type: 'variable', sku: 'DRESS', price: '100.00', images: [], categories: [{ name: 'Dresses' }], status: 'publish', purchasable: true, manage_stock: false, stock_status: 'instock', backorders: 'no', permalink: 'https://shop.example.com/p' };
  const variation = { id: 11, sku: 'DRESS-M', price: '100.00', attributes: [{ name: 'Size', option: 'M' }], manage_stock: true, stock_quantity: 10, stock_status: 'instock', backorders: 'no', purchasable: true };
  const view = o => ({ ...o, line_items: o.line_items.map(i => ({ ...i, name: 'Test Dress', sku: 'DRESS-M', price: 100, subtotal: '100.00', total: '100.00', total_tax: '0.00', meta_data: [] })), refunds: [] });
  return {
    state,
    async request(resource) { if (resource === 'products') return { data: [product], total: 1, pages: 1 }; if (resource === 'orders') return { data: [], total: 0, pages: 1 }; throw new RemoteError('unexpected', 500, false); },
    async products() { return { data: [product], total: 1, pages: 1 }; },
    async variations() { return { data: [variation], total: 1, pages: 1 }; },
    async product() { return product; },
    async variation() { return variation; },
    async createOrder(body) { state.creates++; const o = { ...body, id: 500 + state.creates, number: String(500 + state.creates), currency: 'GHS', total: '100.00', total_tax: '0.00', date_paid: null, status: body.status || 'pending' }; state.orders.push(o); return view(o); },
    async updateOrder(id, body) { const o = state.orders.find(x => x.id === id); const { meta_data, ...rest } = body; Object.assign(o, rest); if (meta_data) o.meta_data = [...(o.meta_data || []), ...meta_data]; if (body.set_paid) { const paid = new Date().toISOString().replace('Z', ''); o.date_paid = paid; o.date_paid_gmt = paid; } return view(o); },
    async order(id) { return view(state.orders.find(o => o.id === id)); },
    async findOrderByKey(key) { const o = state.orders.find(x => (x.meta_data || []).some(m => m.key === '_mansu_pos_key' && m.value === key)); return o ? view(o) : null; },
    async listOrders() { return { data: [], total: 0, pages: 1 }; },
  };
}

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-platform-'));
  const apis = new Map();
  const opened = [];
  const platform = createPlatform({
    env: { NODE_ENV: 'test', PLATFORM_BASE_DOMAIN: BASE, PLATFORM_DATA_DIR: dir, PLATFORM_MASTER_KEY: randomBytes(32).toString('hex') },
    logger: quiet,
    appFactory: ({ env, logger }) => {
      opened.push(env.POS_TENANT_ID);
      if (!apis.has(env.POS_TENANT_ID)) apis.set(env.POS_TENANT_ID, fakeApi());
      return createApp({ env, logger, api: apis.get(env.POS_TENANT_ID) });
    },
  });
  const server = http.createServer(platform.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const call = (host, url, { method = 'GET', body, token, origin } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: {
      Host: host, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let parsed = text; try { parsed = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode, data: parsed, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

  // A shop ready to sell: created, keys connected, stage selling, owner signed in with a changed password.
  async function sellingShop(slug, owner) {
    const made = platform.provisionShop({ slug, name: `${slug} boutique`, storeUrl: `https://${slug}-store.example.com`, ownerUsername: owner, actor: 'test' });
    platform.registry.setSecret(made.shop.id, 'woo_key', `ck_${slug.padEnd(40, '0').slice(0, 40).replace(/[^0-9a-f]/g, 'a')}`, 'test');
    platform.registry.setSecret(made.shop.id, 'woo_secret', `cs_${'b'.repeat(40)}`, 'test');
    platform.registry.update(made.shop.id, { stage: 'selling' }, 'test');
    const host = `${slug}.${BASE}`, origin = `https://${host}`;
    const login = await call(host, '/api/auth/login', { method: 'POST', origin, body: { username: owner, password: made.ownerPassword } });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    const changed = await call(host, '/api/auth/password', { method: 'POST', origin, token: login.data.token, body: { currentPassword: made.ownerPassword, newPassword: NEW_PASSWORD } });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    return { ...made, host, origin, token: login.data.token, api: () => apis.get(made.shop.id) };
  }
  return { platform, call, sellingShop, apis, opened, dir };
}

test('sales, staff, shifts and WooCommerce orders stay inside their own shop', async t => {
  const h = await harness(t);
  const a = await h.sellingShop('amaboutique', 'ama');
  const b = await h.sellingShop('kofistyles', 'kofi');
  assert.notEqual(a.shop.id, b.shop.id);

  const staff = await h.call(a.host, '/api/staff', { method: 'POST', origin: a.origin, token: a.token, body: { name: 'Akosua Mensah', username: 'akosua', role: 'cashier', password: 'cashier-passphrase-123' } });
  assert.equal(staff.status, 201, JSON.stringify(staff.data));
  const shift = await h.call(a.host, '/api/shifts/open', { method: 'POST', origin: a.origin, token: a.token, body: { openingFloat: 0 } });
  assert.equal(shift.status, 201, JSON.stringify(shift.data));
  const prepared = await h.call(a.host, '/api/sales/prepare', { method: 'POST', origin: a.origin, token: a.token, body: { idempotencyKey: randomUUID(), items: [{ productId: 10, variationId: 11, quantity: 1 }] } });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  const paid = await h.call(a.host, `/api/sales/${prepared.data.sale.id}/pay`, { method: 'POST', origin: a.origin, token: a.token, body: { method: 'cash', tendered: 10000, confirmed: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));

  // Shop A sees its own records.
  assert.equal((await h.call(a.host, '/api/sales', { token: a.token })).data.sales.length, 1);
  assert.ok((await h.call(a.host, '/api/staff', { token: a.token })).data.staff.some(u => u.username === 'akosua'));
  // Shop B sees none of them, and the order went only to shop A's store.
  assert.equal((await h.call(b.host, '/api/sales', { token: b.token })).data.sales.length, 0);
  const bStaff = (await h.call(b.host, '/api/staff', { token: b.token })).data.staff.map(u => u.username);
  assert.deepEqual(bStaff, ['kofi']);
  assert.equal((await h.call(b.host, '/api/shifts/current', { token: b.token })).data.shift, null);
  assert.equal(a.api().state.orders.length, 1);
  assert.equal(b.api().state.orders.length, 0);
  // A sale id from shop A does not exist in shop B.
  assert.equal((await h.call(b.host, `/api/sales/${prepared.data.sale.id}/reconcile`, { method: 'POST', origin: b.origin, token: b.token, body: {} })).status, 404);

  // Separate database files in separate folders named by shop id.
  const dirs = fs.readdirSync(path.join(h.dir, 'shops')).sort();
  assert.deepEqual(dirs, [a.shop.id, b.shop.id].sort());
  const salesIn = id => { const db = new DatabaseSync(path.join(h.dir, 'shops', id, 'pos-live.db'), { readOnly: true }); try { return db.prepare('SELECT COUNT(*) AS n FROM sales').get().n; } finally { db.close(); } };
  h.platform.evictIdle(0);
  assert.equal(salesIn(a.shop.id), 1);
  assert.equal(salesIn(b.shop.id), 0);
});

test('a session, cookie or password from one shop is useless at another', async t => {
  const h = await harness(t);
  const a = await h.sellingShop('amaboutique', 'ama');
  const b = await h.sellingShop('kofistyles', 'kofi');
  assert.equal((await h.call(b.host, '/api/session', { token: a.token })).data.user, null);
  assert.equal((await h.call(b.host, '/api/sales', { token: a.token })).status, 401);
  assert.equal((await h.call(b.host, '/api/staff', { token: a.token })).status, 401);
  // Same username and password typed at the other shop: no such account there.
  const wrongShop = await h.call(b.host, '/api/auth/login', { method: 'POST', origin: b.origin, body: { username: 'ama', password: NEW_PASSWORD } });
  assert.equal(wrongShop.status, 401);
  // Cookies are host-only (no Domain attribute), so a browser never sends shop A's cookie to shop B.
  const login = await h.call(a.host, '/api/auth/login', { method: 'POST', origin: a.origin, body: { username: 'ama', password: NEW_PASSWORD } });
  const cookie = String(login.headers['set-cookie'] || '');
  assert.match(cookie, /mansu_session=/);
  assert.doesNotMatch(cookie, /domain=/i);
});

test('a write carrying another shop\'s Origin is refused', async t => {
  const h = await harness(t);
  const a = await h.sellingShop('amaboutique', 'ama');
  const b = await h.sellingShop('kofistyles', 'kofi');
  const forged = await h.call(a.host, '/api/shifts/open', { method: 'POST', origin: b.origin, token: a.token, body: { openingFloat: 0 } });
  assert.equal(forged.status, 403);
  assert.equal((await h.call(a.host, '/api/shifts/current', { token: a.token })).data.shift, null);
});

test('unknown, reserved, malformed and foreign hosts open no shop', async t => {
  const h = await harness(t);
  await h.sellingShop('amaboutique', 'ama');
  h.platform.evictIdle(0);
  const before = h.opened.length;
  for (const host of [`nosuchshop.${BASE}`, `admin.${BASE}`, `www.amaboutique.${BASE}`, `amaboutique.${BASE}.evil.example`,
    `AMA_BOUTIQUE.${BASE}`, 'amaboutique', '', `..${BASE}`, `amaboutique.other.test`, `-x.${BASE}`]) {
    const res = await h.call(host, '/api/session');
    assert.equal(res.status, 404, host);
  }
  assert.equal(h.opened.length, before, 'no shop app was opened for a bad host');
  assert.equal(h.platform.openShops().length, 0);
  const home = await h.call(BASE, '/api/health');
  assert.deepEqual(home.data, { ok: true, platform: true });
  // Mixed-case and a trailing dot or port still reach the right shop.
  assert.equal((await h.call(`AmaBoutique.${BASE.toUpperCase()}:443`, '/api/health')).status, 200);
});

test('suspended and closed shops do not serve; resuming restores the same data', async t => {
  const h = await harness(t);
  const a = await h.sellingShop('amaboutique', 'ama');
  h.platform.registry.update(a.shop.id, { status: 'suspended' }, 'test');
  assert.equal((await h.call(a.host, '/api/session', { token: a.token })).status, 503);
  h.platform.evictIdle(60_000);
  assert.equal(h.platform.openShops().length, 0, 'a suspended shop is closed by the sweep');
  h.platform.registry.update(a.shop.id, { status: 'active' }, 'test');
  assert.equal((await h.call(a.host, '/api/session', { token: a.token })).data.user.username, 'ama');
  h.platform.registry.update(a.shop.id, { status: 'closed' }, 'test');
  assert.equal((await h.call(a.host, '/api/session', { token: a.token })).status, 404);
});

test('shop keys are encrypted at rest and bound to their shop', async t => {
  const h = await harness(t);
  const a = await h.sellingShop('amaboutique', 'ama');
  const b = await h.sellingShop('kofistyles', 'kofi');
  const secret = `cs_${'b'.repeat(40)}`;
  h.platform.evictIdle(0);
  const raw = fs.readFileSync(path.join(h.dir, 'platform.db'));
  const wal = fs.existsSync(path.join(h.dir, 'platform.db-wal')) ? fs.readFileSync(path.join(h.dir, 'platform.db-wal')) : Buffer.alloc(0);
  assert.equal(Buffer.concat([raw, wal]).includes(Buffer.from(secret)), false, 'plaintext key not in the central database');
  // Copying shop B's sealed key onto shop A fails closed: shop A will not open with it.
  const db = h.platform.registry.db;
  const bSealed = db.prepare("SELECT sealed FROM shop_secrets WHERE shop_id=? AND kind='woo_secret'").get(b.shop.id).sealed;
  db.prepare("UPDATE shop_secrets SET sealed=? WHERE shop_id=? AND kind='woo_secret'").run(bSealed, a.shop.id);
  db.prepare('UPDATE shops SET version=version+1 WHERE id=?').run(a.shop.id);
  assert.throws(() => h.platform.registry.secretsFor(a.shop.id), /integrity/);
  assert.equal((await h.call(a.host, '/api/session')).status, 503);
  assert.equal((await h.call(b.host, '/api/session')).status, 200, 'shop B is unaffected');
  // Tampering and the wrong master key are caught too.
  const key = randomBytes(32);
  const sealed = sealSecret(key, a.shop.id, 'woo_key', 'ck_x');
  assert.equal(openSecret(key, a.shop.id, 'woo_key', sealed), 'ck_x');
  assert.throws(() => openSecret(key, a.shop.id, 'woo_secret', sealed), /integrity/);
  assert.throws(() => openSecret(randomBytes(32), a.shop.id, 'woo_key', sealed), /integrity/);
  assert.throws(() => openSecret(key, a.shop.id, 'woo_key', `${sealed.slice(0, -2)}AA`), /integrity/);
});

test('MansutRENDZGH-only tooling does not exist for platform shops', async t => {
  const h = await harness(t);
  const a = await h.sellingShop('amaboutique', 'ama');
  for (const url of ['/api/stock-safety/audit', '/api/reviewer/cases', '/api/desktop/bootstrap', '/api/instore/catalog', '/api/payments/reconciliation']) {
    assert.equal((await h.call(a.host, url, { token: a.token })).status, 404, url);
  }
  const session = await h.call(a.host, '/api/session', { token: a.token });
  assert.equal(session.data.config.platformShop, true);
  assert.equal(session.data.config.businessName, 'amaboutique boutique');
  assert.equal(session.data.config.receiptFooter, 'Thank you for shopping with amaboutique boutique.');
});

test('shops open on first use, close when idle, reopen with their data, and pick up setting changes', async t => {
  const h = await harness(t);
  const a = await h.sellingShop('amaboutique', 'ama');
  const opens = () => h.opened.filter(id => id === a.shop.id).length;
  const start = opens();
  await Promise.all(Array.from({ length: 10 }, () => h.call(a.host, '/api/health')));
  assert.equal(opens(), start, 'parallel requests share one open shop');
  h.platform.evictIdle(0);
  assert.equal(h.platform.openShops().length, 0);
  assert.equal((await h.call(a.host, '/api/session', { token: a.token })).data.user.username, 'ama', 'session survives a close and reopen');
  assert.equal(opens(), start + 1);
  // A stage change reaches the open shop on its next request.
  h.platform.registry.update(a.shop.id, { stage: 'read_only' }, 'test');
  const session = await h.call(a.host, '/api/session', { token: a.token });
  assert.equal(session.data.config.liveReadOnly, true);
  assert.equal(session.data.config.writesEnabled, false);
});

test('shop addresses, store URLs and platform-shop settings are validated', () => {
  for (const bad of ['', 'ab', 'a', '-shop', 'shop-', 'Shop', 'my_shop', 'shop.name', 'a--b', 'admin', 'www', 'x'.repeat(33), '../etc']) assert.ok(slugProblem(bad), bad);
  for (const good of ['ama', 'ama-boutique', 'k0fi', 'shop123']) assert.equal(slugProblem(good), '', good);
  assert.equal(slugFromHost(`ama.${BASE}`, BASE), 'ama');
  assert.equal(slugFromHost(BASE, BASE), '');
  assert.equal(slugFromHost(`a.b.${BASE}`, BASE), null);
  for (const bad of ['http://shop.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://shop.local',
    'https://shop.internal', 'https://user:pw@shop.example.com', 'https://shop.example.com/wp', 'https://shop.example.com:8443',
    'https://2130706433', 'https://0x7f000001', 'https://intranet', 'ftp://shop.example.com']) {
    assert.throws(() => normaliseStoreUrl(bad), Error, bad);
  }
  assert.equal(normaliseStoreUrl('https://Shop.Example.com/'), 'https://shop.example.com');
  const env = { POS_MODE: 'live', POS_TENANT_ID: 'shp_abcdefghijklmnopqrst', WOO_BASE_URL: 'https://shop.example.com' };
  assert.equal(readConfig(env).tenantId, env.POS_TENANT_ID);
  assert.throws(() => readConfig({ ...env, POS_TENANT_ID: 'shp_../../x' }), /platform shop id/);
  assert.throws(() => readConfig({ ...env, POS_MODE: 'staging' }), /live mode/);
  assert.throws(() => readConfig({ ...env, WOO_BASE_URL: 'https://localhost' }), /public|domain|address/);
  assert.throws(() => readConfig({ ...env, POS_DESKTOP_SETUP_APPROVED: 'true' }), /not available to platform shops/);
  assert.throws(() => readConfig({ POS_MODE: 'live', WOO_BASE_URL: 'https://shop.example.com' }), /restricted/, 'the single-shop server still refuses other stores');
});

test('a shop database copied into another shop\'s folder refuses to open', async t => {
  const h = await harness(t);
  const a = await h.sellingShop('amaboutique', 'ama');
  const b = await h.sellingShop('kofistyles', 'kofi');
  h.platform.evictIdle(0);
  const aDir = path.join(h.dir, 'shops', a.shop.id), bDir = path.join(h.dir, 'shops', b.shop.id);
  for (const name of fs.readdirSync(bDir).filter(n => n.startsWith('pos-live.db'))) fs.rmSync(path.join(bDir, name));
  fs.copyFileSync(path.join(aDir, 'pos-live.db'), path.join(bDir, 'pos-live.db'));
  assert.equal((await h.call(b.host, '/api/session', { token: a.token })).status, 503, 'shop B will not run on shop A\'s ledger');
  assert.equal((await h.call(a.host, '/api/session', { token: a.token })).data.user.username, 'ama');
});

test('platform backup copies the central and every shop database, each verified as its own shop', async t => {
  const { backupPlatform } = await import('../server/platform/backup.js');
  const h = await harness(t);
  const a = await h.sellingShop('amaboutique', 'ama');
  const b = await h.sellingShop('kofistyles', 'kofi');
  const { dir, manifest } = await backupPlatform(h.platform.config, h.platform.registry, path.join(h.dir, 'snapshots'));
  assert.deepEqual(manifest.shops.map(s => s.slug).sort(), ['amaboutique', 'kofistyles']);
  for (const shop of [a.shop, b.shop]) {
    const copy = new DatabaseSync(path.join(dir, 'shops', shop.id, 'pos-live.db'), { readOnly: true });
    try { assert.equal(copy.prepare("SELECT value FROM app_meta WHERE key='tenant_id'").get().value, shop.id); } finally { copy.close(); }
  }
  assert.ok(fs.existsSync(path.join(dir, 'platform.db')));
  assert.ok(manifest.shops.every(s => /^[0-9a-f]{64}$/.test(s.sha256)));
  // A swapped database is refused rather than backed up under the wrong shop.
  h.platform.evictIdle(0);
  const aDb = path.join(h.dir, 'shops', a.shop.id, 'pos-live.db'), bDb = path.join(h.dir, 'shops', b.shop.id, 'pos-live.db');
  fs.copyFileSync(aDb, bDb);
  await assert.rejects(() => backupPlatform(h.platform.config, h.platform.registry, path.join(h.dir, 'snapshots2')), /does not belong/);
});
