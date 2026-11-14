import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditSharedWooStock } from '../server/phase2-stock-audit.js';
import { createApp } from '../server/app.js';

const time = '2026-11-14T12:00:00.000Z';
const parent = (overrides = {}) => ({
  id: 6312, name: 'Synthetic shirt', type: 'variable', purchasable: true,
  stockSource: 'product', manageStock: true, stock: 2,
  stockStatus: 'instock', backordersAllowed: false,
  variations: [6581, 6582, 6583].map(id => ({
    id, label: String(id), purchasable: true, stockSource: 'parent',
    manageStock: true, stock: 2, stockStatus: 'instock', backordersAllowed: false,
  })),
  ...overrides,
});
const snapshot = (products, overrides = {}) => ({
  products, source: 'woocommerce', fetchedAt: time, complete: true,
  stale: false, unsupported: 0, ...overrides,
});

test('parent-managed size variations are one stock pool, not three independent balances', () => {
  const audit = auditSharedWooStock(snapshot([parent()]), Date.parse(time));
  assert.equal(audit.catalogue.selectableOptions, 3);
  assert.equal(audit.catalogue.managedStockPools, 1);
  assert.equal(audit.catalogue.sharedParentOrVariationPools, 1);
  assert.deepEqual(audit.issueCounts, {});
  assert.equal(audit.checkoutAuthorized, false, 'a clean catalogue does not prove last-unit concurrency');
  assert.equal(audit.sharedLastUnitGuardVerified, false);
  assert.equal(audit.auditOnly, true);
});

test('untracked, backorder, mismatched parent and missing stock are visible but cannot unlock selling', () => {
  const variation = parent({ id: 800, variations: [
    { id: 801, purchasable: true, stockSource: 'parent', manageStock: true,
      stock: 4, stockStatus: 'instock', backordersAllowed: true },
    { id: 802, purchasable: true, stockSource: 'parent', manageStock: true,
      stock: null, stockStatus: 'instock', backordersAllowed: false },
  ] });
  const untracked = { id: 900, type: 'simple', purchasable: true,
    stockSource: 'untracked', manageStock: false, stock: null, stockStatus: 'instock' };
  const audit = auditSharedWooStock(snapshot([variation, untracked]), Date.parse(time));
  assert.equal(audit.issueCounts.backorders_enabled, 1);
  assert.equal(audit.issueCounts.parent_stock_quantity_conflict, 1);
  assert.equal(audit.issueCounts.missing_or_invalid_stock_quantity, 1);
  assert.equal(audit.issueCounts.untracked_stock, 1);
  assert.equal(audit.checkoutAuthorized, false);
});

test('a stale, partial, unsupported or demo catalogue is never trusted as proof of stock', () => {
  const invalid = auditSharedWooStock(snapshot([parent()], {
    complete: false, stale: true, unsupported: 2,
  }), Date.parse(time) + 121000);
  assert.equal(invalid.issueCounts.incomplete_catalogue, 1);
  assert.equal(invalid.issueCounts.stale_or_unverified_snapshot, 1);
  assert.equal(invalid.issueCounts.unsupported_woo_product_types, 1);
  const demo = auditSharedWooStock({ products: [], source: 'public-product-snapshot', isDemo: true }, Date.parse(time));
  assert.equal(demo.issueCounts.not_live_woo_catalogue, 1);
  assert.equal(demo.checkoutAuthorized, false);
});

test('audit examples are bounded and never include product names, prices or customer data', () => {
  const products = Array.from({ length: 50 }, (_, n) => ({
    id: 1000 + n, name: 'Private Name', price: 19200,
    type: 'simple', purchasable: true, stockSource: 'untracked', manageStock: false,
  }));
  const audit = auditSharedWooStock(snapshot(products), Date.parse(time));
  assert.equal(audit.issueCounts.untracked_stock, 50);
  assert.equal(audit.examples.length, 20);
  assert.equal(JSON.stringify(audit).includes('Private Name'), false);
  assert.equal(JSON.stringify(audit).includes('19200'), false);
});

test('live pilot owner and manager can read Woo stock audit; cashier and public cannot; no remote write', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-stock-audit-'));
  const calls = [];
  const stockProduct = {
    id: 73, name: 'Synthetic live catalogue item', type: 'simple',
    sku: 'SYNTH-73', status: 'publish', price: '12.34',
    manage_stock: true, stock_quantity: 3, stock_status: 'instock',
    backorders: 'no', purchasable: true, images: [], categories: [],
  };
  const api = {
    async products() { calls.push('GET products'); return { data: [stockProduct], pages: 1, total: 1 }; },
    async variations() { calls.push('GET variations'); throw new Error('Unexpected variation request'); },
    async order() { calls.push('GET orders'); throw new Error('Order reads must remain locked'); },
    async createOrder() { calls.push('POST orders'); throw new Error('POS writes must remain locked'); },
    async updateOrder() { calls.push('PUT orders'); throw new Error('POS writes must remain locked'); },
  };
  const env = {
    NODE_ENV: 'test', POS_MODE: 'live', POS_LIVE_READ_ONLY: 'true',
    POS_ALLOW_LIVE_WRITES: 'false', WOO_BASE_URL: 'https://mansutrendzgh.com',
    WOO_CONSUMER_KEY: 'ck_synthetic', WOO_CONSUMER_SECRET: 'cs_synthetic',
    POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com',
    POS_DATA_DIR: dir, POS_OWNER_USERNAME: 'owner',
    POS_OWNER_PASSWORD: 'synthetic-pilot-password-123',
  };
  const { app, db } = createApp({ env, api,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (route, token, method = 'GET', body) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/stock-safety/audit')).status, 401);
  const login = await request('/auth/login', null, 'POST',
    { username: 'owner', password: 'synthetic-pilot-password-123' });
  assert.equal(login.status, 200);
  const token = login.body.token;
  assert.equal((await request('/auth/password', token, 'POST',
    { currentPassword: 'synthetic-pilot-password-123', newPassword: 'synthetic-rotated-password-123' })).status, 200);
  const first = await request('/stock-safety/audit', token);
  assert.equal(first.status, 200);
  assert.equal(first.body.kind, 'read-only-shared-woo-stock-audit');
  assert.equal(first.body.catalogue.managedStockPools, 1);
  assert.equal(first.body.checkoutAuthorized, false);
  const owner = db.prepare("SELECT id FROM users WHERE username='owner'").get();
  db.prepare("UPDATE users SET role='manager' WHERE id=?").run(owner.id);
  const manager = await request('/stock-safety/audit', token);
  assert.equal(manager.status, 200);
  assert.equal(manager.body.checkoutAuthorized, false);
  db.prepare("UPDATE users SET role='cashier' WHERE id=?").run(owner.id);
  assert.equal((await request('/stock-safety/audit', token)).status, 403);
  assert.deepEqual(calls, ['GET products', 'GET products'], 'Only Woo product reads, never orders or stock writes');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n, 0);
});
