// Phase 3 gate: trial, payment, renewal, failed payment and cancellation drive
// what a shop may do; the console is protected by password + authenticator.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createPlatform } from '../server/platform/platform.js';
import { computeAccess, addMonths, planPrice } from '../server/platform/billing.js';
import { totpCode, base32Decode, base32Encode, verifyTotp } from '../server/platform/admin-auth.js';
import { validPaystackSignature } from '../server/platform/paystack.js';

const BASE = 'mansupos.test';
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const SK = `sk_test_${'k'.repeat(40)}`;
const DAY = 86400000;

function fakePaystack() {
  const tx = new Map();
  return {
    secretKey: SK, testMode: true, tx, inits: [],
    async initialize(args) { this.inits.push(args); tx.set(args.reference, { status: 'abandoned', amount: args.amount, currency: 'GHS', reference: args.reference, customer: { customer_code: `CUS_${args.metadata.shop}` } }); return { authorization_url: `https://checkout.paystack.com/${args.reference}`, reference: args.reference }; },
    async verify(reference) { return tx.get(reference) || { status: 'failed' }; },
    async manageLink(code) { return { link: `https://paystack.com/manage/subscriptions/${code}` }; },
    async createPlan({ interval }) { return { plan_code: `PLN_${interval}` }; },
    pay(reference, over = {}) { Object.assign(tx.get(reference), { status: 'success', ...over }); return tx.get(reference); },
  };
}

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-billing-'));
  const sent = [];
  const paystack = fakePaystack();
  const product = { id: 10, name: 'Dress', type: 'variable', sku: 'D', price: '100.00', images: [], categories: [], status: 'publish', purchasable: true, manage_stock: false, stock_status: 'instock', backorders: 'no', permalink: 'https://x' };
  const variation = { id: 11, sku: 'D-M', price: '100.00', attributes: [{ name: 'Size', option: 'M' }], manage_stock: true, stock_quantity: 5, stock_status: 'instock', backorders: 'no', purchasable: true };
  const api = { async request() { return { data: [], total: 0, pages: 1 }; }, async products() { return { data: [product], total: 1, pages: 1 }; }, async variations() { return { data: [variation], total: 1, pages: 1 }; }, async product() { return product; }, async variation() { return variation; },
    async createOrder(b) { return { ...b, id: 9, number: '9', total: '100.00', total_tax: '0.00', currency: 'GHS', status: 'pending', line_items: b.line_items.map(i => ({ ...i, name: 'Dress', sku: 'D-M', price: 100, subtotal: '100.00', total: '100.00', total_tax: '0.00', meta_data: [] })), refunds: [] }; },
    async findOrderByKey() { return null; } };
  const platform = createPlatform({
    env: { NODE_ENV: 'test', PLATFORM_BASE_DOMAIN: BASE, PLATFORM_DATA_DIR: dir, PLATFORM_MASTER_KEY: randomBytes(32).toString('hex'), PLATFORM_SIGNUPS_PER_HOUR: '50' },
    logger: quiet, paystack, mailer: { async send(m) { sent.push(m); }, list: () => sent },
    appFactory: ({ env, logger, extend }) => createApp({ env, logger, extend, api }),
  });
  const server = http.createServer(platform.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (host, url, { method = 'GET', body, token, origin, cookie, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? null : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { Host: host, 'Content-Type': 'application/json', ...headers,
      ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let parsed = text; try { parsed = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode, data: parsed, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  const site = (url, opts = {}) => call(BASE, url, { origin: `https://${BASE}`, ...opts });
  async function shop(slug = 'amaboutique', username = 'ama') {
    await site('/api/signup', { method: 'POST', body: { shopName: `${slug} shop`, slug, storeUrl: `https://${slug}.example.com`, ownerName: 'Owner Name', email: `${username}@example.com`, phone: '', username, password: 'chosen-passphrase-123', acceptTerms: true } });
    const token = /#token=([A-Za-z0-9_-]+)/.exec(sent.at(-1).text)[1];
    assert.equal((await site('/api/signup/verify', { method: 'POST', body: { token } })).status, 201);
    const host = `${slug}.${BASE}`, origin = `https://${host}`;
    const record = platform.registry.bySlug(slug);
    platform.registry.setSecret(record.id, 'woo_key', `ck_${'a'.repeat(40)}`, 'test');
    platform.registry.setSecret(record.id, 'woo_secret', `cs_${'b'.repeat(40)}`, 'test');
    platform.registry.update(record.id, { stage: 'selling', features: { inventoryWrites: true, productWrites: true, returns: true } }, 'test');
    const login = await call(host, '/api/auth/login', { method: 'POST', origin, body: { username, password: 'chosen-passphrase-123' } });
    return { id: record.id, slug, host, origin, token: login.data.token };
  }
  const webhook = (body, secret = SK) => {
    const raw = JSON.stringify(body);
    return site('/api/paystack/webhook', { method: 'POST', raw, origin: undefined, headers: { 'x-paystack-signature': createHmac('sha512', secret).update(raw).digest('hex') } });
  };
  const session = async s => (await call(s.host, '/api/session', { token: s.token })).data.config;
  const timeTravel = (s, field, ms) => platform.registry.db.prepare(`UPDATE shops SET ${field}=? WHERE id=?`).run(new Date(Date.now() + ms).toISOString(), s.id);
  return { platform, paystack, call, site, shop, webhook, session, timeTravel, sent };
}

test('access follows trial, payment, grace and lapse; never deletes', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  const shop = over => ({ trialEndsAt: null, billing: { plan: 'growth', paidUntil: null, status: null }, ...over });
  const at = (s, offset) => computeAccess(s, { now: now + offset, graceDays: 7 }).state;
  const trial = shop({ trialEndsAt: '2026-12-10T00:00:00Z' });
  assert.equal(at(trial, 0), 'trial');
  assert.equal(at(trial, 12 * DAY), 'grace');
  assert.equal(at(trial, 17 * DAY), 'lapsed');
  assert.equal(computeAccess(trial, { now: now + 17 * DAY }).full, false);
  const paid = shop({ trialEndsAt: '2026-11-01T00:00:00Z', billing: { plan: 'starter', paidUntil: '2027-01-01T00:00:00Z', status: 'active' } });
  assert.equal(at(paid, 0), 'active');
  assert.equal(computeAccess(paid, { now }).plan, 'starter');
  assert.equal(at(shop({ billing: { status: 'comped' } }), 9e12), 'comped');
  assert.equal(at(shop({}), 0), 'unbilled');
  assert.equal(new Date(addMonths(Date.parse('2027-01-31T10:00:00Z'), 1)).toISOString(), '2027-02-28T10:00:00.000Z');
  assert.equal(planPrice('growth', 'annually'), 450000);
});

test('a lapsed shop keeps its data but cannot sell; paying restores selling at once', async t => {
  const h = await harness(t);
  const s = await h.shop();
  assert.equal((await h.session(s)).writesEnabled, true);
  assert.equal((await h.session(s)).platformBilling.state, 'trial');
  // Time passes with no registry change: the open shop still picks it up.
  h.timeTravel(s, 'trial_ends_at', -3 * DAY);
  assert.equal((await h.session(s)).platformBilling.state, 'grace');
  assert.equal((await h.session(s)).writesEnabled, true, 'grace still sells');
  h.timeTravel(s, 'trial_ends_at', -10 * DAY);
  const lapsed = await h.session(s);
  assert.equal(lapsed.platformBilling.state, 'lapsed');
  assert.equal(lapsed.writesEnabled, false);
  assert.equal(lapsed.liveReadOnly, true);
  assert.equal((await h.call(s.host, '/api/sales', { token: s.token })).status, 200, 'history still readable');
  assert.equal((await h.call(s.host, '/api/billing', { token: s.token })).status, 200, 'owner can still reach billing');
  const checkout = await h.call(s.host, '/api/billing/checkout', { method: 'POST', origin: s.origin, token: s.token, body: { plan: 'growth', interval: 'monthly' } });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.data));
  const reference = new URL(checkout.data.url).pathname.slice(1);
  h.paystack.pay(reference);
  const verified = await h.call(s.host, '/api/billing/verify', { method: 'POST', origin: s.origin, token: s.token, body: { reference } });
  assert.equal(verified.data.paid, true);
  const restored = await h.session(s);
  assert.equal(restored.platformBilling.state, 'active');
  assert.equal(restored.writesEnabled, true);
});

test('checkout charges our own price, verifies amount and currency, and counts each payment once', async t => {
  const h = await harness(t);
  const s = await h.shop();
  const other = await h.shop('kofistyles', 'kofi');
  const start = body => h.call(s.host, '/api/billing/checkout', { method: 'POST', origin: s.origin, token: s.token, body });
  const ref = res => new URL(res.data.url).pathname.slice(1);
  const verify = (shop, reference) => h.call(shop.host, '/api/billing/verify', { method: 'POST', origin: shop.origin, token: shop.token, body: { reference } });
  const first = await start({ plan: 'growth', interval: 'monthly' });
  assert.equal(h.paystack.inits.at(-1).amount, 45000);
  assert.deepEqual(h.paystack.inits.at(-1).channels, ['card', 'mobile_money']);
  assert.match(h.paystack.inits.at(-1).callbackUrl, /^https:\/\/amaboutique\.mansupos\.test\/\?billing=return$/);
  assert.equal((await start({ plan: 'growth', interval: 'monthly', amount: 1 })).status, 400, 'the browser cannot set the amount');
  assert.equal((await start({ plan: 'growth', interval: 'monthly', autoRenew: true })).data.code, 'NO_PLAN_CODE');
  // Underpaid and wrong-currency transactions do not count.
  h.paystack.pay(ref(first), { amount: 100 });
  assert.equal((await verify(s, ref(first))).data.paid, false);
  const second = await start({ plan: 'growth', interval: 'monthly' });
  h.paystack.pay(ref(second), { currency: 'USD' });
  assert.equal((await verify(s, ref(second))).data.paid, false);
  assert.equal((await verify(other, ref(second))).status, 404, 'another shop cannot claim this payment');
  // A good payment extends from the end of the trial, once.
  const good = await start({ plan: 'growth', interval: 'monthly' });
  h.paystack.pay(ref(good));
  const trialEnd = Date.parse(h.platform.registry.byId(s.id).trialEndsAt);
  assert.equal((await verify(s, ref(good))).data.paid, true);
  const paidUntil = h.platform.registry.byId(s.id).billing.paidUntil;
  assert.equal(paidUntil, new Date(addMonths(trialEnd, 1)).toISOString());
  await verify(s, ref(good));
  await h.webhook({ event: 'charge.success', data: h.paystack.tx.get(ref(good)) });
  assert.equal(h.platform.registry.byId(s.id).billing.paidUntil, paidUntil, 'replays do not extend again');
  // Annual: 10 months' price for 12 months.
  const year = await start({ plan: 'starter', interval: 'annually' });
  assert.equal(h.paystack.inits.at(-1).amount, 250000);
  h.paystack.pay(ref(year));
  await verify(s, ref(year));
  assert.equal(h.platform.registry.byId(s.id).billing.paidUntil, new Date(addMonths(Date.parse(paidUntil), 12)).toISOString());
});

test('webhooks: signature required; renewals, failed payments and cancellation tracked', async t => {
  const h = await harness(t);
  const s = await h.shop();
  assert.equal((await h.webhook({ event: 'charge.success', data: {} }, 'sk_test_wrong')).status, 401);
  assert.equal((await h.site('/api/paystack/webhook', { method: 'POST', raw: '{}', headers: { 'x-paystack-signature': 'abc' } })).status, 401);
  assert.equal(validPaystackSignature(SK, Buffer.from('{}'), createHmac('sha512', SK).update('{}').digest('hex')), true);
  // First payment by card with automatic renewal.
  h.platform.registry.setSetting('paystack_plan:growth:monthly', 'PLN_growth_m');
  const checkout = await h.call(s.host, '/api/billing/checkout', { method: 'POST', origin: s.origin, token: s.token, body: { plan: 'growth', interval: 'monthly', autoRenew: true } });
  assert.equal(h.paystack.inits.at(-1).plan, 'PLN_growth_m');
  assert.deepEqual(h.paystack.inits.at(-1).channels, ['card']);
  const reference = new URL(checkout.data.url).pathname.slice(1);
  const charge = h.paystack.pay(reference);
  assert.equal((await h.webhook({ event: 'charge.success', data: charge })).status, 200);
  const afterFirst = h.platform.registry.byId(s.id).billing;
  assert.equal(afterFirst.status, 'active');
  assert.equal(afterFirst.customerCode, 'CUS_amaboutique');
  assert.equal((await h.webhook({ event: 'subscription.create', data: { subscription_code: 'SUB_1', email_token: 'tok', customer: { customer_code: 'CUS_amaboutique' }, plan: { plan_code: 'PLN_growth_m' } } })).status, 200);
  assert.equal(h.platform.registry.byId(s.id).billing.subscriptionCode, 'SUB_1');
  // Renewal Paystack charged on its own (no checkout record): matched by plan + customer.
  const renewal = { status: 'success', currency: 'GHS', amount: 45000, reference: 'renew_1', plan: { plan_code: 'PLN_growth_m' }, customer: { customer_code: 'CUS_amaboutique' } };
  await h.webhook({ event: 'charge.success', data: renewal });
  const afterRenewal = h.platform.registry.byId(s.id).billing.paidUntil;
  assert.equal(afterRenewal, new Date(addMonths(Date.parse(afterFirst.paidUntil), 1)).toISOString());
  await h.webhook({ event: 'charge.success', data: { ...renewal, reference: 'renew_bad', amount: 100 } });
  await h.webhook({ event: 'charge.success', data: { ...renewal, reference: 'renew_other', customer: { customer_code: 'CUS_nobody' } } });
  assert.equal(h.platform.registry.byId(s.id).billing.paidUntil, afterRenewal, 'wrong amount or unknown customer ignored');
  await h.webhook({ event: 'invoice.payment_failed', data: { invoice_code: 'INV_1', subscription: { subscription_code: 'SUB_1' } } });
  assert.equal(h.platform.registry.byId(s.id).billing.status, 'past_due');
  await h.webhook({ event: 'subscription.not_renew', data: { subscription_code: 'SUB_1' } });
  const cancelled = h.platform.registry.byId(s.id).billing;
  assert.equal(cancelled.autoRenew, false);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await h.session(s)).platformBilling.state, 'active', 'already-paid time is kept after cancelling');
  const manage = await h.call(s.host, '/api/billing/manage', { method: 'POST', origin: s.origin, token: s.token, body: {} });
  assert.match(manage.data.url, /^https:\/\/paystack\.com\/manage\/subscriptions\/SUB_1$/);
  assert.ok(h.platform.registry.billingEvents(s.id).length >= 4);
});

