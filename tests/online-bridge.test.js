import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHmac, createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { readConfig, shouldRunReconcileTimer } from '../server/config.js';
import { OnlineBridgeClient } from '../server/online-bridge-client.js';
import { saleEvent, localTransaction } from '../server/sale-events.js';
import Parser from 'php-parser';

const SITE = '72b1645b-bc7e-4be4-924d-3d3b9dbfbe89'; // Synthetic UUID only.
const TEST_SECRET = 'only-local-synthetic-secret-for-test-fixtures';
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const baseEnv = dir => ({ NODE_ENV: 'test', POS_MODE: 'staging', POS_DATA_DIR: dir,
  WOO_BASE_URL: 'https://127.0.0.1:3333', WOO_CONSUMER_KEY: 'fixture-key', WOO_CONSUMER_SECRET: 'fixture-secret',
  POS_STAGING_APPROVED: 'true', POS_STAGING_WHOLESALE_APPROVED: 'true', POS_REQUIRE_SHIFT: 'true',
  POS_ONLINE_BRIDGE_LOCAL_TEST: 'true', POS_ONLINE_BRIDGE_URL: 'http://127.0.0.1:4444',
  POS_ONLINE_BRIDGE_SITE_ID: SITE, POS_ONLINE_BRIDGE_APP_USER: 'isolated-fixture-service',
  POS_ONLINE_BRIDGE_APP_PASSWORD: 'local-application-password-only', POS_ONLINE_BRIDGE_SECRET: TEST_SECRET,
  POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'synthetic-original-secret-passphrase' });
const item = (variationId = 11, agreedUnitPrice) => ({ productId: 10, variationId, quantity: 1,
  ...(agreedUnitPrice == null ? {} : { agreedUnitPrice }) });
const cart = (variationId = 11, fields = {}) => ({ idempotencyKey: randomUUID(), items: [item(variationId)], ...fields });

function syntheticWoo() {
  const state = { parentStock: 1, variationStock: 1, variationIndependent: false, simpleStock: 3, price: '100.00' };
  const parent = () => ({ id: 10, name: 'Synthetic parent', type: 'variable', sku: 'PARENT', status: 'publish',
    price: state.price, manage_stock: true, stock_quantity: state.parentStock, stock_status: 'instock',
    backorders: 'no', backorders_allowed: false, sold_individually: false, purchasable: true });
  const variation = id => ({ id, parent_id: 10, status: 'publish', price: state.price,
    sku: `VAR-${id}`, manage_stock: id === 12 && state.variationIndependent ? true : 'parent',
    stock_quantity: id === 12 && state.variationIndependent ? state.variationStock : state.parentStock,
    stock_status: 'instock',
    backorders: 'no', backorders_allowed: false, purchasable: true, attributes: [{ name: 'Size', option: id === 11 ? 'S' : 'M' }] });
  return { state,
    async product(id) { return id === 10 ? parent() : { id: 20, name: 'Synthetic simple', type: 'simple',
      status: 'publish', sku: 'SIMPLE', price: '30.00', manage_stock: true, stock_quantity: state.simpleStock,
      stock_status: 'instock', backorders: 'no', backorders_allowed: false, purchasable: true }; },
    async variation(_id, id) { return variation(id); },
    async products() { return { data: [parent()], total: 1, pages: 1 }; },
    async variations() { return { data: [variation(11), variation(12)], total: 2, pages: 1 }; },
  };
}

