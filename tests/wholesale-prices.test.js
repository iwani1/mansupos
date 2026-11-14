import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { matchingWholesalePrice, wholesaleCents, wholesaleIdentity } from '../src/wholesale-pricing.js';
import { openDatabase, SCHEMA_VERSION } from '../server/db.js';
import { readConfig } from '../server/config.js';
import { DatabaseSync } from 'node:sqlite';
import { RemoteError } from '../server/errors.js';

async function harness(t, { liveReadOnly = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-private-price-'));
  const state = {
    orderWrites: 0, productWrites: 0,
    product: { id: 6312, type: 'variable', status: 'publish', name: 'Mansu Shirt Top (fixture)', sku: 'AUG-84', price: '270.00',
      manage_stock: true, stock_quantity: 10, stock_status: 'instock', backorders: 'no', purchasable: true, images: [], categories: [] },
    option: { id: 6583, sku: '', attributes: [{ name: 'Size', option: 'S' }], price: '270.00',
      manage_stock: 'parent', stock_status: 'instock', backorders: 'no', purchasable: true },
  };
  const api = {
    async products() { return { data: [state.product], pages: 1, total: 1 }; },
    async variations() { return { data: [state.option], pages: 1, total: 1 }; },
    async product(id) { if (id !== state.product.id) throw new RemoteError('Product not found.', 404); return state.product; },
    async variation(productId, id) { if (productId !== state.product.id || id !== state.option.id) throw new RemoteError('Variation not found.', 404); return state.option; },
    async createOrder() { state.orderWrites++; throw new Error('No order may be created by a private price edit.'); },
    async updateOrder() { state.orderWrites++; throw new Error('No order may be updated by a private price edit.'); },
    async request(_resource, { method } = {}) { if (method !== 'GET') state.productWrites++; throw new Error('Private price edits must not write to WooCommerce.'); },
  };
  const env = {
    NODE_ENV: 'test', POS_MODE: 'live', POS_DATA_DIR: dir, WOO_BASE_URL: 'https://www.mansutrendzgh.com',
    WOO_CONSUMER_KEY: 'ck_fixture', WOO_CONSUMER_SECRET: 'cs_fixture', POS_LIVE_READ_ONLY: String(liveReadOnly),
    POS_ALLOW_LIVE_WRITES: 'false', POS_LIVE_WHOLESALE_APPROVED: 'false', POS_INSTORE_CASH_APPROVED: 'false',
    POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'private-price-bootstrap-123',
  };
  const instance = createApp({ env, api, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(route, { method = 'GET', body, token } = {}) {
    const response = await fetch(base + route, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Mansu-Session': token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }
  const login = async (username, password) => (await request('/auth/login', { method: 'POST', body: { username, password } })).data.token;
  const owner = await login('owner', env.POS_OWNER_PASSWORD);
  assert.ok(owner);
  assert.equal((await request('/auth/password', { method: 'POST', token: owner,
    body: { currentPassword: env.POS_OWNER_PASSWORD, newPassword: 'private-price-rotated-123' } })).status, 200);
  async function identity() {
    const catalog = await request('/catalog', { token: owner });
    assert.equal(catalog.status, 200);
    const product = catalog.data.products.find(p => p.id === state.product.id);
    const option = product?.variations.find(v => v.id === state.option.id);
    return wholesaleIdentity(product, option);
  }
  t.after(async () => { await new Promise(resolve => server.close(resolve)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...instance, request, owner, login, state, identity };
}

test('private wholesale defaults use exact GHS cents and require matching Woo IDs/SKUs/options', () => {
  assert.equal(wholesaleCents('75'), 7500);
  assert.equal(wholesaleCents('75.50'), 7550);
  for (const bad of ['', '0', '-1', '75.555', '1e3', '1000000.01']) assert.equal(wholesaleCents(bad), null);
  const product = { id: 6312, name: 'Mansu Shirt Top', sku: 'AUG-84', price: 27000 };
  const option = { id: 6583, sku: '', label: 'S', attributes: [{ name: 'Size', option: 'S' }], price: 27000 };
  const record = { productId: 6312, variationId: 6583, ...wholesaleIdentity(product, option), priceCents: 7500, valid: true };
  assert.equal(matchingWholesalePrice(product, option, [record]), 7500);
  assert.equal(matchingWholesalePrice(product, { ...option, label: 'M' }, [record]), null);
  assert.equal(matchingWholesalePrice(product, { ...option, attributes: [{ name: 'Colour', option: 'S' }] }, [record]), null);
  assert.equal(matchingWholesalePrice(product, { ...option, price: 28000 }, [record]), null);
  assert.equal(matchingWholesalePrice({ ...product, sku: 'NEW-SKU' }, option, [record]), null);
  assert.equal(matchingWholesalePrice({ ...product, name: 'New style' }, option, [record]), null);
  assert.equal(matchingWholesalePrice(product, option, [{ ...record, valid: false }]), null);
  assert.equal(matchingWholesalePrice(product, option, [record], false), null);
});

test('owner saves private per-option prices without Woo writes; manager can read, cashier/public cannot', async t => {
  const h = await harness(t);
  const managerPassword = 'staff-secret-passphrase-alpha-123';
  const cashierPassword = 'staff-secret-passphrase-bravo-123';
  const manager = await h.request('/staff', { method: 'POST', token: h.owner,
    body: { name: 'Manager', username: 'manager', role: 'manager', password: managerPassword } });
  const cashier = await h.request('/staff', { method: 'POST', token: h.owner,
    body: { name: 'Cashier', username: 'cashier', role: 'cashier', password: cashierPassword } });
  assert.equal(manager.status, 201);
  assert.equal(cashier.status, 201);
  const managerToken = await h.login('manager', managerPassword);
  const cashierToken = await h.login('cashier', cashierPassword);
  for (const [token, password] of [[managerToken, managerPassword], [cashierToken, cashierPassword]]) {
    assert.equal((await h.request('/auth/password', { method: 'POST', token, body: { currentPassword: password, newPassword: `${password}-updated` } })).status, 200);
  }

  assert.equal((await h.request('/wholesale-prices')).status, 401);
  assert.equal((await h.request('/wholesale-prices', { token: cashierToken })).status, 403);
  assert.equal((await h.request('/wholesale-prices', { token: managerToken })).status, 200);
  assert.deepEqual((await h.request('/wholesale-prices', { token: h.owner })).data.prices, []);
  const expectedIdentity = await h.identity();
  const save = await h.request('/wholesale-prices/6312/6583', { method: 'PUT', token: h.owner,
    body: { priceCents: 7500, expectedRevision: 0, expectedIdentity } });
  assert.equal(save.status, 200, JSON.stringify(save.data));
  assert.deepEqual([save.data.price.priceCents, save.data.price.parentSku, save.data.price.optionSku, save.data.price.optionLabel, save.data.price.optionAttributes, save.data.price.retailPriceCents, save.data.price.revision],
    [7500, 'AUG-84', '', 'S', '[["Size","S"]]', 27000, 1]);
  const prices = await h.request('/wholesale-prices', { token: managerToken });
  assert.equal(prices.status, 200);
  assert.equal(prices.data.prices[0].valid, true);
  assert.equal(prices.data.prices[0].priceCents, 7500);
  assert.equal((await h.request('/wholesale-prices/6312/6583', { method: 'PUT', token: managerToken, body: { priceCents: 1, expectedRevision: 1, expectedIdentity } })).status, 403);
  assert.equal((await h.request('/wholesale-prices/6312/6583', { method: 'PUT', token: cashierToken, body: { priceCents: 1, expectedRevision: 1, expectedIdentity } })).status, 403);
  const retail = await h.request('/catalog', { token: cashierToken });
  assert.equal(retail.status, 200);
  assert.equal(retail.data.products[0].variations[0].price, 27000);
  assert.doesNotMatch(JSON.stringify(retail.data), /priceCents|7500|wholesale/i);
  assert.equal((await h.request('/sales/prepare', { method: 'POST', token: h.owner, body: {} })).status, 400);
  assert.equal((await h.request('/ready')).status, 503, 'A write-locked trading instance must not appear ready for sales.');
  assert.equal(h.state.orderWrites, 0);
  assert.equal(h.state.productWrites, 0);
  assert.ok(h.db.prepare("SELECT 1 FROM audit WHERE action='wholesale.price_saved' AND subject='6312:6583'").get());
});

test('Woo changes require refreshed owner identity; delete/recreate cannot reuse an old edit revision', async t => {
  const h = await harness(t);
  const originalIdentity = await h.identity();
  const saved = await h.request('/wholesale-prices/6312/6583', { method: 'PUT', token: h.owner,
    body: { priceCents: 7500, expectedRevision: 0, expectedIdentity: originalIdentity } });
  assert.equal(saved.status, 200);
  h.state.option = { ...h.state.option, attributes: [{ name: 'Size', option: 'M' }] };
  h.catalog.invalidate();
  assert.equal((await h.request('/wholesale-prices', { token: h.owner })).data.prices[0].valid, false);
  const stale = await h.request('/wholesale-prices/6312/6583', { method: 'PUT', token: h.owner,
    body: { priceCents: 7400, expectedRevision: 1, expectedIdentity: originalIdentity } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'CATALOG_CHANGED');
  const revisedIdentity = await h.identity();
  const updated = await h.request('/wholesale-prices/6312/6583', { method: 'PUT', token: h.owner,
    body: { priceCents: 7400, expectedRevision: 1, expectedIdentity: revisedIdentity } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.price.optionLabel, 'M');
  assert.equal(updated.data.price.revision, 2);
  assert.equal((await h.request('/wholesale-prices', { token: h.owner })).data.prices[0].valid, true);
  // A renamed attribute is different even when the visible option label is unchanged.
  h.state.option = { ...h.state.option, attributes: [{ name: 'Colour', option: 'M' }] };
  h.catalog.invalidate();
  assert.equal((await h.request('/wholesale-prices', { token: h.owner })).data.prices[0].valid, false);
  h.state.option = { ...h.state.option, attributes: [{ name: 'Size', option: 'M' }], price: '280.00' };
  h.catalog.invalidate();
  assert.equal((await h.request('/wholesale-prices', { token: h.owner })).data.prices[0].valid, false);
  h.state.product = { ...h.state.product, sku: 'CHANGED-PARENT' };
  h.catalog.invalidate();
  const currentIdentity = await h.identity();
  assert.equal((await h.request('/wholesale-prices/6312/6583', { method: 'PUT', token: h.owner,
    body: { priceCents: 1, expectedRevision: 1, expectedIdentity: currentIdentity } })).data.code, 'PRICE_CHANGED');
  assert.equal((await h.request('/wholesale-prices/6312/6583', { method: 'PUT', token: h.owner,
    body: { priceCents: 0, expectedRevision: 2, expectedIdentity: currentIdentity } })).status, 400);
  assert.equal((await h.request('/wholesale-prices/6312/6583', { method: 'DELETE', token: h.owner,
    body: { expectedRevision: 1 } })).status, 409);
  assert.equal((await h.request('/wholesale-prices/6312/6583', { method: 'DELETE', token: h.owner,
    body: { expectedRevision: 2 } })).status, 200);
  const recreated = await h.request('/wholesale-prices/6312/6583', { method: 'PUT', token: h.owner,
    body: { priceCents: 7300, expectedRevision: 0, expectedIdentity: currentIdentity } });
  assert.equal(recreated.status, 200);
  assert.ok(recreated.data.price.revision > 2);
  assert.equal((await h.request('/wholesale-prices/6312/6583', { method: 'PUT', token: h.owner,
    body: { priceCents: 1, expectedRevision: 2, expectedIdentity: currentIdentity } })).data.code, 'PRICE_CHANGED');
  assert.equal((await h.request('/wholesale-prices', { token: h.owner })).data.prices[0].priceCents, 7300);
  assert.equal(h.state.orderWrites, 0);
  assert.equal(h.state.productWrites, 0);
});

test('live read-only catalogue pilot blocks private price reads and writes and keeps checkout locked', async t => {
  const h = await harness(t, { liveReadOnly: true });
  assert.equal((await h.request('/wholesale-prices', { token: h.owner })).status, 403);
  assert.equal((await h.request('/wholesale-prices/6312/6583', { method: 'PUT', token: h.owner,
    body: { priceCents: 7500, expectedRevision: 0, expectedIdentity: await h.identity() } })).status, 403);
  assert.equal((await h.request('/sales/prepare', { method: 'POST', token: h.owner,
    body: { idempotencyKey: crypto.randomUUID(), items: [{ productId: 6312, variationId: 6583, quantity: 1 }] } })).status, 403);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM wholesale_prices').get().count, 0);
  assert.equal(h.state.orderWrites, 0);
  assert.equal(h.state.productWrites, 0);
});

test('schema v6 upgrades without deleting prior prices or sales; previous defaults require re-review', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-private-price-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path.join(dir, 'pos-live.db'));
  legacy.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (6, 'legacy fixture');
    CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_meta VALUES ('mode', 'live');
    INSERT INTO app_meta VALUES ('service_identity', 'live-pilot');
    CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT NOT NULL);
    INSERT INTO users VALUES ('owner-1', 'owner');
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE demo_stock(line_key TEXT PRIMARY KEY);
    CREATE TABLE shifts(id TEXT PRIMARY KEY);
    CREATE TABLE cash_movements(id TEXT PRIMARY KEY);
    CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE sales(id TEXT PRIMARY KEY, woo_order_id INTEGER, shift_id TEXT);
    INSERT INTO sales(id) VALUES ('paid-receipt-to-preserve');
    CREATE TABLE wholesale_prices (
      product_id INTEGER NOT NULL, variation_id INTEGER NOT NULL,
      parent_sku TEXT NOT NULL, option_sku TEXT NOT NULL, option_label TEXT NOT NULL,
      unit_price_cents INTEGER NOT NULL, revision INTEGER NOT NULL,
      updated_by TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
      PRIMARY KEY(product_id, variation_id)
    );
    INSERT INTO wholesale_prices VALUES (6312, 6583, 'AUG-84', '', 'S', 7500, 42, 'owner-1', 'legacy fixture');
  `);
  // The offline legacy identity-review flow is tested separately. This
  // fixture models a ledger that was explicitly bound before the v9 upgrade.
  legacy.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run('ledger_uuid', crypto.randomUUID());
  legacy.close();
  const db = openDatabase(readConfig({ NODE_ENV: 'test', POS_MODE: 'live', POS_DATA_DIR: dir, POS_LIVE_READ_ONLY: 'true' }));
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, SCHEMA_VERSION);
  assert.ok(db.prepare("SELECT id FROM sales WHERE id='paid-receipt-to-preserve'").get());
  const previous = db.prepare('SELECT * FROM wholesale_prices').get();
  assert.deepEqual([previous.unit_price_cents, previous.revision, previous.product_name, previous.option_attributes, previous.retail_price_cents],
    [7500, 42, '', '', -1]);
  const next = Number(db.prepare('INSERT INTO wholesale_price_revisions DEFAULT VALUES').run().lastInsertRowid);
  assert.ok(next > previous.revision, 'New revisions must not reuse a pre-upgrade edit token.');
});