test('the Starter plan limits features and staff', async t => {
  const h = await harness(t);
  const s = await h.shop();
  h.platform.registry.setBilling(s.id, { plan: 'starter' }, 'test');
  const config = await h.session(s);
  assert.equal(config.inventoryWritesEnabled, false);
  assert.equal(config.productWritesEnabled, false);
  assert.equal(config.returnsEnabled, false);
  assert.equal(config.maxStaff, 3);
  for (const n of [1, 2, 3]) {
    const res = await h.call(s.host, '/api/staff', { method: 'POST', origin: s.origin, token: s.token, body: { name: `Staff ${n}`, username: `staff${n}`, role: 'cashier', password: 'cashier-passphrase-123' } });
    assert.equal(res.status, 201, JSON.stringify(res.data));
  }
  const fourth = await h.call(s.host, '/api/staff', { method: 'POST', origin: s.origin, token: s.token, body: { name: 'Staff 4', username: 'staff4', role: 'cashier', password: 'cashier-passphrase-123' } });
  assert.equal(fourth.status, 403);
  assert.equal(fourth.data.code, 'PLAN_LIMIT');
  h.platform.registry.setBilling(s.id, { plan: 'growth' }, 'test');
  assert.equal((await h.session(s)).inventoryWritesEnabled, true);
});