// Simulates ONLY the bridge protocol and core Woo's shared-owner conditional
// reservation. It does NOT execute PHP, MySQL, WP hooks or a real gateway.
function syntheticBridge(stock) {
  const records = new Map();
  const state = { creates: 0, cashIntents: 0, payments: 0, cancels: 0, reads: 0, loseIntent: false, loseCreate: false,
    losePay: false, loseCancel: false, down: false, wrongSite: false, mutateResponse: null };
  const view = record => {
    const current = record.state;
    const expired = ['reserved', 'cash_intent'].includes(current) && Date.parse(record.expiresAt) <= Date.now();
    const result = { siteId: state.wrongSite ? randomUUID() : SITE, service: 'staging', ledgerId: record.ledgerId,
      key: record.key, fingerprint: record.fingerprint,
      state: expired ? 'needs_review' : current, orderId: record.orderId,
      totalCents: record.totalCents, taxCents: record.taxCents,
      expiresAt: ['reserved', 'cash_intent'].includes(current) ? record.expiresAt : null,
      items: record.items.map(i => ({ ...i })), reservationVerified: current === 'reserved' && !expired,
       cashIntentVerified: current === 'cash_intent' && !expired && !record.stockTouched && !record.identityUnknown,
      paymentVerified: current === 'paid' && !record.paymentUnknown,
      cancelledVerified: current === 'cancelled', orderIdentityVerified: !record.identityUnknown,
      stockOrCashIntentObserved: current === 'paid' || current === 'cash_intent' || Boolean(record.stockTouched),
      paidAt: record.paidAt, refundedCents: record.refundedCents || 0 };
    return state.mutateResponse ? state.mutateResponse(result) : result;
  };
  return { records, state,
    async create(input) {
      if (state.down) throw new Error('Woo unavailable');
      const prior = records.get(input.key);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint || prior.ledgerId !== input.ledgerId) throw new Error('key conflict');
        return view(prior);
      }
      const amounts = new Map();
      for (const line of input.items) amounts.set(line.ownerId, (amounts.get(line.ownerId) || 0) + line.quantity);
      for (const [owner, qty] of amounts) {
        const held = [...records.values()].filter(r => ['reserved', 'cash_intent'].includes(r.state) && Date.parse(r.expiresAt) > Date.now())
          .reduce((sum, r) => sum + r.items.filter(i => i.ownerId === owner).reduce((n, i) => n + i.quantity, 0), 0);
        if ((owner === 10 ? stock.parentStock : owner === 12 ? stock.variationStock : stock.simpleStock) - held < qty) throw new Error('last unit already held');
      }
      state.creates++;
      const row = { ...input, orderId: 200 + state.creates, state: 'reserved',
        totalCents: input.items.reduce((sum, i) => sum + (i.agreedUnitCents ?? i.expectedUnitCents) * i.quantity, 0),
        taxCents: 0, items: input.items.map(i => ({ productId: i.productId, variationId: i.variationId,
          quantity: i.quantity, ownerId: i.ownerId, unitCents: i.expectedUnitCents,
          agreedUnitCents: i.agreedUnitCents ?? null, sku: i.sku,
          grossCents: (i.agreedUnitCents ?? i.expectedUnitCents) * i.quantity, taxCents: 0 })),
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), paidAt: null };
      records.set(input.key, row);
      if (state.loseCreate) { state.loseCreate = false; throw new Error('response lost after Woo saved hold'); }
      return view(row);
    },
    async status(key) {
      state.reads++;
      if (state.down) throw new Error('Woo unavailable');
      const record = records.get(key);
      if (!record) throw new Error('no mapping');
      return view(record);
    },
    async cashIntent(key) {
      if (state.down) throw new Error('Woo unavailable');
      const record = records.get(key);
      if (!record || record.state !== 'reserved' || Date.parse(record.expiresAt) - Date.now() < 90000) {
        throw new Error('Original stock reservation is not payable');
      }
      state.cashIntents++;
      record.state = 'cash_intent';
      if (state.loseIntent) { state.loseIntent = false; throw new Error('Original Woo cash-intent reply lost'); }
      return view(record);
    },
    async pay(key) {
      state.payments++;
      if (state.down) throw new Error('Woo unavailable');
      const record = records.get(key);
      if (!record || record.state !== 'cash_intent' || Date.parse(record.expiresAt) - Date.now() < 90000) throw new Error('cash intent not verified');
      record.state = 'paid'; record.paidAt = new Date().toISOString();
      for (const line of record.items) stock[line.ownerId === 10 ? 'parentStock' : line.ownerId === 12 ? 'variationStock' : 'simpleStock'] -= line.quantity;
      if (state.losePay) { state.losePay = false; throw new Error('response lost after Woo paid'); }
      return view(record);
    },
    async cancel(key) {
      state.cancels++;
      if (state.down) throw new Error('Woo unavailable');
      const record = records.get(key);
      if (!record || record.state !== 'reserved') throw new Error('not unpaid');
      record.state = 'cancelled';
      if (state.loseCancel) { state.loseCancel = false; throw new Error('response lost after cancel'); }
      return view(record);
    },
  };
}
async function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-online-synthetic-'));
  const woo = syntheticWoo();
  const bridge = syntheticBridge(woo.state);
  const env = { ...baseEnv(dir), ...options.env };
  let instance = createApp({ env, api: woo, bridge, logger });
  let server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (endpoint, { method = 'GET', body, token } = {}) => {
    const response = await fetch(`${origin}/api${endpoint}`, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const login = await request('/auth/login', { method: 'POST', body: { username: 'owner', password: env.POS_OWNER_PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const token = login.data.token;
  assert.equal((await request('/auth/password', { method: 'POST', token, body: {
    currentPassword: env.POS_OWNER_PASSWORD, newPassword: 'synthetic-rotated-secret-passphrase' } })).status, 200);
  assert.equal((await request('/shifts/open', { method: 'POST', token, body: { openingFloat: 5000 } })).status, 201);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { woo, bridge, env, dir, request, token, get db() { return instance.db; },
    get config() { return instance.config; },
    async restart() {
      await new Promise(resolve => server.close(resolve)); instance.db.close();
      instance = createApp({ env, api: woo, bridge, logger });
      server = instance.app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      origin = `http://127.0.0.1:${server.address().port}`;
    } };
}
const post = (h, endpoint, body = {}) => h.request(endpoint, { method: 'POST', token: h.token, body });
const prepare = (h, body) => post(h, '/sales/prepare', body);
const pay = (h, id, tendered = 12000) => post(h, `/sales/${id}/pay`, { method: 'cash', tendered, confirmed: true });
const read = (h, id) => h.request(`/sales/${id}/online-status`, { token: h.token });

test('local-only gate refuses production, live pilot, remote URL, missing shift/credentials and old approvals', () => {
  const config = readConfig({ POS_MODE: 'live', POS_LIVE_READ_ONLY: 'true' });
  assert.equal(config.onlineBridgeLocalTest, false);
  assert.equal(config.paymentMethods.length, 1);
  assert.equal(shouldRunReconcileTimer(config), false, 'the read-only pilot never polls Woo orders');
  const env = baseEnv('/tmp/never-create');
  for (const patch of [
    { NODE_ENV: 'production' }, { POS_MODE: 'live', WOO_BASE_URL: 'https://www.mansutrendzgh.com' },
    { WOO_BASE_URL: 'https://www.mansutrendzgh.com' },
    { POS_ONLINE_BRIDGE_URL: 'http://production.example.com' },
    { POS_ONLINE_BRIDGE_URL: 'http://localhost:4444' },
    { POS_ONLINE_BRIDGE_URL: 'https://127.0.0.1:4444/?remote=yes' },
    { POS_REQUIRE_SHIFT: 'false' }, { POS_STAGING_APPROVED: 'false' },
    { POS_ONLINE_BRIDGE_SECRET: 'short' }, { POS_ONLINE_BRIDGE_SITE_ID: 'not-a-uuid' },
  ]) assert.throws(() => readConfig({ ...env, ...patch }), /bridge|Staging|staging|Live|live/i);
  assert.equal(readConfig(env).onlineBridgeLocalTest, true);
  assert.deepEqual(readConfig(env).paymentMethods, ['cash']);
  assert.equal(shouldRunReconcileTimer(readConfig(env)), false, 'an active bridge never runs legacy sweeps');
  assert.equal(shouldRunReconcileTimer(readConfig({ ...env, POS_ONLINE_BRIDGE_LOCAL_TEST: 'false' })), true,
    'ordinary staging without bridge history keeps its existing sweep');
});

test('switching the bridge OFF quarantines its staging ledger instead of falling back to legacy Woo writes', async t => {
  const h = await harness(t);
  const sale = (await prepare(h, cart())).data.sale;
  // A historical legacy row must not be swept by the bulk reconciliation
  // endpoint when this same staging ledger contains any bridge attempt.
  const legacyId = randomUUID();
  const shiftId = h.db.prepare('SELECT shift_id FROM sales WHERE id=?').get(sale.id).shift_id;
  const created = new Date().toISOString();
  h.db.prepare(`INSERT INTO sales(id,idempotency_key,fingerprint,number,status,currency,cashier_id,cashier_name,
    items_json,created_at,updated_at,shift_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(legacyId, randomUUID(), 'historical-legacy-fixture', 'STG-OLD', 'needs_reconciliation',
      'GHS', sale.cashierId, sale.cashierName, '[]', created, created, shiftId);
  assert.deepEqual((await post(h, '/sales/reconcile-pending')).data, { checked: 0, reconciled: 0, failed: 0 });
  h.env.POS_ONLINE_BRIDGE_LOCAL_TEST = 'false';
  await h.restart();
  const session = await h.request('/session', { token: h.token });
  assert.equal(session.data.config.onlineBridgeLocalTest, false);
  assert.equal(session.data.config.onlineBridgeQuarantined, true);
  assert.equal(shouldRunReconcileTimer(h.config), false, 'bridge-off history cannot restart the legacy timer');
  assert.equal(session.data.config.writesEnabled, false);
  assert.deepEqual(session.data.config.paymentMethods, ['cash']);
  assert.equal((await h.request('/sales', { token: h.token })).data.sales.find(row => row.id === sale.id).onlineBridge, true);
  assert.deepEqual((await post(h, '/sales/reconcile-pending')).data, { checked: 0, reconciled: 0, failed: 0 });
  assert.equal(h.db.prepare('SELECT status,last_reconciled_at FROM sales WHERE id=?').get(legacyId).status, 'needs_reconciliation');
  assert.equal((await prepare(h, cart())).status, 403, 'legacy create must not replace a held Woo order');
  assert.equal((await pay(h, sale.id)).status, 403);
  assert.equal((await post(h, `/sales/${sale.id}/cancel`)).status, 403);
  assert.equal((await post(h, `/sales/${sale.id}/reconcile`)).status, 403);
  assert.equal((await read(h, sale.id)).status, 403);
  assert.equal((await post(h, `/sales/${sale.id}/confirm-cash`)).status, 403);
  assert.equal(h.bridge.state.creates, 1);
  assert.equal(h.bridge.state.payments, 0);
  assert.equal((await h.request('/shifts/current', { token: h.token })).data.shift.expectedCash, 5000);
});

test('signed local transport pins origin, no redirect or write retry, and verifies response envelope', async () => {
  const config = readConfig(baseEnv('/tmp/synthetic-only'));
  const seen = [];
  const key = randomUUID();
  const response = { siteId: SITE, service: 'staging', ledgerId: randomUUID(), key,
    fingerprint: 'a'.repeat(64), orderId: null, state: 'claimed', totalCents: 0, taxCents: 0,
    expiresAt: null, items: [], reservationVerified: false, cashIntentVerified: false, paymentVerified: false,
    cancelledVerified: false, orderIdentityVerified: false, stockOrCashIntentObserved: false,
    refundedCents: 0, paidAt: null };
  const client = new OnlineBridgeClient(config, async (url, init) => {
    seen.push({ url: url.href, init });
    return { ok: true, async text() { return JSON.stringify(response); } };
  });
  const status = await client.status(key);
  assert.equal(status.state, 'claimed');
  assert.equal(seen[0].url, `http://127.0.0.1:4444/wp-json/mansu-pos/v1/attempts/${key}`);
  assert.equal(seen[0].init.redirect, 'error');
  assert.match(seen[0].init.headers.Authorization, /^Basic /);
  const message = `${seen[0].init.headers['X-Mansu-Bridge-Timestamp']}\nGET\n/mansu-pos/v1/attempts/${key}\n${createHash('sha256').update('').digest('hex')}`;
  assert.equal(seen[0].init.headers['X-Mansu-Bridge-Signature'], createHmac('sha256', TEST_SECRET).update(message).digest('hex'));
  const broken = new OnlineBridgeClient(config, async () => ({ ok: true, async text() { return JSON.stringify({ ...response, siteId: randomUUID() }); } }));
  await assert.rejects(() => broken.status(key), /identity|incomplete/);
  const incomplete = new OnlineBridgeClient(config, async () => ({ ok: true, async text() {
    const missing = { ...response }; delete missing.orderIdentityVerified; return JSON.stringify(missing);
  } }));
  await assert.rejects(() => incomplete.status(key), /incomplete/);
  let attempted = 0;
  const failing = new OnlineBridgeClient(config, async () => { attempted++; throw new Error('timeout'); });
  await assert.rejects(() => failing.pay(key), /timed out/);
  assert.equal(attempted, 1);
});

test('concurrent parent-managed options share last unit; no local stock pool or second Woo order for a key', async t => {
  const h = await harness(t);
  const first = cart(11); const second = cart(12);
  const [one, two] = await Promise.all([prepare(h, first), prepare(h, second)]);
  assert.deepEqual([one.status, two.status].sort(), [201, 502]);
  const sale = [one, two].find(result => result.status === 201).data.sale;
  assert.equal(h.bridge.state.creates, 1);
  assert.equal(h.woo.state.parentStock, 1, 'a hold does not decrement raw Woo stock');
  assert.equal(h.bridge.records.get(sale.id === h.db.prepare('SELECT id FROM sales WHERE idempotency_key=?').get(first.idempotencyKey)?.id ? first.idempotencyKey : second.idempotencyKey).items[0].ownerId, 10);
  const replay = await prepare(h, sale.id === h.db.prepare('SELECT id FROM sales WHERE idempotency_key=?').get(first.idempotencyKey)?.id ? first : second);
  assert.equal(replay.status, 201);
  assert.equal(replay.data.sale.id, sale.id);
  assert.equal(h.bridge.state.creates, 1);
  assert.equal((await prepare(h, { ...first, items: [item(12)] })).status, 409, 'fingerprint conflict cannot change a held order');
  assert.equal((await post(h, '/sales/reconcile-pending')).data.checked, 0, 'legacy Woo order search must skip new attempts');
});

test('an independently managed variation is a separate Woo stock owner from its parent pool', async t => {
  const h = await harness(t);
  h.woo.state.variationIndependent = true;
  const parent = await prepare(h, cart(11));
  const child = await prepare(h, cart(12));
  assert.equal(parent.status, 201);
  assert.equal(child.status, 201);
  assert.equal(h.bridge.state.creates, 2);
  assert.deepEqual([...h.bridge.records.values()].map(record => record.items[0].ownerId).sort(), [10, 12]);
  assert.equal(h.woo.state.parentStock, 1);
  assert.equal(h.woo.state.variationStock, 1);
});

test('lost create reply and restart recover same mapping through read-only status, never POST a second order', async t => {
  const h = await harness(t);
  h.bridge.state.loseCreate = true;
  const input = cart();
  const first = await prepare(h, input);
  assert.equal(first.status, 502);
  assert.equal(h.bridge.state.creates, 1);
  const row = h.db.prepare('SELECT * FROM sales WHERE idempotency_key=?').get(input.idempotencyKey);
  assert.equal(row.status, 'needs_reconciliation');
  assert.equal(row.woo_order_id, null);
  await h.restart();
  assert.equal((await prepare(h, input)).status, 409);
  const before = await read(h, row.id);
  assert.equal(before.status, 200);
  assert.equal(before.data.bridge.reservationVerified, true);
  assert.equal(h.db.prepare('SELECT woo_order_id FROM sales WHERE id=?').get(row.id).woo_order_id, null, 'GET is pure read');
  const recovered = await post(h, `/sales/${row.id}/reconcile`);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.equal(recovered.data.sale.status, 'awaiting_payment');
  assert.equal(recovered.data.sale.wooOrderId, 201);
  assert.equal(h.bridge.state.creates, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event=?').get(row.id, 'online.order_recovered').n, 1);
});

test('lost Woo cash-intent acknowledgement quarantines the original order without taking or repeating cash', async t => {
  const h = await harness(t);
  const sale = (await prepare(h, cart())).data.sale;
  h.bridge.state.loseIntent = true;
  const result = await pay(h, sale.id);
  assert.equal(result.status, 502);
  assert.equal(h.bridge.state.cashIntents, 1);
  assert.equal(h.bridge.state.payments, 0);
  assert.equal(h.db.prepare('SELECT status FROM sales WHERE id=?').get(sale.id).status, 'needs_reconciliation');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='online.cash_intent_started'").get(sale.id).n, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='online.cash_accepted'").get(sale.id).n, 0);
  assert.equal((await h.request('/shifts/current', { token: h.token })).data.shift.expectedCash, 5000);
  assert.equal((await pay(h, sale.id)).status, 409);
  assert.equal((await post(h, `/sales/${sale.id}/cancel`)).status, 409);
  assert.equal((await read(h, sale.id)).data.bridge.cashCollectionAllowed, false);
  assert.equal((await post(h, `/sales/${sale.id}/reconcile`)).data.sale.status, 'needs_reconciliation');
  assert.equal(h.bridge.state.cashIntents, 1);
});

test('cash custody is counted once before Woo verification; lost paid response recovers receipt without replay', async t => {
  const h = await harness(t);
  const sale = (await prepare(h, cart())).data.sale;
  assert.equal(sale.onlineBridge, true);
  assert.equal((await h.request('/sales', { token: h.token })).data.sales.find(s => s.id === sale.id).onlineBridge, true);
  const expected = (await h.request('/shifts/current', { token: h.token })).data.shift.expectedCash;
  assert.equal(expected, 5000);
  h.bridge.state.losePay = true;
  const uncertain = await pay(h, sale.id);
  assert.equal(uncertain.status, 502);
  assert.equal(h.bridge.state.payments, 1);
  assert.equal(h.woo.state.parentStock, 0);
  assert.equal((await h.request('/shifts/current', { token: h.token })).data.shift.expectedCash, 15000);
  assert.equal((await h.request('/shifts/current', { token: h.token })).data.shift.summary.pendingCash, 10000);
  assert.equal((await pay(h, sale.id)).status, 409);
  assert.equal(h.bridge.state.payments, 1, 'never retry Woo payment_complete after a lost reply');
  assert.equal((await post(h, `/sales/${sale.id}/cancel`)).status, 409);
  assert.equal((await read(h, sale.id)).data.bridge.paymentVerified, true);
  const paid = await post(h, `/sales/${sale.id}/reconcile`);
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.sale.status, 'paid');
  assert.ok(paid.data.sale.paidAt);
  assert.equal((await h.request('/shifts/current', { token: h.token })).data.shift.expectedCash, 15000);
  assert.equal((await h.request('/shifts/current', { token: h.token })).data.shift.summary.pendingCash, 0);
  assert.equal((await post(h, `/sales/${sale.id}/reconcile`)).data.sale.status, 'paid');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='online.cash_accepted'").get(sale.id).n, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='online.payment_verified'").get(sale.id).n, 1);
  const receipt = await h.request('/sales', { token: h.token });
  assert.ok(receipt.data.sales.find(item => item.id === sale.id && item.status === 'paid' && item.paidAt));
});

test('a missing durable order link or earlier custody/cancel marker never reopens cash collection', async t => {
  const h = await harness(t);
  const sale = (await prepare(h, cart())).data.sale;
  h.db.prepare('UPDATE sales SET woo_order_id=NULL WHERE id=?').run(sale.id);
  const unlinked = await read(h, sale.id);
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.data.bridge.cashCollectionAllowed, false);
  assert.equal((await pay(h, sale.id)).status, 409);
  assert.equal((await post(h, `/sales/${sale.id}/cancel`)).status, 409);
  assert.equal(h.bridge.state.payments, 0);
  assert.equal(h.bridge.state.cancels, 0);
  h.db.prepare('UPDATE sales SET woo_order_id=? WHERE id=?').run(sale.wooOrderId, sale.id);
  localTransaction(h.db, () => saleEvent(h.db, sale.id, 'online.cash_accepted', 'system', { amountCents: sale.total }));
  assert.equal((await read(h, sale.id)).data.bridge.cashCollectionAllowed, false);
  assert.equal((await pay(h, sale.id)).status, 409);
  assert.equal((await post(h, `/sales/${sale.id}/cancel`)).status, 409);
  assert.equal(h.bridge.state.payments, 0);
  assert.equal(h.bridge.state.cancels, 0);
});


