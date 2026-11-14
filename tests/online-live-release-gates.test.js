import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { ledgerInfo } from '../server/ledger-identity.js';
import { readConfig, publicConfig, shouldRunReconcileTimer } from '../server/config.js';
import { WooCommerce } from '../server/woocommerce.js';
import { OnlineBridgeClient } from '../server/online-bridge-client.js';

const SITE_ID = '72b1645b-bc7e-4be4-924d-3d3b9dbfbe89';
const SECRET = 'synthetic-bridge-secret-without-real-site-credentials';
const LIVE_STORE = 'https://www.mansutrendzgh.com';
const liveEnv = {
  NODE_ENV: 'production', POS_MODE: 'live', POS_LIVE_READ_ONLY: 'false',
  WOO_BASE_URL: LIVE_STORE, WOO_CONSUMER_KEY: 'ck_synthetic_read_only', WOO_CONSUMER_SECRET: 'cs_synthetic',
  POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com', POS_REQUIRE_SHIFT: 'true',
  POS_ALLOW_LIVE_WRITES: 'true', POS_OWNER_APPROVAL_REFERENCE: 'synthetic-owner-approval-reference',
  POS_ONLINE_BRIDGE_LIVE_ENABLED: 'true',
  POS_ONLINE_BRIDGE_LIVE_ACCEPTANCE_REFERENCE: 'separate-synthetic-site-acceptance-reference',
  POS_ONLINE_BRIDGE_URL: LIVE_STORE, POS_ONLINE_BRIDGE_SITE_ID: SITE_ID,
  POS_ONLINE_BRIDGE_APP_USER: 'synthetic-dedicated-wp-service',
  POS_ONLINE_BRIDGE_APP_PASSWORD: 'synthetic-app-password-not-real',
  POS_ONLINE_BRIDGE_SECRET: SECRET, POS_OWNER_USERNAME: 'owner',
  POS_OWNER_PASSWORD: 'synthetic-only-owner-secret',
};

test('copying legacy production approvals cannot activate the new bridge', () => {
  const config = readConfig({ ...liveEnv, POS_ONLINE_BRIDGE_LIVE_ENABLED: 'false' });
  assert.equal(config.legacyLiveCheckoutBlocked, true);
  assert.equal(config.onlineBridgeEnabled, false);
  assert.equal(config.onlineBridgeLiveEnabled, false);
  assert.equal(config.writesEnabled, false);
  assert.equal(config.wholesaleWritesEnabled, false);
  assert.equal(shouldRunReconcileTimer(config), false);
  assert.equal(publicConfig(config).onlineBridgeEnabled, false);
});

test('separate release acceptance binds the future live profile to trading, cash, HTTPS and v9 service identity', () => {
  const config = readConfig(liveEnv);
  assert.equal(config.mode, 'live');
  assert.equal(config.production, true);
  assert.equal(config.legacyLiveCheckoutBlocked, true, 'generic REST order route remains a legacy risk even in bridge mode');
  assert.equal(config.writesEnabled, true);
  assert.equal(config.onlineBridgeLiveEnabled, true);
  assert.equal(config.onlineBridgeEnabled, true);
  assert.equal(config.onlineBridgeLocalTest, false);
  assert.equal(config.bridgeService, 'live-trading');
  assert.equal(config.bridgeUrl, LIVE_STORE);
  assert.equal(config.bridgeSiteId, SITE_ID);
  assert.equal(config.wholesaleWritesEnabled, false);
  assert.deepEqual(config.paymentMethods, ['cash']);
  assert.equal(shouldRunReconcileTimer(config), false, 'legacy Woo order sweep stays off');
  assert.equal(publicConfig(config).onlineBridgeEnabled, true);
  assert.equal(publicConfig(config).onlineBridgeLiveEnabled, true);
});