test('the console needs password + authenticator code, locks out guessing, and audits actions', async t => {
  const h = await harness(t);
  const s = await h.shop();
  const admin = h.platform.adminAuth.create('prince', 'console-passphrase-2026');
  const secret = base32Decode(admin.secret);
  const code = (offset = 0) => totpCode(secret, Math.floor(Date.now() / 30000) + offset);
  const login = body => h.site('/api/console/login', { method: 'POST', body });
  assert.equal((await h.site('/api/console/shops')).status, 401);
  assert.equal((await login({ username: 'prince', password: 'console-passphrase-2026', code: '000000' })).status, 401);
  assert.equal((await login({ username: 'prince', password: 'wrong-password', code: code() })).status, 401);
  assert.equal((await h.site('/api/console/login', { method: 'POST', origin: 'https://evil.example', body: { username: 'prince', password: 'console-passphrase-2026', code: code() } })).status, 403);
  const ok = await login({ username: 'prince', password: 'console-passphrase-2026', code: code() });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const cookie = String(ok.headers['set-cookie']).split(';')[0];
  assert.match(String(ok.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
  assert.equal((await login({ username: 'prince', password: 'console-passphrase-2026', code: code() })).status, 401, 'a code works once');
  const shops = await h.site('/api/console/shops', { cookie });
  assert.equal(shops.data.shops[0].slug, 'amaboutique');
  assert.equal(shops.data.shops[0].access.state, 'trial');
  const act = body => h.site(`/api/console/shops/${s.id}/actions`, { method: 'POST', cookie, body });
  assert.equal((await act({ action: 'record_payment', plan: 'pro', interval: 'monthly', note: '' })).status, 400, 'manual payments need a note');
  assert.equal((await act({ action: 'record_payment', plan: 'pro', interval: 'monthly', note: 'INV-0001' })).data.shop.access.state, 'active');
  assert.equal((await act({ action: 'extend_trial', days: 7 })).status, 200);
  assert.equal((await act({ action: 'suspend', note: 'test' })).data.shop.status, 'suspended');
  assert.equal((await h.call(s.host, '/api/session', { token: s.token })).status, 503);
  await act({ action: 'resume' });
  assert.equal((await act({ action: 'comp', on: true, note: 'founding shop' })).data.shop.access.state, 'comped');
  const audit = (await h.site('/api/console/audit', { cookie })).data.audit;
  assert.ok(audit.some(a => a.actor === 'admin:prince' && a.action === 'billing.payment'));
  assert.ok(audit.some(a => a.actor === 'admin:prince' && a.action === 'console.comp' && a.detail === 'founding shop'));
  // A shop owner's session is not a console session.
  assert.equal((await h.site('/api/console/shops', { token: s.token })).status, 401);
  await h.site('/api/console/logout', { method: 'POST', cookie, body: {} });
  assert.equal((await h.site('/api/console/shops', { cookie })).status, 401);
  // Guessing over HTTP hits the per-connection limit (10 per 15 minutes)...
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) limited = (await login({ username: 'prince', password: 'nope-nope-nope-nope', code: '123456' })).status === 429;
  assert.ok(limited, 'sign-in attempts are rate limited per connection');
  // ...and 8 failures lock the account itself (from any number of connections),
  // even for the right password and code.
  for (let i = 0; i < 8; i++) await h.platform.adminAuth.login('prince', 'nope-nope-nope-nope', '123456');
  assert.equal((await h.platform.adminAuth.login('prince', 'console-passphrase-2026', code(1))).status, 423);
  // TOTP helpers round-trip and refuse replays and far-off codes.
  const raw = randomBytes(20);
  assert.deepEqual(base32Decode(base32Encode(raw)), raw);
  const step = Math.floor(Date.now() / 30000);
  assert.equal(verifyTotp(raw, totpCode(raw, step)), step);
  assert.equal(verifyTotp(raw, totpCode(raw, step), { lastStep: step }), 0);
  assert.equal(verifyTotp(raw, totpCode(raw, step + 5)), 0);
});

test('the Windows till release notice is published by an admin and shown in Shop setup', async t => {
  const h = await harness(t);
  const s = await h.shop();
  assert.equal((await h.site('/till/latest.json')).status, 404, 'nothing published yet');
  const sha = 'a'.repeat(64);
  assert.throws(() => h.platform.registry.setTillRelease({ version: 'v2', url: 'https://x/y.exe', sha256: sha }), /Version/);
  assert.throws(() => h.platform.registry.setTillRelease({ version: '2.0.0', url: 'http://x/y.exe', sha256: sha }), /https/);
  assert.throws(() => h.platform.registry.setTillRelease({ version: '2.0.0', url: 'https://x/y.exe', sha256: 'abc' }), /SHA-256/);
  h.platform.registry.setTillRelease({ version: '2.0.0', url: 'https://mansupos.test/download/Mansu-POS-ONLINE-2.0.0-Windows-Setup.exe', sha256: sha, notes: 'Multi-shop till' }, 'test');
  const notice = await h.site('/till/latest.json');
  assert.equal(notice.status, 200);
  assert.equal(notice.data.version, '2.0.0');
  assert.equal(notice.data.sha256, sha);
  const setup = await h.call(s.host, '/api/setup', { token: s.token });
  assert.equal(setup.data.setup.till.version, '2.0.0');
  assert.match(setup.data.setup.till.url, /Mansu-POS-ONLINE-2\.0\.0/);
});