test('a committed cash intent blocks stale checkout, cancellation and a cancelled recovery verdict', async t => {
  const h = await harness(t);
  const sale = (await prepare(h, cart())).data.sale;
  // The persisted sale status may be stale, but an append-only intent cannot be ignored.
  localTransaction(h.db, () => saleEvent(h.db, sale.id, 'online.cash_intent_started', 'system',
    { wooOrderId: sale.wooOrderId, amountCents: sale.total }));
  assert.equal(h.db.prepare('SELECT status FROM sales WHERE id=?').get(sale.id).status, 'awaiting_payment');
  const status = await read(h, sale.id);
  assert.equal(status.status, 200);
  assert.equal(status.data.bridge.reservationVerified, true);
  assert.equal(status.data.bridge.cashCollectionAllowed, false);
  assert.equal((await pay(h, sale.id)).status, 409);
  assert.equal((await post(h, `/sales/${sale.id}/cancel`)).status, 409);
  assert.equal(h.bridge.state.cashIntents, 0);
  assert.equal(h.bridge.state.payments, 0);
  assert.equal(h.bridge.state.cancels, 0);
  assert.equal((await post(h, `/sales/${sale.id}/reconcile`)).data.sale.status, 'needs_reconciliation');
  h.db.prepare("UPDATE sales SET status='awaiting_payment' WHERE id=?").run(sale.id);
  const key = h.db.prepare('SELECT idempotency_key FROM sales WHERE id=?').get(sale.id).idempotency_key;
  h.bridge.records.get(key).state = 'cancelled'; // A simulated external cancel is not proof no cash was taken.
  const response = await post(h, `/sales/${sale.id}/reconcile`);
  assert.equal(response.status, 200);
  assert.equal(response.data.sale.status, 'needs_reconciliation');
  assert.equal(h.bridge.state.cancels, 0);
});

