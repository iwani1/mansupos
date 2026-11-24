import { z } from 'zod';
import { AppError } from '../errors.js';

// Shop set-up for platform shops: connect the WooCommerce store through its
// own "authorise app" screen, check the store is fit for the till, fill in
// receipt details, then move from practice (read_only) to selling.
const KEY = /^ck_[0-9a-f]{40}$/i;
const SECRET = /^cs_[0-9a-f]{40}$/i;
const MAX_PRODUCT_PAGES = 10;

async function wooGet(fetchImpl, storeUrl, keys, resource, query = {}) {
  const url = new URL(`${storeUrl}/wp-json/wc/v3/${resource}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const response = await fetchImpl(url, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Basic ${Buffer.from(`${keys.woo_key}:${keys.woo_secret}`).toString('base64')}`, Accept: 'application/json', 'User-Agent': 'MansuPOS-setup/1.0' },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!response.ok || data === null) {
    const error = new Error(response.status === 401 || response.status === 403
      ? 'WooCommerce refused the keys. Connect the store again and approve Read/Write access.'
      : response.status === 404 ? 'The WooCommerce API was not found. Check permalinks are not set to "Plain".'
        : `The store answered HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return { data, total: Number(response.headers.get('x-wp-total')) || null, pages: Number(response.headers.get('x-wp-totalpages')) || 1 };
}

const setting = (list, id) => (Array.isArray(list) ? list.find(item => item?.id === id)?.value : undefined);

export async function storeHealthCheck({ storeUrl, keys, fetchImpl }) {
  const items = [];
  const add = (key, label, status, detail) => items.push({ key, label, status, detail });
  const result = () => ({ checkedAt: new Date().toISOString(), ok: !items.some(i => i.status === 'fail'), items });
  if (!keys.woo_key || !keys.woo_secret) {
    add('connection', 'Store connected', 'fail', 'Connect your WooCommerce store first.');
    return result();
  }
  let general, products;
  try {
    general = (await wooGet(fetchImpl, storeUrl, keys, 'settings/general')).data;
    products = (await wooGet(fetchImpl, storeUrl, keys, 'settings/products')).data;
    add('connection', 'Store connected', 'pass', `Mansu POS can read ${new URL(storeUrl).hostname}.`);
  } catch (error) {
    add('connection', 'Store connected', 'fail', error.code === 'EPRIVATEADDR' || error.cause?.code === 'EPRIVATEADDR'
      ? 'The store address points to a private network address. Use the public web address.'
      : error.message || 'The store could not be reached.');
    return result();
  }
  const currency = setting(general, 'woocommerce_currency');
  add('currency', 'Prices in Ghana cedi (GHS)', currency === 'GHS' ? 'pass' : 'fail',
    currency === 'GHS' ? 'Store currency is GHS.' : `Store currency is ${currency || 'not set'}. Mansu POS sells in GHS: change it in WooCommerce > Settings > General.`);
  const manage = setting(products, 'woocommerce_manage_stock');
  add('stock', 'Stock management on', manage === 'yes' ? 'pass' : 'fail',
    manage === 'yes' ? 'WooCommerce counts stock.' : 'Turn on "Enable stock management" in WooCommerce > Settings > Products > Inventory, so shop and website share one count.');
  const hold = Number(setting(products, 'woocommerce_hold_stock_minutes'));
  add('hold', 'Unpaid website orders release stock', hold > 0 ? 'pass' : 'warn',
    hold > 0 ? `Unpaid orders are cancelled after ${hold} minutes.` : 'Set "Hold stock (minutes)" so abandoned website checkouts give their stock back.');
  const taxes = setting(general, 'woocommerce_calc_taxes');
  add('tax', 'Tax setting checked', taxes === 'yes' ? 'warn' : 'pass',
    taxes === 'yes' ? 'WooCommerce calculates tax. Receipts show the tax WooCommerce returns; confirm this with your tax adviser.' : 'Prices are entered as final prices (WooCommerce tax off).');

  let count = 0, noSku = 0, untracked = 0, scanned = 0;
  const skus = new Map();
  try {
    for (let page = 1; page <= MAX_PRODUCT_PAGES; page++) {
      const res = await wooGet(fetchImpl, storeUrl, keys, 'products', { per_page: 100, page, status: 'publish', _fields: 'id,sku,type,manage_stock' });
      if (page === 1) count = res.total ?? res.data.length;
      for (const p of Array.isArray(res.data) ? res.data : []) {
        scanned++;
        const sku = String(p.sku || '').trim().toLowerCase();
        if (!sku) noSku++; else skus.set(sku, (skus.get(sku) || 0) + 1);
        if (p.type === 'simple' && !p.manage_stock) untracked++;
      }
      if (page >= res.pages) break;
    }
  } catch (error) {
    add('products', 'Products readable', 'fail', error.message || 'Products could not be read.');
    return result();
  }
  const capped = scanned < count ? ` (first ${scanned} of ${count} checked)` : '';
  add('products', 'Published products', count > 0 ? 'pass' : 'fail', count > 0 ? `${count} published products${capped}.` : 'No published products yet. Add products in WooCommerce first.');
  add('sku', 'Every product has a SKU', noSku ? 'warn' : 'pass', noSku ? `${noSku} product(s) have no SKU, so they cannot be scanned at the till.` : 'All checked products have a SKU.');
  const duplicates = [...skus.values()].filter(n => n > 1).length;
  add('duplicates', 'SKUs are unique', duplicates ? 'warn' : 'pass', duplicates ? `${duplicates} SKU(s) are used by more than one product.` : 'No duplicate SKUs found.');
  add('tracking', 'Products track stock', untracked ? 'warn' : 'pass', untracked
    ? `${untracked} simple product(s) do not track stock and cannot be sold at the till until "Manage stock" is ticked.`
    : 'Checked products track stock (variations are checked when sold).');
  return result();
}

export function authoriseUrl(storeUrl, origin, nonce) {
  const url = new URL(`${storeUrl}/wc-auth/v1/authorize`);
  url.searchParams.set('app_name', 'Mansu POS');
  url.searchParams.set('scope', 'read_write');
  url.searchParams.set('user_id', nonce);
  url.searchParams.set('return_url', `${origin}/?setup=connected`);
  url.searchParams.set('callback_url', `${origin}/api/setup/woo/callback`);
  return url.toString();
}

// WooCommerce's server POSTs the new keys here after the owner approves. It is
// matched to the shop by the one-time code we put in the authorise link.
export async function handleWooCallback(req, res, { registry, shop, logger }) {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  let raw = '';
  let tooLarge = false;
  for await (const chunk of req) { raw += chunk; if (raw.length > 8192) { tooLarge = true; break; } }
  if (tooLarge) return send(413, { error: 'Too large.' });
  let body;
  try { body = JSON.parse(raw); } catch { return send(400, { error: 'Invalid JSON.' }); }
  const key = String(body?.consumer_key || ''), secret = String(body?.consumer_secret || '');
  if (!registry.consumeWooConnect(shop.id, String(body?.user_id || ''))) {
    logger.warn({ msg: 'platform.woo_callback_rejected', shop: shop.slug, reason: 'unknown or expired code' });
    return send(400, { error: 'This connection link is not valid. Start again from Mansu POS.' });
  }
  if (body?.key_permissions !== 'read_write' || !KEY.test(key) || !SECRET.test(secret)) {
    logger.warn({ msg: 'platform.woo_callback_rejected', shop: shop.slug, reason: 'permissions or key format' });
    return send(400, { error: 'Read/Write access is required.' });
  }
  registry.setSecret(shop.id, 'woo_key', key, 'woocommerce');
  registry.setSecret(shop.id, 'woo_secret', secret, 'woocommerce');
  registry.markConnected(shop.id);
  logger.info({ msg: 'platform.woo_connected', shop: shop.slug });
  return send(200, { ok: true });
}

const businessSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  address: z.string().max(200).optional(), phone: z.string().max(60).optional(), taxId: z.string().max(40).optional(),
  receiptFooter: z.string().max(200).optional(), receiptWidth: z.enum(['58', '80', 'a4']).optional(),
}).strict();
const featuresSchema = z.object({ inventoryWrites: z.boolean(), productWrites: z.boolean(), returns: z.boolean() }).partial().strict();
const stageSchema = z.object({ stage: z.enum(['read_only', 'selling']), confirm: z.boolean().optional() }).strict();
const HEALTH_MAX_AGE_MS = 24 * 3600000;

export function setupRoutes({ registry, shopId, origin, fetchImpl }) {
  return (app, { auth, role, sensitiveLimit }) => {
    const owner = [auth, role('owner')];
    const actor = req => `owner:${req.user.username}`;
    const shop = () => { const s = registry.byId(shopId); if (!s) throw new AppError('Shop not found.', 404); return s; };
    const view = s => ({
      name: s.name, slug: s.slug, stage: s.stage, storeUrl: s.storeUrl, trialEndsAt: s.trialEndsAt,
      connected: registry.hasSecret(s.id, 'woo_key') && registry.hasSecret(s.id, 'woo_secret'), connectedAt: s.connectedAt,
      health: s.health, healthAt: s.healthAt, business: s.business, features: s.features,
      photos: registry.hasSecret(s.id, 'wp_media_password'),
      till: (() => { const r = registry.tillRelease(); return r ? { version: r.version, url: r.url, sha256: r.sha256 } : null; })(),
    });
    app.get('/api/setup', ...owner, (_req, res) => res.json({ setup: view(shop()) }));
    app.post('/api/setup/woo/connect', ...owner, sensitiveLimit, (req, res) => {
      const s = shop();
      res.json({ url: authoriseUrl(s.storeUrl, origin, registry.startWooConnect(s.id, actor(req))) });
    });
    app.post('/api/setup/health', ...owner, sensitiveLimit, async (_req, res) => {
      const s = shop();
      const health = await storeHealthCheck({ storeUrl: s.storeUrl, keys: registry.secretsFor(s.id), fetchImpl });
      registry.setHealth(s.id, health);
      res.json({ setup: view(shop()) });
    });
    app.put('/api/setup/business', ...owner, sensitiveLimit, (req, res) => {
      const { name, ...business } = businessSchema.parse(req.body);
      registry.update(shopId, { ...(name ? { name } : {}), business }, actor(req));
      res.json({ setup: view(shop()) });
    });
    app.put('/api/setup/features', ...owner, sensitiveLimit, (req, res) => {
      registry.update(shopId, { features: featuresSchema.parse(req.body) }, actor(req));
      res.json({ setup: view(shop()) });
    });
    app.post('/api/setup/stage', ...owner, sensitiveLimit, (req, res) => {
      const { stage, confirm } = stageSchema.parse(req.body);
      const s = shop();
      if (!(registry.hasSecret(s.id, 'woo_key') && registry.hasSecret(s.id, 'woo_secret'))) throw new AppError('Connect your WooCommerce store first.', 409);
      if (stage === 'selling') {
        if (!s.health?.ok || !s.healthAt || Date.now() - Date.parse(s.healthAt) > HEALTH_MAX_AGE_MS) {
          throw new AppError('Run the store check again: it must pass within the last 24 hours before selling starts.', 409, 'HEALTH_REQUIRED');
        }
        if (confirm !== true) throw new AppError('Confirm that sales will create real WooCommerce orders and change website stock.', 400, 'CONFIRM_REQUIRED');
      }
      registry.update(shopId, { stage }, actor(req));
      res.json({ setup: view(shop()), reload: true });
    });
  };
}

// Feedback to Mansu POS from anyone signed in at a platform shop; the owner
// and managers see their shop's threads and replies.
const feedbackSchema = z.object({ kind: z.enum(['problem', 'idea', 'question']), message: z.string().max(2000), page: z.string().max(60).default('') }).strict();
export function feedbackRoutes({ registry, shopId }) {
  return (app, { auth, sensitiveLimit }) => {
    app.post('/api/feedback', auth, sensitiveLimit, (req, res) => {
      const input = feedbackSchema.parse(req.body);
      let id;
      try { id = registry.addFeedback({ shopId, kind: input.kind, message: input.message, fromUser: req.user.username, fromRole: req.user.role, page: input.page }); }
      catch (error) { throw new AppError(error.message, 400); }
      res.status(201).json({ ok: true, id });
    });
    app.get('/api/feedback', auth, (req, res) => {
      const all = registry.feedback({ status: 'all', shopId, limit: 50 }).map(({ shopId: _s, ...f }) => f);
      res.json({ feedback: req.user.role === 'cashier' ? all.filter(f => f.fromUser === req.user.username) : all });
    });
  };
}
