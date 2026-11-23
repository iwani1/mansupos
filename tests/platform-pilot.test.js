// Phase 5: pilot readiness — invitations, founding prices, email, reminders,
// scheduled backups, feedback and pilot health.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createPlatform } from '../server/platform/platform.js';
import { computeAccess } from '../server/platform/billing.js';
import { totpCode, base32Decode } from '../server/platform/admin-auth.js';
import { createMailer } from '../server/platform/mailer.js';
import { remindersDue, runReminders, runScheduledBackup, pruneBackups } from '../server/platform/jobs.js';

const BASE = 'mansupos.test';
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const DAY = 86400000;

async function harness(t, { mailer: injectedMailer } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-pilot-'));
  const sent = [];
  const mailer = injectedMailer || { driver: 'memory', async send(m) { sent.push(m); }, list: () => sent };
  const inits = [];
  const paystack = { secretKey: `sk_test_${'k'.repeat(40)}`, testMode: true,
    async initialize(a) { inits.push(a); return { authorization_url: `https://checkout.paystack.com/${a.reference}` }; }, async verify() { return { status: 'abandoned' }; } };
  const product = { id: 10, name: 'Dress', type: 'variable', sku: 'D', price: '100.00', images: [], categories: [], status: 'publish', purchasable: true, manage_stock: false, stock_status: 'instock', backorders: 'no', permalink: 'https://x' };
  const variation = { id: 11, sku: 'D-M', price: '100.00', attributes: [{ name: 'Size', option: 'M' }], manage_stock: true, stock_quantity: 5, stock_status: 'instock', backorders: 'no', purchasable: true };
  const orders = [];
  const view = o => ({ ...o, line_items: o.line_items.map(i => ({ ...i, name: 'Dress', sku: 'D-M', price: 100, subtotal: '100.00', total: '100.00', total_tax: '0.00', meta_data: [] })), refunds: [] });
  const api = { async request(r) { return { data: r === 'products' ? [product] : [], total: 1, pages: 1 }; }, async products() { return { data: [product], total: 1, pages: 1 }; }, async variations() { return { data: [variation], total: 1, pages: 1 }; }, async product() { return product; }, async variation() { return variation; },
    async createOrder(b) { const o = { ...b, id: 500 + orders.length, number: String(500 + orders.length), total: '100.00', total_tax: '0.00', currency: 'GHS', status: 'pending', date_paid: null }; orders.push(o); return view(o); },
    async updateOrder(id, b) { const o = orders.find(x => x.id === id); const { meta_data, ...rest } = b; Object.assign(o, rest); if (meta_data) o.meta_data = [...(o.meta_data || []), ...meta_data]; if (b.set_paid) { o.date_paid = new Date().toISOString().replace('Z', ''); o.date_paid_gmt = o.date_paid; } return view(o); },
    async order(id) { return view(orders.find(x => x.id === id)); }, async findOrderByKey() { return null; } };
  const platform = createPlatform({
    env: { NODE_ENV: 'test', PLATFORM_BASE_DOMAIN: BASE, PLATFORM_DATA_DIR: dir, PLATFORM_MASTER_KEY: randomBytes(32).toString('hex'), PLATFORM_SIGNUPS_PER_HOUR: '50', PLATFORM_JOBS: 'off' },
    logger: quiet, paystack, mailer, appFactory: ({ env, logger, extend }) => createApp({ env, logger, extend, api }),
  });
  const server = http.createServer(platform.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (host, url, { method = 'GET', body, token, origin, cookie } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { Host: host, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => { let parsed = text; try { parsed = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode, data: parsed, headers: res.headers }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  const site = (url, opts = {}) => call(BASE, url, { origin: `https://${BASE}`, ...opts });
  const form = over => ({ shopName: 'Ama Boutique', slug: 'amaboutique', storeUrl: 'https://amaboutique.example.com', ownerName: 'Ama Owusu', email: 'ama@example.com', phone: '', username: 'ama', password: 'chosen-passphrase-123', acceptTerms: true, ...over });
  const tokenOf = m => /#token=([A-Za-z0-9_-]+)/.exec(m.text)[1];
  async function shop(over = {}) {
    const code = over.inviteCode || platform.registry.createInvite({}, 'test').code;
    const res = await site('/api/signup', { method: 'POST', body: form({ ...over, inviteCode: code }) });
    assert.equal(res.status, 202, JSON.stringify(res.data));
    assert.equal((await site('/api/signup/verify', { method: 'POST', body: { token: tokenOf(sent.at(-1)) } })).status, 201);
    const slug = over.slug || 'amaboutique', host = `${slug}.${BASE}`, origin = `https://${host}`;
    const record = platform.registry.bySlug(slug);
    platform.registry.setSecret(record.id, 'woo_key', `ck_${'a'.repeat(40)}`, 'test');
    platform.registry.setSecret(record.id, 'woo_secret', `cs_${'b'.repeat(40)}`, 'test');
    platform.registry.update(record.id, { stage: 'selling' }, 'test');
    const login = await call(host, '/api/auth/login', { method: 'POST', origin, body: { username: over.username || 'ama', password: 'chosen-passphrase-123' } });
    return { id: record.id, host, origin, token: login.data.token };
  }
  async function consoleCookie() {
    const admin = platform.adminAuth.create('prince', 'console-passphrase-2026');
    const ok = await site('/api/console/login', { method: 'POST', body: { username: 'prince', password: 'console-passphrase-2026', code: totpCode(base32Decode(admin.secret), Math.floor(Date.now() / 30000)) } });
    return String(ok.headers['set-cookie']).split(';')[0];
  }
  return { platform, call, site, form, sent, tokenOf, shop, consoleCookie, inits, dir };
}

test('during the pilot, only invited shops can sign up; each invitation works once', async t => {
  const h = await harness(t);
  assert.equal((await h.site('/api/signup/config')).data.mode, 'invite', 'invite-only is the default');
  const noCode = await h.site('/api/signup', { method: 'POST', body: h.form() });
  assert.equal(noCode.data.code, 'INVITE');
  const bound = h.platform.registry.createInvite({ email: 'ama@example.com', discountPercent: 50, discountMonths: 6 }, 'admin:test');
  assert.match(bound.code, /^MANSU-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await h.site('/api/signup', { method: 'POST', body: h.form({ email: 'someone@else.com', inviteCode: bound.code }) })).data.code, 'INVITE', 'an invite for one email does not work for another');
  // Two people start sign-up with the same code; only the first to confirm gets it.
  assert.equal((await h.site('/api/signup', { method: 'POST', body: h.form({ inviteCode: bound.code.toLowerCase() }) })).status, 202);
  const first = h.tokenOf(h.sent.at(-1));
  assert.equal((await h.site('/api/signup', { method: 'POST', body: h.form({ slug: 'amastyles', username: 'ama2', inviteCode: bound.code }) })).status, 202);
  const second = h.tokenOf(h.sent.at(-1));
  assert.equal((await h.site('/api/signup/verify', { method: 'POST', body: { token: first } })).status, 201);
  const loser = await h.site('/api/signup/verify', { method: 'POST', body: { token: second } });
  assert.equal(loser.data.code, 'INVITE_USED');
  assert.equal(h.platform.registry.bySlug('amastyles'), null);
  const shop = h.platform.registry.bySlug('amaboutique');
  assert.equal(shop.billing.discount.percent, 50, 'the founding price from the invitation is applied');
  assert.equal(h.platform.registry.invites()[0].status, 'used');
  assert.equal((await h.site('/api/signup', { method: 'POST', body: h.form({ slug: 'third', inviteCode: bound.code }) })).data.code, 'INVITE', 'a used code does not work again');
  const revoked = h.platform.registry.createInvite({}, 'admin:test');
  h.platform.registry.revokeInvite(revoked.id, 'admin:test');
  assert.equal((await h.site('/api/signup', { method: 'POST', body: h.form({ slug: 'fourth', inviteCode: revoked.code }) })).data.code, 'INVITE');
  assert.throws(() => h.platform.registry.createInvite({ discountPercent: 50 }, 'x'), /both/);
  assert.throws(() => h.platform.registry.createInvite({ discountPercent: 95, discountMonths: 1 }, 'x'), /0 to 90/);
});

test('a founding price is charged on one-off payments until it ends', async t => {
  const h = await harness(t);
  const code = h.platform.registry.createInvite({ discountPercent: 50, discountMonths: 6 }, 'admin:test').code;
  const s = await h.shop({ inviteCode: code });
  const billing = (await h.call(s.host, '/api/billing', { token: s.token })).data.billing;
  assert.equal(billing.discount.percent, 50);
  assert.equal(billing.plans.find(p => p.key === 'growth').prices.monthly, 22500);
  assert.equal(billing.plans.find(p => p.key === 'growth').fullPrices.monthly, 45000);
  const checkout = await h.call(s.host, '/api/billing/checkout', { method: 'POST', origin: s.origin, token: s.token, body: { plan: 'growth', interval: 'monthly' } });
  assert.equal(checkout.status, 200);
  assert.equal(h.inits.at(-1).amount, 22500);
  h.platform.registry.setSetting('paystack_plan:growth:monthly', 'PLN_x');
  assert.equal((await h.call(s.host, '/api/billing/checkout', { method: 'POST', origin: s.origin, token: s.token, body: { plan: 'growth', interval: 'monthly', autoRenew: true } })).data.code, 'DISCOUNT_ONE_OFF');
  // An admin can change or end it; manual payments use the shop's price.
  const cookie = await h.consoleCookie();
  await h.site(`/api/console/shops/${s.id}/actions`, { method: 'POST', cookie, body: { action: 'record_payment', plan: 'growth', interval: 'monthly', note: 'INV-1' } });
  assert.equal(h.platform.registry.billingEvents(s.id)[0].amount, 22500);
  await h.site(`/api/console/shops/${s.id}/actions`, { method: 'POST', cookie, body: { action: 'discount', percent: 0, months: 0 } });
  assert.equal(h.platform.registry.byId(s.id).billing.discount, null);
  assert.equal((await h.call(s.host, '/api/billing', { token: s.token })).data.billing.plans.find(p => p.key === 'growth').prices.monthly, 45000);
});

test('Resend sends real email, and a failed send is explained instead of hidden', async t => {
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); };
  const mailer = createMailer({ mailDriver: 'resend', resendApiKey: 're_testkey_123456', mailFrom: 'Mansu POS <hello@mansupos.com>', mailReplyTo: 'support@mansupos.com' }, quiet, fakeFetch);
  await mailer.send({ to: 'ama@example.com', subject: 'Hi', text: 'Body' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_testkey_123456');
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'Mansu POS <hello@mansupos.com>', to: ['ama@example.com'], subject: 'Hi', text: 'Body', reply_to: 'support@mansupos.com' });
  const failing = createMailer({ mailDriver: 'resend', resendApiKey: 're_testkey_123456', mailFrom: 'hello@mansupos.com' }, quiet, async () => new Response('{"message":"domain not verified"}', { status: 403 }));
  await assert.rejects(() => failing.send({ to: 'a@b.co', subject: 's', text: 't' }), /not accepted/);
  const { readPlatformConfig } = await import('../server/platform/config.js');
  const base = { PLATFORM_BASE_DOMAIN: 'mansupos.com', PLATFORM_MASTER_KEY: 'a'.repeat(64), PLATFORM_MAIL_DRIVER: 'resend' };
  assert.throws(() => readPlatformConfig({ ...base, PLATFORM_MAIL_FROM: 'hello@mansupos.com' }), /RESEND_API_KEY/);
  assert.throws(() => readPlatformConfig({ ...base, PLATFORM_RESEND_API_KEY: 're_testkey_123456', PLATFORM_MAIL_FROM: 'not an address' }), /MAIL_FROM/);
  assert.equal(readPlatformConfig({ ...base, PLATFORM_RESEND_API_KEY: 're_testkey_123456', PLATFORM_MAIL_FROM: 'Mansu POS <hello@mansupos.com>' }).mailDriver, 'resend');
  // Sign-up says so when the confirmation email cannot be sent.
  const h = await harness(t, { mailer: { driver: 'broken', async send() { throw new Error('down'); }, list: () => [] } });
  const code = h.platform.registry.createInvite({}, 'x').code;
  const res = await h.site('/api/signup', { method: 'POST', body: h.form({ inviteCode: code }) });
  assert.equal(res.status, 502);
  assert.equal(res.data.code, 'MAIL_FAILED');
});

test('billing reminders go out once each, and are retried if the email failed', async t => {
  const now = Date.parse('2026-12-10T08:00:00Z');
  const shop = over => ({ name: 'Ama Boutique', status: 'active', ...over });
  const access = (state, until, extra = {}) => ({ state, until, graceUntil: new Date(Date.parse(until) + 7 * DAY).toISOString(), autoRenew: false, ...extra });
  assert.match(remindersDue(shop(), access('trial', '2026-12-12T00:00:00Z'), now)[0].key, /^trial-3:/);
  assert.match(remindersDue(shop(), access('trial', '2026-12-10T20:00:00Z'), now)[0].key, /^trial-1:/);
  assert.equal(remindersDue(shop(), access('trial', '2026-12-20T00:00:00Z'), now).length, 0);
  assert.match(remindersDue(shop(), access('active', '2026-12-13T00:00:00Z'), now)[0].key, /^renew-5:/);
  assert.equal(remindersDue(shop(), access('active', '2026-12-13T00:00:00Z', { autoRenew: true }), now).length, 0, 'auto-renewing shops get no renewal nag');
  assert.match(remindersDue(shop(), access('grace', '2026-12-08T00:00:00Z'), now)[0].subject, /overdue/);
  assert.match(remindersDue(shop(), { state: 'lapsed', until: '2026-12-01T00:00:00Z', graceUntil: '2026-12-08T00:00:00Z' }, now)[0].subject, /paused/);
  assert.equal(remindersDue(shop({ status: 'suspended' }), access('grace', '2026-12-08T00:00:00Z'), now).length, 0);
  const h = await harness(t);
  await h.shop();
  const record = h.platform.registry.bySlug('amaboutique');
  const soon = Date.parse(record.trialEndsAt) - 2 * DAY;
  const before = h.sent.length;
  assert.equal(await runReminders({ registry: h.platform.registry, config: h.platform.config, mailer: h.platform.mailer, logger: quiet, now: soon }), 1);
  assert.match(h.sent.at(-1).subject, /ends in 3 days/);
  assert.match(h.sent.at(-1).text, /https:\/\/amaboutique\.mansupos\.test\//);
  assert.equal(await runReminders({ registry: h.platform.registry, config: h.platform.config, mailer: h.platform.mailer, logger: quiet, now: soon + 3600000 }), 0, 'not sent twice');
  assert.equal(h.sent.length, before + 1);
  let attempts = 0;
  const flaky = { async send() { attempts++; if (attempts === 1) throw new Error('down'); } };
  const graceNow = Date.parse(record.trialEndsAt) + DAY;
  assert.equal(await runReminders({ registry: h.platform.registry, config: h.platform.config, mailer: flaky, logger: quiet, now: graceNow }), 0);
  assert.equal(await runReminders({ registry: h.platform.registry, config: h.platform.config, mailer: flaky, logger: quiet, now: graceNow + 3600000 }), 1, 'retried after a failure');
  assert.equal(computeAccess(record, { now: graceNow }).state, 'grace');
});

test('scheduled backups run daily and prune only their own old folders', async t => {
  const h = await harness(t);
  await h.shop();
  const config = { ...h.platform.config, backupHours: 24, backupKeepDays: 14, backupDir: path.join(h.dir, 'scheduled') };
  const now = Date.now();
  const first = await runScheduledBackup({ registry: h.platform.registry, config, logger: quiet, now });
  assert.ok(first && fs.existsSync(path.join(first, 'manifest.json')));
  assert.equal(await runScheduledBackup({ registry: h.platform.registry, config, logger: quiet, now: now + 3600000 }), null, 'not again within 24 hours');
  const old = path.join(config.backupDir, '2026-01-01T00-00-00.000Z-abcdef12');
  fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'manifest.json'), '{}');
  const notOurs = path.join(config.backupDir, 'keep-me'); fs.mkdirSync(notOurs);
  const noManifest = path.join(config.backupDir, '2026-01-02T00-00-00.000Z-abcdef13'); fs.mkdirSync(noManifest);
  assert.deepEqual(pruneBackups(config.backupDir, 14, now), ['2026-01-01T00-00-00.000Z-abcdef12']);
  assert.ok(fs.existsSync(notOurs) && fs.existsSync(noManifest) && fs.existsSync(first));
});

