import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
import { openDatabase, hashPassword } from '../server/db.js';
import { InStoreService } from '../server/instore.js';
import { buildInStoreSnapshot, loadInStoreSnapshot } from '../server/instore-catalog.js';

const source = loadInStoreSnapshot();
const expectedHash = createHash('sha256').update(fs.readFileSync('data/instore-stock-snapshot.json')).digest('hex');
const fixtureDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-instore-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const envFor = (dir, { enabled = false, readOnly = !enabled } = {}) => ({
  NODE_ENV: 'test', POS_MODE: 'live', POS_LIVE_READ_ONLY: String(readOnly),
  POS_ALLOW_LIVE_WRITES: 'false', POS_LIVE_WHOLESALE_APPROVED: 'false',
  POS_INSTORE_CASH_APPROVED: String(enabled), POS_INSTORE_ACCEPTANCE_REFERENCE: enabled ? 'separate-physical-stock-acceptance' : '',
  POS_INSTORE_SOURCE_SHA256: enabled ? expectedHash : '', POS_REQUIRE_SHIFT: enabled ? 'true' : 'false',
  POS_DATA_DIR: dir, WOO_BASE_URL: 'https://mansutrendzgh.com',
  WOO_CONSUMER_KEY: 'ck_readonly_fixture', WOO_CONSUMER_SECRET: 'cs_readonly_fixture',
  POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'private-initial-passphrase-123',
});