test('a remote paid signal cannot create a POS receipt without the original local intent event', async t => {
  const h = await harness(t);
  const sale = (await prepare(h, cart())).data.sale;
  localTransaction(h.db, () => {
    h.db.prepare("UPDATE sales SET status='needs_reconciliation',payment_method='cash',tendered=?,change_due=? WHERE id=?")
      .run(sale.total + 2000, 2000, sale.id);
    saleEvent(h.db, sale.id, 'online.cash_accepted', 'system', { wooOrderId: sale.wooOrderId, amountCents: sale.total });
    saleEvent(h.db, sale.id, 'online.payment_started', 'system', { wooOrderId: sale.wooOrderId, amountCents: sale.total });
  });
  const key = h.db.prepare('SELECT idempotency_key FROM sales WHERE id=?').get(sale.id).idempotency_key;
  Object.assign(h.bridge.records.get(key), { state: 'paid', paidAt: new Date().toISOString() });
  const response = await post(h, `/sales/${sale.id}/reconcile`);
  assert.equal(response.status, 200);
  assert.equal(response.data.sale.status, 'needs_reconciliation');
  assert.equal(response.data.sale.paidAt, null);
  assert.equal(h.bridge.state.payments, 0);
});

test('Woo paid evidence cannot make a receipt after the local cash amount becomes unprovable', async t => {
  const h = await harness(t);
  const sale = (await prepare(h, cart())).data.sale;
  assert.equal((await pay(h, sale.id)).data.sale.status, 'paid');
  h.db.prepare('UPDATE sales SET tendered=NULL WHERE id=?').run(sale.id);
  const checked = await post(h, `/sales/${sale.id}/reconcile`);
  assert.equal(checked.status, 200);
  assert.equal(checked.data.sale.status, 'needs_reconciliation');
  assert.ok(checked.data.sale.paidAt, 'historical evidence is preserved, not erased');
  assert.equal((await pay(h, sale.id)).status, 409);
  assert.equal(h.bridge.state.payments, 1, 'no second Woo payment');
});