test('shops send feedback; the console sees it with health, and replies reach the shop', async t => {
  const h = await harness(t);
  const s = await h.shop();
  await h.call(s.host, '/api/staff', { method: 'POST', origin: s.origin, token: s.token, body: { name: 'Kofi Cash', username: 'kofi', role: 'cashier', password: 'cashier-passphrase-123' } });
  const kofi = (await h.call(s.host, '/api/auth/login', { method: 'POST', origin: s.origin, body: { username: 'kofi', password: 'cashier-passphrase-123' } })).data.token;
  await h.call(s.host, '/api/auth/password', { method: 'POST', origin: s.origin, token: kofi, body: { currentPassword: 'cashier-passphrase-123', newPassword: 'cashier-new-passphrase-456' } });
  assert.equal((await h.call(s.host, '/api/feedback', { method: 'POST', origin: s.origin, token: kofi, body: { kind: 'problem', message: 'Receipt printer cuts off the total', page: 'register' } })).status, 201);
  assert.equal((await h.call(s.host, '/api/feedback', { method: 'POST', origin: s.origin, token: s.token, body: { kind: 'idea', message: 'Add MoMo payments please' } })).status, 201);
  assert.equal((await h.call(s.host, '/api/feedback', { method: 'POST', origin: s.origin, token: s.token, body: { kind: 'idea', message: 'hi' } })).status, 400);
  assert.equal((await h.call(s.host, '/api/feedback', { token: kofi })).data.feedback.length, 1, 'cashiers see their own');
  assert.equal((await h.call(s.host, '/api/feedback', { token: s.token })).data.feedback.length, 2, 'the owner sees the shop\'s');
  const cookie = await h.consoleCookie();
  const list = (await h.site('/api/console/feedback', { cookie })).data.feedback;
  assert.equal(list.length, 2);
  assert.equal(list[1].shop, 'Ama Boutique');
  assert.equal((await h.site(`/api/console/feedback/${list[1].id}/resolve`, { method: 'POST', cookie, body: { reply: 'Set paper width to 80 mm in Receipt printer.' } })).status, 200);
  const mine = (await h.call(s.host, '/api/feedback', { token: kofi })).data.feedback[0];
  assert.equal(mine.status, 'resolved');
  assert.match(mine.reply, /80 mm/);
  // Pilot health: a sale counts; a stuck sale is flagged as critical.
  await h.call(s.host, '/api/shifts/open', { method: 'POST', origin: s.origin, token: s.token, body: { openingFloat: 0 } });
  const prepared = await h.call(s.host, '/api/sales/prepare', { method: 'POST', origin: s.origin, token: s.token, body: { idempotencyKey: randomUUID(), items: [{ productId: 10, variationId: 11, quantity: 1 }] } });
  await h.call(s.host, `/api/sales/${prepared.data.sale.id}/pay`, { method: 'POST', origin: s.origin, token: s.token, body: { method: 'cash', tendered: 10000, confirmed: true } });
  let health = (await h.site('/api/console/health', { cookie })).data.shops[0];
  assert.equal(health.metrics.sales7d, 1);
  assert.equal(health.metrics.salesToday, 1);
  assert.equal(health.metrics.needsAttention, 0);
  assert.equal(health.metrics.openShifts, 1);
  const stuck = await h.call(s.host, '/api/sales/prepare', { method: 'POST', origin: s.origin, token: s.token, body: { idempotencyKey: randomUUID(), items: [{ productId: 10, variationId: 11, quantity: 1 }] } });
  h.platform.evictIdle(0);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(h.dir, 'shops', s.id, 'pos-live.db'));
  db.prepare('UPDATE sales SET updated_at=? WHERE id=?').run(new Date(Date.now() - 3600000).toISOString(), stuck.data.sale.id);
  db.close();
  health = (await h.site('/api/console/health', { cookie })).data.shops[0];
  assert.equal(health.metrics.needsAttention, 1);
  assert.equal(health.flags[0].level, 'critical');
});
