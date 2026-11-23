import { randomBytes } from 'node:crypto';
import { createApp } from '../app.js';
import { readConfig, shouldRunReconcileTimer } from '../config.js';
import { acquireInstanceLease } from '../instance-lease.js';
import { createLogger } from '../logger.js';
import { readPlatformConfig } from './config.js';
import { PlatformRegistry } from './registry.js';
import { buildShopEnv } from './shop-env.js';
import { slugFromHost } from './slug.js';
import { createMailer } from './mailer.js';
import { createSignupApp } from './signup.js';
import { handleWooCallback, setupRoutes } from './setup.js';
import { createGuardedFetch } from '../net-guard.js';
import { computeAccess, entitlements } from './billing.js';
import { createBillingService } from './billing-service.js';
import { Paystack } from './paystack.js';
import { AdminAuth } from './admin-auth.js';
import { consoleRouter } from './console.js';

// One process, many shops. Every request is matched to exactly one shop by its
// web address BEFORE any shop code runs; that shop's own POS app (its own
// SQLite database, sessions, staff, rate limits and WooCommerce keys) then
// handles it. Shops are opened on first use and closed when idle.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

function reply(req, res, status, message) {
  const wantsJson = String(req.url || '').startsWith('/api');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': wantsJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' });
  res.end(wantsJson ? JSON.stringify({ error: message }) : message);
}