test('a paid replay checks Woo again and blocks a stale receipt without another cash/stock write', async t => {
  const h = await harness(t);
  const sale = (await prepare(h, cart())).data.sale;
  assert.equal((await pay(h, sale.id)).data.sale.status, 'paid');
  assert.equal(h.bridge.state.payments, 1);
  const record = [...h.bridge.records.values()][0];
  record.paymentUnknown = true;
  const stale = await pay(h, sale.id);
  assert.notEqual(stale.status, 200, 'an old local paid row is not current Woo proof');
  assert.equal(h.db.prepare('SELECT status FROM sales WHERE id=?').get(sale.id).status, 'needs_reconciliation');
  assert.equal(h.bridge.state.payments, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='online.cash_accepted'").get(sale.id).n, 1);
  assert.equal((await h.request('/shifts/current', { token: h.token })).data.shift.expectedCash, 15000);
  record.paymentUnknown = false;
  const verified = await post(h, `/sales/${sale.id}/reconcile`);
  assert.equal(verified.data.sale.status, 'paid');
  assert.equal(h.bridge.state.payments, 1, 'recovery uses status only');
});

test('shift cannot close over an unresolved cash intent with stale failed or forged paid sale status', async t => {
  const h = await harness(t);
  const sale = (await prepare(h, cart())).data.sale;
  const shiftId = h.db.prepare('SELECT shift_id FROM sales WHERE id=?').get(sale.id).shift_id;
  localTransaction(h.db, () => {
    saleEvent(h.db, sale.id, 'online.cash_intent_started', 'system', {
      wooOrderId: sale.wooOrderId, amountCents: sale.total,
    });
    h.db.prepare("UPDATE sales SET status='failed' WHERE id=?").run(sale.id);
  });
  const first = await h.request('/shifts/current', { token: h.token });
  assert.equal(first.status, 200);
  assert.equal(first.data.shift.summary.pendingCashIntentOrders, 1);
  assert.equal(first.data.shift.expectedCash, 5000, 'intent alone does not mean cash was collected');
  assert.equal((await post(h, `/shifts/${shiftId}/close`, { closingCash: 5000 })).status, 409);
  // A changed status/date still does not prove that the physical money was
  // received or Woo stock/payment reached the original verified paid order.
  h.db.prepare("UPDATE sales SET status='paid',paid_at=?,payment_method='cash' WHERE id=?")
    .run(new Date().toISOString(), sale.id);
  const second = await h.request('/shifts/current', { token: h.token });
  assert.equal(second.data.shift.summary.pendingCashIntentOrders, 1);
  assert.equal((await post(h, `/shifts/${shiftId}/close`, { closingCash: 15000 })).status, 409);
  assert.equal(h.db.prepare('SELECT status FROM shifts WHERE id=?').get(shiftId).status, 'open');
});

test('a fully verified Woo cash sale permits closing its original shift exactly once', async t => {
  const h = await harness(t);
  const sale = (await prepare(h, cart())).data.sale;
  const shiftId = h.db.prepare('SELECT shift_id FROM sales WHERE id=?').get(sale.id).shift_id;
  const completed = await pay(h, sale.id);
  assert.equal(completed.status, 200);
  assert.equal(completed.data.sale.status, 'paid');
  const before = await h.request('/shifts/current', { token: h.token });
  assert.equal(before.data.shift.summary.pendingCashIntentOrders, 0);
  assert.equal(before.data.shift.expectedCash, 15000);
  const closed = await post(h, `/shifts/${shiftId}/close`, { closingCash: 15000 });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.shift.status, 'closed');
  assert.equal(closed.data.shift.summary.pendingCashIntentOrders, 0);
  assert.equal((await post(h, `/shifts/${shiftId}/close`, { closingCash: 15000 })).status, 409);
});