test('every critical release lock fails closed, including copied pilot or offline flags', () => {
  const unsafe = [
    { POS_ONLINE_BRIDGE_LIVE_ENABLED: 'banana' },
    { POS_ONLINE_BRIDGE_LIVE_ENABLED: 'false', POS_ALLOW_LIVE_WRITES: 'false' },
    { POS_LIVE_READ_ONLY: 'true' },
    { NODE_ENV: 'test' },
    { POS_OWNER_APPROVAL_REFERENCE: '' },
    { POS_REQUIRE_SHIFT: 'false' },
    { POS_ONLINE_BRIDGE_LIVE_ACCEPTANCE_REFERENCE: '' },
    { POS_ONLINE_BRIDGE_LIVE_ACCEPTANCE_REFERENCE: liveEnv.POS_OWNER_APPROVAL_REFERENCE },
    { POS_ONLINE_BRIDGE_URL: 'http://www.mansutrendzgh.com' },
    { POS_ONLINE_BRIDGE_URL: 'https://mansutrendzgh.com' },
    { POS_ONLINE_BRIDGE_URL: 'https://www.mansutrendzgh.com/path' },
    { POS_ONLINE_BRIDGE_SITE_ID: 'invalid' },
    { POS_ONLINE_BRIDGE_APP_USER: '' },
    { POS_ONLINE_BRIDGE_APP_PASSWORD: '' },
    { POS_ONLINE_BRIDGE_SECRET: 'short' },
    { POS_DESKTOP_RESERVATION_APPROVED: 'true' },
    { POS_DESKTOP_SETUP_APPROVED: 'true' },
    { POS_INSTORE_CASH_APPROVED: 'true' },
    { POS_ONLINE_BRIDGE_LOCAL_TEST: 'true' },
  ];
  for (const override of unsafe) {
    if (override.POS_ONLINE_BRIDGE_LIVE_ENABLED === 'false') continue; // Tested separately as a closed/disabled profile.
    assert.throws(() => readConfig({ ...liveEnv, ...override }), undefined, JSON.stringify(override));
  }
});

test('the generic WooCommerce REST transport never mutates orders while the reservation bridge owns writes', async () => {
  const config = readConfig(liveEnv);
  let sent = 0;
  const woo = new WooCommerce(config, async () => {
    sent++;
    return { ok: true, headers: { get: () => null }, async text() { return '{"id":123}'; } };
  });
  await assert.rejects(() => woo.createOrder({ status: 'pending' }), { status: 403 });
  await assert.rejects(() => woo.updateOrder(123, { status: 'processing' }), { status: 403 });
  assert.equal(sent, 0, 'no legacy REST write reached the network');
  assert.equal((await woo.product(123)).id, 123, 'catalogue read still works');
  assert.equal(sent, 1);
});

test('live bridge client uses pinned HTTPS origin, signed original key and live-trading response identity', async () => {
  const config = readConfig(liveEnv);
  const key = randomUUID();
  const response = {
    siteId: SITE_ID, service: 'live-trading', ledgerId: randomUUID(), key,
    fingerprint: 'a'.repeat(64), orderId: null, state: 'claimed', totalCents: 0, taxCents: 0,
    expiresAt: null, items: [], reservationVerified: false, cashIntentVerified: false,
    paymentVerified: false, cancelledVerified: false, orderIdentityVerified: false,
    stockOrCashIntentObserved: false, refundedCents: 0, paidAt: null,
  };
  let request;
  const client = new OnlineBridgeClient(config, async (url, options) => {
    request = { url: url.href, options };
    return { ok: true, async text() { return JSON.stringify(response); } };
  });
  assert.equal((await client.status(key)).state, 'claimed');
  assert.equal(request.url, `${LIVE_STORE}/wp-json/mansu-pos/v1/attempts/${key}`);
  assert.equal(request.options.redirect, 'error');
  const timestamp = request.options.headers['X-Mansu-Bridge-Timestamp'];
  const payloadDigest = createHash('sha256').update('').digest('hex');
  const expected = createHmac('sha256', SECRET)
    .update(`${timestamp}\nGET\n/mansu-pos/v1/attempts/${key}\n${payloadDigest}`).digest('hex');
  assert.equal(request.options.headers['X-Mansu-Bridge-Signature'], expected);
  const wrongService = new OnlineBridgeClient(config, async () => ({
    ok: true, async text() { return JSON.stringify({ ...response, service: 'staging' }); },
  }));
  await assert.rejects(() => wrongService.status(key), /identity|incomplete/);
  const wrongSite = new OnlineBridgeClient(config, async () => ({
    ok: true, async text() { return JSON.stringify({ ...response, siteId: randomUUID() }); },
  }));
  await assert.rejects(() => wrongSite.status(key), /identity|incomplete/);
});

test('read-only signed live bridge health exposes core prerequisites without creating an order', async () => {
  const config = readConfig(liveEnv);
  let calls = 0;
  const health = {
    kind: 'mansu-online-bridge-health', ok: true, service: 'live-trading',
    siteId: SITE_ID, ledgerId: randomUUID(), wooVersion: '11.0.1',
    corePrerequisitesOk: true, cashOnly: true, taxEnabled: true, hposEnabled: false,
  };
  const client = new OnlineBridgeClient(config, async (url, request) => {
    calls++;
    assert.equal(request.method, 'GET');
    assert.equal(request.body, undefined);
    assert.equal(url.href, `${LIVE_STORE}/wp-json/mansu-pos/v1/health`);
    assert.equal(request.redirect, 'error');
    assert.match(request.headers['X-Mansu-Bridge-Signature'], /^[a-f0-9]{64}$/);
    return { ok: true, async text() { return JSON.stringify(health); } };
  });
  assert.equal((await client.health()).ledgerId, health.ledgerId);
  assert.equal(calls, 1);
  const wrongLedger = new OnlineBridgeClient(config, async () => ({
    ok: true, async text() { return JSON.stringify({ ...health, ledgerId: 'invalid' }); },
  }));
  await assert.rejects(() => wrongLedger.health(), /health identity|prerequisites/);
  const wrongSite = new OnlineBridgeClient(config, async () => ({
    ok: true, async text() { return JSON.stringify({ ...health, siteId: randomUUID() }); },
  }));
  await assert.rejects(() => wrongSite.health(), /health identity|prerequisites/);
});