export function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const chars = [...randomBytes(16)].map(byte => alphabet[byte % alphabet.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

export function createPlatform({ env = process.env, appFactory, mountUi, logger: injectedLogger, setupFetch: injectedSetupFetch, mailer: injectedMailer, paystack: injectedPaystack } = {}) {
  const config = readPlatformConfig(env);
  const logger = injectedLogger || createLogger(config.logLevel);
  const registry = new PlatformRegistry(config);
  const view = { ...config, shopDir: shop => registry.shopDir(shop) };
  const factory = appFactory || (options => createApp(options));
  const open = new Map();
  // Store checks during set-up use the same private-network guard as the shops.
  const setupFetch = injectedSetupFetch || createGuardedFetch();
  const mailer = injectedMailer || createMailer(config, logger);
  const paystack = injectedPaystack || (config.paystackSecretKey ? new Paystack({ secretKey: config.paystackSecretKey }) : null);
  const billing = createBillingService({ registry, config, paystack, logger });
  billing.configured = Boolean(paystack);
  const adminAuth = new AdminAuth(registry, config.masterKey);
  const accessOf = shop => computeAccess(shop, { graceDays: config.graceDays });
  // An open shop must reopen when its settings OR its access change (trial
  // ending, payment lapsing) even though nothing was written to the registry.
  const versionOf = shop => { const a = accessOf(shop); return `${shop.version}|${a.state}|${a.plan}`; };

  function startShop(shop, { owner } = {}) {
    const access = accessOf(shop);
    const shopEnv = buildShopEnv(shop, registry.secretsFor(shop.id), view, { owner, access, entitlements: entitlements(shop, access) });
    const shopConfig = readConfig(shopEnv); // validate before touching the data folder
    const lease = acquireInstanceLease(shopConfig);
    let instance;
    const setupExtend = setupRoutes({ registry, shopId: shop.id, origin: config.shopOrigin(shop.slug), fetchImpl: setupFetch });
    const billingExtend = billing.routes(shop.id, config.shopOrigin(shop.slug));
    const extend = (app, ctx) => { setupExtend(app, ctx); billingExtend(app, ctx); };
    try { instance = factory({ env: shopEnv, logger: logger.child({ shop: shop.slug }), extend }); }
    catch (error) { lease.release(); throw error; }
    if (mountUi) mountUi(instance.app, instance.config);
    const timers = [];
    if (shouldRunReconcileTimer(instance.config)) {
      let busy = false;
      timers.push(setInterval(async () => {
        if (busy) return;
        busy = true;
        try { await instance.sales.reconcilePending(); await instance.sales.cancelAbandoned(); }
        catch (error) { logger.error({ msg: 'platform.reconcile_failed', shop: shop.slug, name: error.name }); }
        finally { busy = false; }
      }, instance.config.reconcileIntervalSeconds * 1000));
    }
    timers.push(setInterval(() => {
      try { instance.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch { /* closed */ }
    }, 15 * 60000));
    for (const timer of timers) timer.unref();
    return { shopId: shop.id, slug: shop.slug, version: versionOf(shop), app: instance.app, db: instance.db, outboundFetch: instance.outboundFetch,
      config: instance.config, lease, timers, active: 0, lastUsed: Date.now() };
  }

  function closeEntry(entry) {
    open.delete(entry.shopId);
    for (const timer of entry.timers) clearInterval(timer);
    try { entry.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* already closed */ }
    try { entry.db.close(); } catch { /* already closed */ }
    try { entry.outboundFetch?.close?.(); } catch { /* not a guarded fetch */ }
    try { entry.lease.release(); } catch (error) { logger.error({ msg: 'platform.lease_release_failed', shop: entry.slug, name: error.name }); }
  }

  function makeRoom() {
    if (open.size < config.maxOpenShops) return;
    const idle = [...open.values()].filter(entry => entry.active === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    if (idle.length) closeEntry(idle[0]);
    else logger.warn({ msg: 'platform.open_shop_limit_exceeded', open: open.size });
  }

  function acquire(shop) {
    let entry = open.get(shop.id);
    // Settings or credentials changed: reopen once nothing is in flight.
    if (entry && entry.version !== versionOf(shop) && entry.active === 0) { closeEntry(entry); entry = null; }
    if (!entry) {
      makeRoom();
      entry = startShop(shop);
      open.set(shop.id, entry);
      logger.info({ msg: 'platform.shop_opened', shop: shop.slug, open: open.size });
    }
    return entry;
  }


  function handler(req, res) {
    const slug = slugFromHost(req.headers.host, config.baseDomain);
    if (slug === '') {
      if (req.method === 'POST' && String(req.url).split('?')[0] === '/api/paystack/webhook') {
        return billing.handleWebhook(req, res).catch(error => {
          logger.error({ msg: 'billing.webhook_error', name: error.name });
          if (!res.headersSent) reply(req, res, 500, 'Could not process.');
        });
      }
      return signupApp(req, res);
    }
    if (!slug) return reply(req, res, 404, 'Shop not found.');
    const shop = registry.bySlug(slug);
    if (!shop || shop.status === 'closed') return reply(req, res, 404, 'Shop not found.');
    if (shop.status === 'suspended') return reply(req, res, 503, 'This shop is paused. Please contact Mansu POS support.');
    // WooCommerce's own server posts new keys here after the owner approves.
    if (req.method === 'POST' && String(req.url).split('?')[0] === '/api/setup/woo/callback') {
      return handleWooCallback(req, res, { registry, shop, logger }).catch(error => {
        logger.error({ msg: 'platform.woo_callback_failed', shop: shop.slug, name: error.name });
        if (!res.headersSent) reply(req, res, 500, 'Could not save the connection.');
      });
    }
    let entry;
    try { entry = acquire(shop); }
    catch (error) {
      logger.error({ msg: 'platform.shop_open_failed', shop: shop.slug, name: error.name, reason: String(error.message).slice(0, 200) });
      return reply(req, res, 503, 'This shop could not be opened right now. Please try again shortly.');
    }
    entry.active++;
    entry.lastUsed = Date.now();
    let finished = false;
    const finish = () => { if (finished) return; finished = true; entry.active--; entry.lastUsed = Date.now(); };
    res.on('finish', finish);
    res.on('close', finish);
    return entry.app(req, res);
  }

  // Creates a shop and its owner account. The temporary password is returned
  // once and never stored; the owner must change it at first sign-in.
  function provisionShop({ slug, name, storeUrl, ownerUsername, owner = {}, trialDays = 0, actor = 'cli' }) {
    const username = String(ownerUsername || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error('Owner username: 3 to 40 letters, numbers, dots, hyphens or underscores.');
    const shop = registry.createShop({ slug, name, storeUrl, owner, trialDays, actor });
    // Signed-up owners chose their password (we hold only its hash); shops made
    // by an admin get a temporary one, shown once and changed at first sign-in.
    const password = owner.passwordHash ? null : temporaryPassword();
    try {
      closeEntry(startShop(shop, { owner: { username, password, passwordHash: owner.passwordHash, name: owner.name } }));
    } catch (error) {
      registry.update(shop.id, { status: 'closed' }, actor);
      throw error;
    }
    registry.audit(actor, 'shop.owner_created', shop.id, username);
    return { shop: registry.byId(shop.id), ownerUsername: username, ownerPassword: password };
  }
  const signupApp = createSignupApp({ config, registry, provisionShop, mailer, logger,
    mount: app => app.use('/api/console', consoleRouter({ registry, auth: adminAuth, config, billing })) });

  function evictIdle(maxIdleMs = config.idleMs) {
    const cutoff = Date.now() - maxIdleMs;
    for (const entry of [...open.values()]) {
      const shop = registry.byId(entry.shopId);
      if (entry.active === 0 && (entry.lastUsed <= cutoff || !shop || shop.status !== 'active')) closeEntry(entry);
    }
  }
  const sweeper = setInterval(() => evictIdle(), 60000);
  sweeper.unref();

  function close() {
    clearInterval(sweeper);
    for (const entry of [...open.values()]) closeEntry(entry);
    try { setupFetch.close?.(); } catch { /* injected */ }
    registry.close();
  }

  return {
    config, registry, logger, mailer, billing, adminAuth, paystack, handler, provisionShop, evictIdle, close,
    openShops: () => [...open.values()].map(entry => ({ shopId: entry.shopId, slug: entry.slug, active: entry.active })),
  };
}