test('Woo downtime before cash does not count funds, after cash it blocks shift close, repeat pay and auto-cancel', async t => {
  const h = await harness(t);
  const sale = (await prepare(h, cart())).data.sale;
  h.bridge.state.down = true;
  assert.equal((await pay(h, sale.id)).status, 409);
  assert.equal(h.db.prepare('SELECT tendered FROM sales WHERE id=?').get(sale.id).tendered, null);
  assert.equal((await h.request('/shifts/current', { token: h.token })).data.shift.expectedCash, 5000);
  h.bridge.state.down = false;
  assert.equal((await post(h, `/sales/${sale.id}/reconcile`)).data.sale.status, 'awaiting_payment');
  h.bridge.state.down = true;
  // Force a crash boundary after the physical cash was recorded, before a
  // remote payment intent; the original shift cannot be closed.
  localTransaction(h.db, () => {
    h.db.prepare("UPDATE sales SET payment_method='cash',tendered=10000,change_due=0,status='needs_reconciliation' WHERE id=?").run(sale.id);
    saleEvent(h.db, sale.id, 'online.cash_intent_started', 'system', { amountCents: 10000 });
    saleEvent(h.db, sale.id, 'online.cash_accepted', 'system', { amountCents: 10000 });
  });
  assert.equal((await h.request('/shifts/current', { token: h.token })).data.shift.expectedCash, 15000);
  const shiftId = h.db.prepare('SELECT shift_id FROM sales WHERE id=?').get(sale.id).shift_id;
  // This crash fixture represents an acknowledged Woo intent with a lost POS
  // continuation, not an unverified remote intent.
  h.bridge.records.get(h.db.prepare('SELECT idempotency_key FROM sales WHERE id=?').get(sale.id).idempotency_key).state = 'cash_intent';
  assert.equal((await post(h, `/shifts/${shiftId}/close`, { closingCash: 15000 })).status, 409);
  assert.equal((await pay(h, sale.id, 10000)).status, 409);
  assert.equal((await post(h, `/sales/${sale.id}/confirm-cash`)).status, 502, 'unknown Woo state is not remotely paid');
  assert.equal(h.bridge.state.payments, 0);
  h.bridge.state.down = false;
  const finished = await post(h, `/sales/${sale.id}/confirm-cash`);
  assert.equal(finished.status, 200, JSON.stringify(finished.data));
  assert.equal(finished.data.sale.status, 'paid');
  assert.equal(h.bridge.state.payments, 1);
});