test('synthetic live-profile server diagnostics refuse missing or mismatched bridge before reporting readiness', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-live-release-smoke-'));
  let currentLedger = randomUUID();
  let healthReads = 0;
  let wooReads = 0;
  let remoteOrderWrites = 0;
  const fakeBridge = {
    async create() { remoteOrderWrites++; throw new Error('A bad bridge health check must never reach this write.'); },
    async cashIntent() { remoteOrderWrites++; throw new Error('A bad bridge health check must never reach a cash write.'); },
    async health() {
      healthReads++;
      return { kind: 'mansu-online-bridge-health', ok: true, service: 'live-trading',
        siteId: SITE_ID, ledgerId: currentLedger, wooVersion: '11.0.1',
        corePrerequisitesOk: true, cashOnly: true, taxEnabled: false, hposEnabled: false };
    },
  };
  const fakeWoo = {
    async request(resource, options = {}) {
      assert.equal(options.method || 'GET', 'GET');
      assert.ok(['products', 'orders'].includes(resource));
      wooReads++;
      return { total: resource === 'products' ? 12 : 0, data: [] };
    },
  };
  const { app, db, config } = createApp({
    env: { ...liveEnv, POS_DATA_DIR: dir, POS_OWNER_PASSWORD: 'H9!blue-orchid-concept-passphrase' },
    api: fakeWoo, bridge: fakeBridge,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(config.onlineBridgeEnabled, true);
  const identity = ledgerInfo(db);
  assert.equal(identity.version, 9);
  assert.equal(identity.service, 'live-trading');
  assert.ok(identity.ledgerId);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const missingReady = await fetch(`${base}/ready`);
  assert.equal(missingReady.status, 503, 'unverified live bridge cannot advertise readiness');
  assert.equal((await missingReady.json()).ok, false);
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: liveEnv.POS_PUBLIC_ORIGIN },
    body: JSON.stringify({ username: 'owner', password: 'H9!blue-orchid-concept-passphrase' }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  // Production bootstraps a temporary owner password. Do not bypass its
  // mandatory rotation merely to make the release-health test pass.
  const rotated = await fetch(`${base}/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: liveEnv.POS_PUBLIC_ORIGIN,
      Authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword: 'H9!blue-orchid-concept-passphrase',
      newPassword: 'Q7!silver-maple-isolated-store-passphrase' }),
  });
  assert.equal(rotated.status, 200);
  const denied = await fetch(`${base}/sales/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: liveEnv.POS_PUBLIC_ORIGIN,
      Authorization: `Bearer ${token}` },
    body: JSON.stringify({ idempotencyKey: randomUUID(), saleType: 'retail',
      items: [{ productId: 10, variationId: 11, quantity: 1 }] }),
  });
  assert.equal(denied.status, 503, 'no checkout when live bridge cannot verify its ledger');
  assert.equal((await denied.json()).code, 'BRIDGE_NOT_READY');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n, 0);
  assert.equal(remoteOrderWrites, 0, 'no Woo reservation or cash-intent write was dispatched');
  const diagnostics = async () => {
    const response = await fetch(`${base}/connection/diagnostics`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const mismatch = await diagnostics();
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.checks.find(c => c.name.startsWith('Woo reservation bridge')).ok, false);
  currentLedger = identity.ledgerId;
  const ready = await fetch(`${base}/ready`);
  assert.equal(ready.status, 200, 'a matching, signed trading bridge can report process readiness');
  assert.equal((await ready.json()).ok, true);
  const verified = await diagnostics();
  assert.equal(verified.ok, true);
  const health = verified.checks.find(c => c.name.startsWith('Woo reservation bridge'));
  assert.equal(health.ok, true);
  assert.match(health.detail, /Last-unit concurrency remains unverified/);
  assert.equal(healthReads, 5, 'readiness, rejected checkout, diagnostics and accepted readiness all use a fresh GET');
  assert.ok(wooReads >= 4);
  assert.equal(remoteOrderWrites, 0);
});