async function fixture(t, options = {}) {
  const dir = fixtureDir(t);
  let wooRequests = 0;
  const instance = createApp({ env: envFor(dir, options), api: {
    async request() { wooRequests++; throw Error('An in-store operation called WooCommerce!'); },
    async products() { wooRequests++; throw Error('An in-store operation read WooCommerce!'); },
  }, logger: { info() {}, warn() {}, error() {} } });
  instance.db.prepare("UPDATE users SET must_change_password=0 WHERE username='owner'").run();
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); instance.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = async (url, { method = 'GET', token = '', body } = {}) => fetch(`${base}/api${url}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const call = async (url, options = {}) => {
    const response = await raw(url, options);
    const data = response.headers.get('content-type')?.includes('text/csv') ? await response.text() : await response.json();
    return { status: response.status, data, headers: response.headers };
  };
  const login = async (username = 'owner', password = 'private-initial-passphrase-123') => {
    const response = await call('/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data.token;
  };
  return { dir, instance, call, raw, login, get wooRequests() { return wooRequests; } };
}

test('source import matches every PDF row, isolates uncertain prices/units/negative stock and never exposes costs', () => {
  assert.equal(source.manifestHash, expectedHash);
  assert.equal(source.summary.items, 1571);
  assert.equal(source.summary.available, 1206);
  assert.equal(source.summary.outOfStock, 324);
  assert.equal(source.summary.needsReview, 41);
  assert.equal(source.summary.unidentified, 1);
  assert.equal(source.items.filter(item => item.reportedQuantity < 0).length, 28);
  assert.deepEqual(source.items.filter(item => ['1469', '1470', '1471'].includes(item.sku)).map(item => [item.status, item.priceCents]),
    [['review', null], ['review', null], ['review', null]]);
  for (const sku of ['632', '1202', '698', '697', '696', '100', '139', '140', '141']) {
    assert.equal(source.items.find(item => item.sku === sku).status, 'review', `${sku} has a missing/malformed UOM`);
  }
  const noSku = source.items.find(item => !item.sku);
  assert.equal(noSku.reportRow, 508);
  assert.equal(noSku.reportedQuantity, 2);
  assert.equal(noSku.stock, null);
  assert.equal(noSku.status, 'review');
  assert.equal(source.items.filter(item => item.status !== 'review').length, 1530);
  const exposed = JSON.stringify(source);
  assert.doesNotMatch(exposed, /"Cost"|"CostPrice"|"Markup"|"TaxRate"|"wooOrderId"/);
  assert.equal(source.items.find(item => item.sku === '1434').priceCents, 35000);
});

test('source hashes, missing report rows and duplicate product SKUs fail closed', t => {
  const root = fixtureDir(t);
  fs.mkdirSync(path.join(root, 'data'));
  for (const name of ['products.csv', 'Stock-2026-11-12.pdf']) fs.copyFileSync(name, path.join(root, name));
  const manifestPath = path.join(root, 'data/instore-stock-snapshot.json');
  const original = fs.readFileSync('data/instore-stock-snapshot.json');
  fs.writeFileSync(manifestPath, original);
  assert.equal(loadInStoreSnapshot(root).summary.items, 1571);
  fs.appendFileSync(path.join(root, 'products.csv'), '\n');
  assert.throws(() => loadInStoreSnapshot(root), /stock source needs owner review.*changed since review/);
  fs.copyFileSync('products.csv', path.join(root, 'products.csv'));
  const data = JSON.parse(original);
  data.rows.splice(0, 1);
  fs.writeFileSync(manifestPath, JSON.stringify(data));
  assert.throws(() => loadInStoreSnapshot(root), /report row counts do not match/);
  data.rows = JSON.parse(original).rows;
  data.unidentifiedReportRows[0].name = 'Some other product';
  fs.writeFileSync(manifestPath, JSON.stringify(data));
  assert.throws(() => loadInStoreSnapshot(root), /unidentified product name/);
  const sample = { Name: 'Sample', ProductGroup: 'Test', SKU: '1', Barcode: '', MeasurementUnit: 'Each', Price: '12.00', IsEnabled: '1' };
  const stock = { sourcePdf: 'fixture.pdf', unidentifiedCsvRows: 0, unidentifiedReportRows: [], rows: [
    { sku: '1', quantity: 1, unit: 'Each', reportRow: 1, page: 1 },
    { sku: '2', quantity: 1, unit: 'Each', reportRow: 2, page: 1 },
  ] };
  assert.throws(() => buildInStoreSnapshot([sample, { ...sample }], stock), /duplicate product SKU/);
});

test('legacy local cash fixtures retain safeguards but production rejects the obsolete second stock pool', t => {
  const dir = fixtureDir(t);
  const gate = envFor(dir, { enabled: true });
  assert.equal(readConfig(gate).inStoreCashEnabled, true);
  assert.equal(readConfig(gate).writesEnabled, false);
  assert.throws(() => readConfig({ ...gate, POS_LIVE_READ_ONLY: 'true' }), /read-only pilot/);
  assert.throws(() => readConfig({ ...gate, POS_REQUIRE_SHIFT: 'false' }), /mandatory shifts/);
  assert.throws(() => readConfig({ ...gate, POS_INSTORE_ACCEPTANCE_REFERENCE: '' }), /distinct acceptance reference/);
  assert.throws(() => readConfig({ ...gate, POS_INSTORE_SOURCE_SHA256: '' }), /pinned stock source/);
  assert.throws(() => readConfig({ ...gate, POS_OWNER_APPROVAL_REFERENCE: 'separate-physical-stock-acceptance' }), /distinct acceptance reference/);
  assert.throws(() => readConfig({ ...gate, POS_MODE: 'staging', WOO_BASE_URL: 'https://staging.example.com' }), /separate reviewed live/);
  const productionGate = { ...gate, NODE_ENV: 'production', POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com' };
  assert.throws(() => readConfig(productionGate), /retired for shared WooCommerce stock/);
  assert.throws(() => readConfig({ ...gate, NODE_ENV: 'development' }), /retired for shared WooCommerce stock/);
  assert.throws(() => readConfig({ ...gate, NODE_ENV: '' }), /retired for shared WooCommerce stock/);
  assert.equal(readConfig({ ...productionGate, POS_INSTORE_CASH_APPROVED: 'false' }).inStoreCashEnabled, false);
  assert.equal(readConfig(envFor(dir)).inStoreCashEnabled, false);
});

test('read-only pilot exposes authenticated collection but cannot import, sell, count, open shift or contact WooCommerce', async t => {
  const fixtureData = await fixture(t);
  const { instance, call, login } = fixtureData;
  const noAuth = await call('/instore/catalog');
  assert.equal(noAuth.status, 401);
  const token = await login();
  const catalogue = await call('/instore/catalog', { token });
  assert.equal(catalogue.status, 200);
  assert.equal(catalogue.data.summary.salesEnabled, false);
  assert.equal(catalogue.data.items.length, 1571);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM instore_imports').get().n, 0);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM instore_inventory').get().n, 0);
  const sale = await call('/instore/sales', { method: 'POST', token, body: { idempotencyKey: randomUUID(), items: [{ sku: '1434', quantity: 1 }], expectedTotal: 35000, tendered: 35000, confirmed: true } });
  assert.equal(sale.status, 403);
  assert.equal(sale.data.code, 'INSTORE_CHECKOUT_LOCKED');
  const count = await call('/instore/stock/1434/count', { method: 'POST', token, body: { idempotencyKey: randomUUID(), countedQuantity: 9, expectedQuantity: 2, reason: 'Physical recount' } });
  assert.equal(count.status, 403);
  assert.equal((await call('/shifts/open', { method: 'POST', token, body: { openingFloat: 0 } })).status, 403);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n, 0);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM instore_stock_movements').get().n, 0);
  assert.equal(fixtureData.wooRequests, 0);
});

test('one approved, isolated cash sale atomically decrements only in-store stock and returns an idempotent gross receipt', async t => {
  const fixtureData = await fixture(t, { enabled: true });
  const { instance, call, login } = fixtureData;
  const token = await login();
  assert.equal(instance.config.writesEnabled, false);
  assert.equal(instance.config.wholesaleWritesEnabled, false);
  assert.equal((await call('/ready')).status, 200, 'A separate in-store-only trading service is ready with Woo writes locked.');
  const initial = await call('/instore/catalog', { token });
  assert.equal(initial.data.summary.salesEnabled, true);
  assert.equal(initial.data.summary.importedAt != null, true);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM instore_inventory').get().n, 1530);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM instore_stock_movements WHERE kind=?').get('import').n, 1206);
  const body = { idempotencyKey: randomUUID(), items: [{ sku: '1196', quantity: 1 }, { sku: '1434', quantity: 1 }, { sku: '1434', quantity: 1 }], expectedTotal: 95000, tendered: 100000, confirmed: true };
  const beforeShift = await call('/instore/sales', { method: 'POST', token, body });
  assert.equal(beforeShift.status, 409);
  assert.equal(beforeShift.data.code, 'SHIFT_REQUIRED');
  const opened = await call('/shifts/open', { method: 'POST', token, body: { openingFloat: 10000 } });
  assert.equal(opened.status, 201);
  const paid = await call('/instore/sales', { method: 'POST', token, body });
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  const sale = paid.data.sale;
  assert.match(sale.number, /^IS-\d{8}-\d{6}$/);
  assert.equal(sale.saleType, 'instore');
  assert.equal(sale.paymentMethod, 'cash');
  assert.equal(sale.currency, 'GHS');
  assert.equal(sale.status, 'paid');
  assert.equal(sale.total, 95000);
  assert.equal(sale.tendered, 100000);
  assert.equal(sale.changeDue, 5000);
  assert.equal(sale.shiftId, opened.data.shift.id);
  assert.equal(sale.items.reduce((n, i) => n + i.total, 0), sale.total);
  assert.equal(sale.items.find(item => item.sku === '1434').quantity, 2);
  assert.equal(sale.items.find(item => item.sku === '1434').price, 35000);
  assert.equal(sale.wooOrderId, undefined);
  assert.equal(sale.tax, undefined, 'Gross-only receipt must not claim VAT is zero.');
  assert.equal((await call('/instore/sales', { method: 'POST', token, body: { ...body, items: body.items.toReversed() } })).data.sale.id, sale.id);
  assert.equal((await call(`/instore/sales/by-key/${body.idempotencyKey}`, { token })).data.sale.id, sale.id);
  assert.equal((await call(`/instore/sales/${sale.id}`, { token })).data.sale.id, sale.id);
  const changedBody = await call('/instore/sales', { method: 'POST', token, body: { ...body, tendered: 110000 } });
  assert.equal(changedBody.status, 409);
  assert.equal(changedBody.data.code, 'INSTORE_IDEMPOTENCY_CONFLICT');
  const after = await call('/instore/catalog', { token });
  assert.equal(after.data.items.find(item => item.sku === '1434').stock, 0);
  assert.equal(after.data.items.find(item => item.sku === '1434').status, 'out_of_stock');
  assert.equal(after.data.items.find(item => item.sku === '1196').stock, 2);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n, 1);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM instore_stock_movements WHERE kind=?').get('sale').n, 2);
  const movement = (await call('/instore/stock/1434/movements?limit=2', { token })).data;
  assert.equal(movement.movements[0].receiptNumber, sale.number);
  assert.equal(movement.movements[0].balanceAfter, 0);
  assert.equal(movement.movements[1].kind, 'import');
  assert.equal((await call('/shifts/current', { token })).data.shift.expectedCash, 105000);
  assert.equal((await call('/shifts/current', { token })).data.shift.summary.inStoreCash, 95000);
  assert.equal((await call('/reports', { token })).data.orders, 0, 'Woo-backed sales report remains independent.');
  assert.equal((await call('/sales', { token })).data.sales.length, 0, 'Woo-backed sales history remains independent.');
  const report = await call('/instore/reports?days=7', { token });
  assert.equal(report.data.total, 95000);
  assert.equal(report.data.orders, 1);
  assert.equal(report.data.units, 3);
  const exportCsv = await call('/instore/reports/export?days=7', { token });
  assert.equal(exportCsv.status, 200);
  assert.match(exportCsv.data, /IS-\d{8}-\d{6}/);
  assert.doesNotMatch(exportCsv.data, /WooCommerce order|\bCost\b|Markup|Tax/);
  assert.equal(fixtureData.wooRequests, 0);
  const closed = await call(`/shifts/${opened.data.shift.id}/close`, { method: 'POST', token, body: { closingCash: 105000 } });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.shift.variance, 0);
  assert.equal(closed.data.shift.summary.inStoreCash, 95000);
  const checkedResources = [];
  instance.api.request = async resource => { checkedResources.push(resource); return { total: 115, data: [] }; };
  const diagnostics = await call('/connection/diagnostics', { token });
  assert.equal(diagnostics.data.ok, true);
  assert.deepEqual(checkedResources, ['products'], 'An in-store-only service must not probe Woo customer orders.');
  assert.equal(diagnostics.data.checks.some(check => check.name === 'WooCommerce orders read'), false);
});

test('stock, price, payment-method, unidentified and review exceptions never create a sale or deduct stock', async t => {
  const { instance, call, login } = await fixture(t, { enabled: true });
  const token = await login();
  const opened = await call('/shifts/open', { method: 'POST', token, body: { openingFloat: 0 } });
  assert.equal(opened.status, 201);
  const attempt = (sku, quantity = 1, extras = {}) => call('/instore/sales', { method: 'POST', token, body: { idempotencyKey: randomUUID(), items: [{ sku, quantity }], expectedTotal: 35000, tendered: 35000, confirmed: true, ...extras } });
  for (const sku of ['1471', '632', '696', '141', source.items.find(item => item.reportedQuantity < 0).sku]) {
    const result = await attempt(sku);
    assert.equal(result.status, 409, `${sku} cannot be sold`);
    assert.equal(result.data.code, 'INSTORE_ITEM_REVIEW');
  }
  assert.equal((await attempt('1197')).data.code, 'INSTORE_OUT_OF_STOCK');
  assert.equal((await attempt('1434', 3)).data.code, 'INSTORE_OUT_OF_STOCK');
  assert.equal((await attempt('99999999')).data.code, 'INSTORE_ITEM_REVIEW');
  assert.equal((await attempt('')).status, 400, 'Unidentified CSV item cannot be sold by name.');
  assert.equal((await attempt('1434', 1, { expectedTotal: 1 })).data.code, 'INSTORE_PRICE_CHANGED');
  assert.equal((await attempt('1434', 1, { tendered: 34999 })).data.code, 'INSTORE_INSUFFICIENT_CASH');
  for (const extra of [{ method: 'momo' }, { price: 1 }, { wooOrderId: 42 }, { paystackReference: 'X' }, { agreedUnitPrice: 1 }]) {
    assert.equal((await attempt('1434', 1, extra)).status, 400, `Client cannot override source via ${Object.keys(extra)}`);
  }
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n, 0);
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM instore_stock_movements WHERE kind='sale'").get().n, 0);
  assert.equal(instance.db.prepare("SELECT on_hand FROM instore_inventory WHERE sku='1434'").get().on_hand, 2);
});

test('two different keys cannot oversell the last unit; the losing transaction leaves no receipt or movement', async t => {
  const { instance, call, login } = await fixture(t, { enabled: true });
  const token = await login();
  await call('/shifts/open', { method: 'POST', token, body: { openingFloat: 0 } });
  const results = await Promise.all([0, 1].map(() => call('/instore/sales', { method: 'POST', token, body: {
    idempotencyKey: randomUUID(), items: [{ sku: '1434', quantity: 2 }], expectedTotal: 70000, tendered: 70000, confirmed: true,
  } })));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM instore_sales').get().n, 1);
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM instore_stock_movements WHERE kind='sale'").get().n, 1);
  assert.equal(instance.db.prepare("SELECT on_hand FROM instore_inventory WHERE sku='1434'").get().on_hand, 0);
});

test('owner-only counted corrections are auditable/idempotent, never authorize quarantined SKUs, and survive a restart', async t => {
  const { instance, call, login } = await fixture(t, { enabled: true });
  const owner = await login();
  const ownerId = instance.db.prepare("SELECT id FROM users WHERE username='owner'").get().id;
  const count = { idempotencyKey: randomUUID(), expectedQuantity: 2, countedQuantity: 1, reason: 'Checked the physical shelf with owner' };
  const corrected = await call('/instore/stock/1434/count', { method: 'POST', token: owner, body: count });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.onHand, 1);
  assert.deepEqual((await call('/instore/stock/1434/count', { method: 'POST', token: owner, body: count })).data, corrected.data);
  assert.equal((await call('/instore/stock/632/count', { method: 'POST', token: owner, body: { ...count, idempotencyKey: randomUUID() } })).data.code, 'INSTORE_ITEM_REVIEW');
  assert.equal((await call('/instore/stock/1471/count', { method: 'POST', token: owner, body: { ...count, idempotencyKey: randomUUID() } })).status, 409);
  const movement = (await call('/instore/stock/1434/movements', { token: owner })).data;
  assert.equal(movement.onHand, 1);
  assert.equal(movement.movements[0].kind, 'count');
  assert.equal(movement.movements[0].delta, -1);
  assert.equal(movement.movements[0].reason, count.reason);
  const firstPage = (await call('/instore/stock/1434/movements?limit=1', { token: owner })).data;
  assert.equal(firstPage.movements.length, 1);
  assert.ok(firstPage.nextCursor);
  const older = (await call(`/instore/stock/1434/movements?limit=1&before=${firstPage.nextCursor}`, { token: owner })).data;
  assert.equal(older.movements[0].kind, 'import');
  assert.equal(older.nextCursor, null);
  assert.equal(instance.db.prepare("SELECT COUNT(*) AS n FROM instore_stock_counts WHERE sku='1434'").get().n, 1);
  const staffId = randomUUID();
  instance.db.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(staffId, 'cashier', 'Fixture Cashier', 'cashier', hashPassword('cashier-fixture-secret-123'), new Date().toISOString());
  const cashier = await login('cashier', 'cashier-fixture-secret-123');
  assert.equal((await call('/instore/stock/1434/count', { method: 'POST', token: cashier, body: { ...count, idempotencyKey: randomUUID() } })).status, 403);
  assert.equal((await call('/instore/stock/1434/movements', { token: cashier })).status, 403);
  assert.equal((await call('/instore/reports', { token: cashier })).status, 403);
  assert.equal((await call('/instore/reports/export', { token: cashier })).status, 403);
  const cashierShift = await call('/shifts/open', { method: 'POST', token: cashier, body: { openingFloat: 0 } });
  assert.equal(cashierShift.status, 201);
  const cashierKey = randomUUID();
  const cashierSale = await call('/instore/sales', { method: 'POST', token: cashier, body: { idempotencyKey: cashierKey, items: [{ sku: '1434', quantity: 1 }], expectedTotal: 35000, tendered: 35000, confirmed: true } });
  assert.equal(cashierSale.status, 201);
  assert.equal((await call('/instore/sales', { token: owner })).data.sales.length, 1);
  assert.equal((await call(`/instore/sales/${cashierSale.data.sale.id}`, { token: owner })).status, 200);
  const otherId = randomUUID();
  instance.db.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(otherId, 'cashier2', 'Other Cashier', 'cashier', hashPassword('another-fixture-secret-123'), new Date().toISOString());
  const other = await login('cashier2', 'another-fixture-secret-123');
  assert.equal((await call('/instore/sales', { token: other })).data.sales.length, 0);
  assert.equal((await call(`/instore/sales/${cashierSale.data.sale.id}`, { token: other })).status, 404);
  assert.equal((await call(`/instore/sales/by-key/${cashierKey}`, { token: other })).status, 404);
  assert.equal(instance.db.prepare("SELECT on_hand FROM instore_inventory WHERE sku='1434'").get().on_hand, 0);
  assert.equal(ownerId != null, true);
});

test('a restarted ledger never reseeds after sales; a mismatched source pin refuses import before stock changes', t => {
  const dir = fixtureDir(t);
  const env = envFor(dir, { enabled: true });
  let db = openDatabase(readConfig(env));
  const service = new InStoreService(db, readConfig(env));
  const firstImport = service.imported().imported_at;
  db.prepare("UPDATE instore_inventory SET on_hand=0 WHERE sku='1434'").run();
  db.close();
  db = openDatabase(readConfig(env));
  const restarted = new InStoreService(db, readConfig(env));
  assert.equal(restarted.imported().imported_at, firstImport);
  assert.equal(restarted.catalog().items.find(item => item.sku === '1434').stock, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM instore_imports').get().n, 1);
  const lockedEnv = { ...env, POS_INSTORE_CASH_APPROVED: 'false', POS_INSTORE_ACCEPTANCE_REFERENCE: '', POS_INSTORE_SOURCE_SHA256: '' };
  const locked = new InStoreService(db, readConfig(lockedEnv));
  assert.equal(locked.catalog().summary.salesEnabled, false);
  assert.equal(locked.catalog().items.find(item => item.sku === '1434').stock, 0, 'Emergency lock must show the last POS balance, not the original PDF count.');
  assert.throws(() => locked.recordSale({ id: 'owner', role: 'owner' }, {}), /In-store cash checkout is locked/);
  const poisonedEnv = { ...env, POS_INSTORE_SOURCE_SHA256: 'f'.repeat(64) };
  assert.throws(() => new InStoreService(db, readConfig(poisonedEnv)), /pinned stock snapshot hash/);
  assert.equal(db.prepare("SELECT on_hand FROM instore_inventory WHERE sku='1434'").get().on_hand, 0);
  db.close();
});