test('unpaid cancel is one-time and releases parent hold; cancelled and expired attempts cannot take cash', async t => {
  const h = await harness(t);
  const input = cart();
  const sale = (await prepare(h, input)).data.sale;
  const cancelled = await post(h, `/sales/${sale.id}/cancel`);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.sale.status, 'cancelled');
  assert.equal((await post(h, `/sales/${sale.id}/cancel`)).status, 200);
  assert.equal(h.bridge.state.cancels, 1);
  assert.equal((await pay(h, sale.id)).status, 409);
  assert.equal((await prepare(h, { ...input, idempotencyKey: randomUUID() })).status, 201, 'released stock is sellable to a NEW approved intent');
  const other = h.db.prepare("SELECT * FROM sales WHERE status='awaiting_payment'").get();
  h.bridge.records.get(other.idempotency_key).expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await read(h, other.id)).data.bridge.reservationVerified, false);
  assert.equal((await pay(h, other.id)).status, 409);
  assert.equal(h.db.prepare('SELECT payment_method FROM sales WHERE id=?').get(other.id).payment_method, null);
});

test('wholesale approval, all-in quote, price/owner drift and unknown paid state fail closed', async t => {
  const h = await harness(t);
  const input = cart(11, { saleType: 'wholesale', wholesaleApproved: true,
    items: [item(11, 7200)], buyerName: 'Synthetic Buyer' });
  const prepared = await prepare(h, input);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
  assert.equal(prepared.data.sale.total, 7200);
  assert.equal(prepared.data.sale.agreedTotal, 7200);
  const key = input.idempotencyKey;
  assert.match(h.bridge.records.get(key).quoteHash, /^[a-f0-9]{64}$/);
  h.bridge.state.mutateResponse = r => ({ ...r, items: r.items.map(i => ({ ...i, ownerId: 999 })) });
  assert.equal((await pay(h, prepared.data.sale.id, 7200)).status, 409);
  assert.equal(h.db.prepare('SELECT tendered FROM sales WHERE id=?').get(prepared.data.sale.id).tendered, null);
  h.bridge.state.mutateResponse = null;
  assert.equal((await post(h, `/sales/${prepared.data.sale.id}/reconcile`)).data.sale.status, 'awaiting_payment');
  h.bridge.state.mutateResponse = r => ({ ...r, totalCents: r.totalCents + 1 });
  assert.equal((await pay(h, prepared.data.sale.id, 7200)).status, 409);
  assert.equal(h.bridge.state.payments, 0);
  h.bridge.state.mutateResponse = null;
  assert.equal((await prepare(h, { ...input, idempotencyKey: randomUUID(), items: [item(11, 6000)] })).status, 502,
    'a second wholesale quote cannot reserve the same last unit');
  const remote = h.bridge.records.get(key);
  remote.paymentUnknown = true; remote.state = 'paid'; remote.paidAt = new Date().toISOString();
  const observed = await post(h, `/sales/${prepared.data.sale.id}/reconcile`);
  assert.equal(observed.data.sale.status, 'needs_reconciliation', 'paid without POS cash intent/stock proof cannot produce receipt');
  assert.equal(observed.data.sale.paidAt, null);
});

test('two POS service instances sharing one SQLite ledger record cash and dispatch Woo pay at most once', async t => {
  const h = await harness(t);
  // Two independent connections/services simulate cross-process interleaving;
  // no installed Woo, OS process crash or actual multi-host lock is proven.
  const other = createApp({ env: h.env, api: h.woo, bridge: h.bridge, logger });
  const server = other.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); other.db.close(); });
  const payFromOther = async id => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sales/${id}/pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
      body: JSON.stringify({ method: 'cash', tendered: 12000, confirmed: true }),
    });
    return { status: response.status, data: await response.json() };
  };
  const sale = (await prepare(h, cart())).data.sale;
  const originalStatus = h.bridge.status.bind(h.bridge);
  let arrivals = 0; let release;
  const together = new Promise(resolve => { release = resolve; });
  const fallback = setTimeout(release, 1000);
  h.bridge.status = async key => {
    if (++arrivals <= 2) { if (arrivals === 2) { clearTimeout(fallback); release(); } await together; }
    return originalStatus(key);
  };
  const result = await Promise.all([pay(h, sale.id), payFromOther(sale.id)]);
  assert.equal(arrivals >= 2, true, 'both service instances reached the pre-cash read');
  assert.deepEqual(result.map(r => r.status).sort(), [200, 409], JSON.stringify(result));
  assert.equal(h.bridge.state.payments, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='online.cash_accepted'").get(sale.id).n, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id=? AND event='online.payment_started'").get(sale.id).n, 1);
  assert.equal((await h.request('/shifts/current', { token: h.token })).data.shift.expectedCash, 15000);
});

test('PHP bridge parses and keeps activation, service auth and reservation hooks gated (NOT execution proof)', () => {
  const source = fs.readFileSync(new URL('../woocommerce/mansu-online-bridge/mansu-online-bridge.php', import.meta.url), 'utf8');
  const program = new Parser.Engine({ parser: { suppressErrors: false, php7: true } }).parseCode(source);
  assert.ok(program.children.length > 20);
  for (const token of ["$environment === 'local'", 'MANSU_ONLINE_BRIDGE_LIVE_ACCEPTED', 'MANSU_ONLINE_BRIDGE_SITE_HOST',
    "current_user_can( 'mansu_online_bridge' )",
    'hash_hmac( ', 'reserve_stock_for_order( $order, MANSU_ONLINE_HOLD_MINUTES )',
    "'mansu_online_expire'", 'wc_release_stock_for_order( $order )']) assert.ok(source.includes(token), token);
  assert.doesNotMatch(source, /UPDATE\s+(?:\$wpdb->postmeta|wp_postmeta|.*_stock\s*=)/i,
    'the bridge never directly updates Woo inventory tables');
});
