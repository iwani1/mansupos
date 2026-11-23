import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { slugProblem } from './slug.js';
import { normaliseStoreUrl } from './store-url.js';
import { sealSecret, openSecret } from './secrets.js';
import { PLANS, INTERVALS, addMonths } from './billing.js';

// The central database: which shops exist, their settings and their encrypted
// credentials. Each shop's sales, staff and history stay in that shop's own
// database under shops/<shop id>/ and never in here.
export const SECRET_KINDS = ['woo_key', 'woo_secret', 'wp_media_user', 'wp_media_password'];
export const STAGES = ['setup', 'read_only', 'selling'];
export const STATUSES = ['active', 'suspended', 'closed'];
export const FEATURES = ['inventoryWrites', 'productWrites', 'returns'];
const BUSINESS_FIELDS = { address: 200, phone: 60, taxId: 40, receiptFooter: 200, receiptWidth: 3 };
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function newShopId() {
  const bytes = randomBytes(20);
  return `shp_${[...bytes].map(byte => BASE32[byte & 31]).join('')}`;
}
const now = () => new Date().toISOString();
const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
const json = text => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
const oneLine = (value, max) => [...String(value ?? '')].map(ch => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('').trim().slice(0, max);

function shopView(row) {
  if (!row) return null;
  return {
    id: row.id, slug: row.slug, name: row.name, storeUrl: row.store_url, status: row.status, stage: row.stage,
    features: JSON.parse(row.features), business: JSON.parse(row.business),
    createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
    owner: { name: row.owner_name || '', email: row.owner_email || '', phone: row.owner_phone || '' },
    trialEndsAt: row.trial_ends_at || null, connectedAt: row.connected_at || null,
    health: json(row.health), healthAt: row.health_at || null,
    billing: { plan: row.plan || null, status: row.billing_status || null, paidUntil: row.paid_until || null, autoRenew: Boolean(row.auto_renew),
      customerCode: row.paystack_customer || null, subscriptionCode: row.paystack_subscription || null,
      discount: row.discount_percent > 0 && row.discount_until && Date.parse(row.discount_until) > Date.now() ? { percent: row.discount_percent, until: row.discount_until } : null },
  };
}

export class PlatformRegistry {
  constructor(config) {
    this.config = config;
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config.shopsDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(config.registryFile);
    fs.chmodSync(config.registryFile, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS shops (
        id TEXT PRIMARY KEY CHECK (id GLOB 'shp_*'),
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        store_url TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','suspended','closed')),
        stage TEXT NOT NULL CHECK (stage IN ('setup','read_only','selling')),
        features TEXT NOT NULL DEFAULT '{}',
        business TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shop_secrets (
        shop_id TEXT NOT NULL REFERENCES shops(id),
        kind TEXT NOT NULL CHECK (kind IN ('woo_key','woo_secret','wp_media_user','wp_media_password')),
        sealed TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (shop_id, kind)
      );
      CREATE TABLE IF NOT EXISTS woo_connect_requests (
        nonce_hash TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id),
        created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS signups (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL, payload TEXT NOT NULL,
        password_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at TEXT, shop_id TEXT
      );
      CREATE TABLE IF NOT EXISTS billing_checkouts (
        reference TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id), plan TEXT NOT NULL, interval TEXT NOT NULL,
        amount INTEGER NOT NULL, auto_renew INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, paid_at TEXT
      );
      CREATE TABLE IF NOT EXISTS billing_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, shop_id TEXT, kind TEXT NOT NULL,
        reference TEXT, amount INTEGER, at TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL, email TEXT, note TEXT NOT NULL DEFAULT '',
        discount_percent INTEGER NOT NULL DEFAULT 0, discount_months INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at TEXT, shop_id TEXT, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id TEXT NOT NULL REFERENCES shops(id), kind TEXT NOT NULL CHECK (kind IN ('problem','idea','question')),
        message TEXT NOT NULL, from_user TEXT NOT NULL, from_role TEXT NOT NULL, page TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')), resolved_by TEXT, resolved_at TEXT, reply TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, totp_sealed TEXT NOT NULL,
        last_totp_step INTEGER NOT NULL DEFAULT 0, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login TEXT
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id), created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, shop_id TEXT, detail TEXT NOT NULL DEFAULT ''
      );
    `);
    // Columns added after phase 1: upgrade an existing registry in place.
    const columns = new Set(this.db.prepare('PRAGMA table_info(shops)').all().map(c => c.name));
    for (const [name, type] of [['owner_name', 'TEXT'], ['owner_email', 'TEXT'], ['owner_phone', 'TEXT'], ['trial_ends_at', 'TEXT'],
      ['connected_at', 'TEXT'], ['health', 'TEXT'], ['health_at', 'TEXT'], ['plan', 'TEXT'], ['billing_status', 'TEXT'], ['paid_until', 'TEXT'],
      ['auto_renew', 'INTEGER'], ['paystack_customer', 'TEXT'], ['paystack_subscription', 'TEXT'], ['paystack_email_token', 'TEXT'],
      ['discount_percent', 'INTEGER'], ['discount_until', 'TEXT']]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE shops ADD COLUMN ${name} ${type}`);
    }
  }

  close() { this.db.close(); }

  audit(actor, action, shopId = null, detail = '') {
    this.db.prepare('INSERT INTO platform_audit(at,actor,action,shop_id,detail) VALUES (?,?,?,?,?)')
      .run(now(), oneLine(actor, 80) || 'system', action, shopId, oneLine(detail, 300));
  }

  shopDir(shop) {
    // Named by the generated id, never by the slug a person chose.
    if (!/^shp_[a-z2-7]{20}$/.test(shop.id)) throw new Error('Invalid shop id.');
    return path.join(this.config.shopsDir, shop.id);
  }

  createShop({ slug, name, storeUrl, owner = {}, trialDays = 0, actor = 'cli' }) {
    const problem = slugProblem(slug);
    if (problem) throw new Error(problem);
    const shopName = oneLine(name, 80);
    if (shopName.length < 2) throw new Error('Enter the shop name.');
    const origin = normaliseStoreUrl(storeUrl);
    if (this.db.prepare('SELECT 1 FROM shops WHERE slug=?').get(slug)) throw new Error('That address is already taken.');
    const id = newShopId();
    const time = now();
    const trialEnds = trialDays > 0 ? new Date(Date.now() + trialDays * 86400000).toISOString() : null;
    this.db.prepare(`INSERT INTO shops(id,slug,name,store_url,status,stage,features,business,created_at,updated_at,owner_name,owner_email,owner_phone,trial_ends_at)
      VALUES (?,?,?,?, 'active','setup','{}','{}',?,?,?,?,?,?)`).run(id, slug, shopName, origin, time, time,
      oneLine(owner.name, 80) || null, oneLine(owner.email, 120).toLowerCase() || null, oneLine(owner.phone, 40) || null, trialEnds);
    this.audit(actor, 'shop.created', id, slug);
    return this.byId(id);
  }

  byId(id) { return shopView(this.db.prepare('SELECT * FROM shops WHERE id=?').get(String(id))); }
  bySlug(slug) { return shopView(this.db.prepare('SELECT * FROM shops WHERE slug=?').get(String(slug))); }
  list() { return this.db.prepare('SELECT * FROM shops ORDER BY created_at').all().map(shopView); }

  update(id, change, actor = 'cli') {
    const shop = this.byId(id);
    if (!shop) throw new Error('Shop not found.');
    const next = { ...shop };
    if (change.status !== undefined) {
      if (!STATUSES.includes(change.status)) throw new Error('Unknown status.');
      next.status = change.status;
    }
    if (change.stage !== undefined) {
      if (!STAGES.includes(change.stage)) throw new Error('Unknown stage.');
      if (change.stage === 'selling' && !(this.hasSecret(id, 'woo_key') && this.hasSecret(id, 'woo_secret'))) {
        throw new Error('Connect the WooCommerce store (key and secret) before turning on selling.');
      }
      next.stage = change.stage;
    }
    if (change.name !== undefined) next.name = oneLine(change.name, 80);
    if (change.features) {
      for (const [key, value] of Object.entries(change.features)) {
        if (!FEATURES.includes(key) || typeof value !== 'boolean') throw new Error(`Unknown feature setting: ${key}.`);
        next.features = { ...next.features, [key]: value };
      }
    }
    if (change.business) {
      for (const [key, value] of Object.entries(change.business)) {
        if (!(key in BUSINESS_FIELDS)) throw new Error(`Unknown business detail: ${key}.`);
        const text = oneLine(value, BUSINESS_FIELDS[key]);
        if (key === 'receiptWidth' && text && !['58', '80', 'a4'].includes(text)) throw new Error('Receipt width must be 58, 80 or a4.');
        next.business = { ...next.business, [key]: text };
      }
    }
    this.db.prepare(`UPDATE shops SET name=?,status=?,stage=?,features=?,business=?,version=version+1,updated_at=? WHERE id=?`)
      .run(next.name, next.status, next.stage, JSON.stringify(next.features), JSON.stringify(next.business), now(), id);
    this.audit(actor, 'shop.updated', id, Object.keys(change).join(','));
    return this.byId(id);
  }

  setSecret(id, kind, value, actor = 'cli') {
    if (!SECRET_KINDS.includes(kind)) throw new Error('Unknown secret kind.');
    if (!this.byId(id)) throw new Error('Shop not found.');
    const text = String(value ?? '').trim();
    if (!text || text.length > 512) throw new Error('Secret value is empty or too long.');
    const sealed = sealSecret(this.config.masterKey, id, kind, text);
    this.db.prepare(`INSERT INTO shop_secrets(shop_id,kind,sealed,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(shop_id,kind) DO UPDATE SET sealed=excluded.sealed, updated_at=excluded.updated_at`).run(id, kind, sealed, now());
    // A credential change must reach a shop that is already open.
    this.db.prepare('UPDATE shops SET version=version+1, updated_at=? WHERE id=?').run(now(), id);
    this.audit(actor, 'secret.set', id, kind);
  }

  // One-time code linking a WooCommerce "authorise app" callback to this shop.
  startWooConnect(id, actor = 'owner') {
    const nonce = newToken();
    this.db.prepare('INSERT INTO woo_connect_requests(nonce_hash,shop_id,created_at,expires_at) VALUES (?,?,?,?)')
      .run(tokenHash(nonce), id, now(), Date.now() + 30 * 60000);
    this.audit(actor, 'woo.connect_started', id);
    return nonce;
  }

  // Valid only for this shop, unused and unexpired; consumed by the call.
  consumeWooConnect(id, nonce) {
    if (typeof nonce !== 'string' || nonce.length < 20 || nonce.length > 100) return false;
    const result = this.db.prepare(`UPDATE woo_connect_requests SET used_at=? WHERE nonce_hash=? AND shop_id=? AND used_at IS NULL AND expires_at>?`)
      .run(now(), tokenHash(nonce), id, Date.now());
    return result.changes === 1;
  }

  markConnected(id, actor = 'woocommerce') {
    const shop = this.byId(id);
    this.db.prepare(`UPDATE shops SET connected_at=?, stage=CASE WHEN stage='setup' THEN 'read_only' ELSE stage END,
      version=version+1, updated_at=? WHERE id=?`).run(now(), now(), id);
    this.audit(actor, 'woo.connected', id, shop?.stage === 'setup' ? 'stage setup -> read_only' : '');
  }

  setHealth(id, result) {
    this.db.prepare('UPDATE shops SET health=?, health_at=? WHERE id=?').run(JSON.stringify(result), now(), id);
  }

  createSignup({ email, payload, passwordHash }) {
    const token = newToken();
    const id = `sgn_${randomBytes(10).toString('hex')}`;
    this.db.prepare('DELETE FROM signups WHERE expires_at < ?').run(Date.now() - 7 * 86400000);
    this.db.prepare('INSERT INTO signups(id,token_hash,email,payload,password_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, tokenHash(token), email, JSON.stringify(payload), passwordHash, now(), Date.now() + 24 * 3600000);
    return { id, token };
  }

  signupByToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const row = this.db.prepare('SELECT * FROM signups WHERE token_hash=?').get(tokenHash(token));
    if (!row) return null;
    return { id: row.id, email: row.email, payload: json(row.payload), passwordHash: row.password_hash,
      expired: row.expires_at < Date.now(), usedAt: row.used_at, shopId: row.shop_id };
  }

  // Claimed once: a second click on the same link finds it used.
  claimSignup(id) {
    return this.db.prepare('UPDATE signups SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?').run(now(), id, Date.now()).changes === 1;
  }

  attachSignupShop(id, shopId) { this.db.prepare('UPDATE signups SET shop_id=? WHERE id=?').run(shopId, id); }

  // ---- Invites (pilot: sign-up by invitation only) --------------------------
  createInvite({ email = '', note = '', discountPercent = 0, discountMonths = 0, days = 30 }, actor) {
    if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 90) throw new Error('Discount must be 0 to 90 percent.');
    if (!Number.isInteger(discountMonths) || discountMonths < 0 || discountMonths > 24) throw new Error('Discount months must be 0 to 24.');
    if (Boolean(discountPercent) !== Boolean(discountMonths)) throw new Error('Give both a discount percent and a number of months, or neither.');
    const raw = [...randomBytes(8)].map(byte => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[byte % 32]).join('');
    const code = `MANSU-${raw.slice(0, 4)}-${raw.slice(4)}`;
    const id = `inv_${randomBytes(6).toString('hex')}`;
    const mail = oneLine(email, 120).toLowerCase();
    if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('That email address does not look right.');
    this.db.prepare(`INSERT INTO invites(id,code_hash,hint,email,note,discount_percent,discount_months,created_by,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, tokenHash(code), code.slice(-4), mail || null, oneLine(note, 200), discountPercent, discountMonths, actor, now(), Date.now() + days * 86400000);
    this.audit(actor, 'invite.created', null, `${id} ${mail || 'any email'}${discountPercent ? ` ${discountPercent}% x${discountMonths}m` : ''}`);
    return { id, code };
  }

  // A usable invite for this code (and email, when the invite names one).
  invite(code, email) {
    const row = this.db.prepare('SELECT * FROM invites WHERE code_hash=?').get(tokenHash(String(code || '').trim().toUpperCase()));
    if (!row || row.used_at || row.revoked_at || row.expires_at < Date.now()) return null;
    if (row.email && row.email !== String(email || '').toLowerCase()) return null;
    return { id: row.id, email: row.email, discountPercent: row.discount_percent, discountMonths: row.discount_months };
  }

  claimInvite(id, shopId) {
    return this.db.prepare('UPDATE invites SET used_at=?, shop_id=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?')
      .run(now(), shopId, id, Date.now()).changes === 1;
  }

  revokeInvite(id, actor) {
    const changed = this.db.prepare('UPDATE invites SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL').run(now(), id).changes === 1;
    if (changed) this.audit(actor, 'invite.revoked', null, id);
    return changed;
  }

  invites() {
    return this.db.prepare('SELECT id, hint, email, note, discount_percent AS discountPercent, discount_months AS discountMonths, created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt, used_at AS usedAt, shop_id AS shopId, revoked_at AS revokedAt FROM invites ORDER BY created_at DESC LIMIT 200').all()
      .map(row => ({ ...row, status: row.revokedAt ? 'revoked' : row.usedAt ? 'used' : row.expiresAt < Date.now() ? 'expired' : 'open', expiresAt: new Date(row.expiresAt).toISOString() }));
  }

  setDiscount(shopId, { percent, months }, actor) {
    if (!Number.isInteger(percent) || percent < 0 || percent > 90 || !Number.isInteger(months) || months < 0 || months > 24) throw new Error('Discount 0 to 90 percent for 0 to 24 months.');
    const until = percent && months ? new Date(addMonths(Date.now(), months)).toISOString() : null;
    this.db.prepare('UPDATE shops SET discount_percent=?, discount_until=?, version=version+1, updated_at=? WHERE id=?').run(percent || null, until, now(), shopId);
    this.audit(actor, 'billing.discount', shopId, percent ? `${percent}% until ${until}` : 'removed');
    return this.byId(shopId);
  }

  // ---- Feedback from shops ----------------------------------------------------
  addFeedback({ shopId, kind, message, fromUser, fromRole, page = '' }) {
    if (!['problem', 'idea', 'question'].includes(kind)) throw new Error('Unknown feedback kind.');
    const text = String(message || '').replace(/\r/g, '').trim().slice(0, 2000);
    if (text.length < 5) throw new Error('Write a little more so we can help.');
    const recent = this.db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE shop_id=? AND created_at>?").get(shopId, new Date(Date.now() - 3600000).toISOString()).n;
    if (recent >= 20) throw new Error('Too much feedback from this shop in the last hour. Please try later.');
    const id = this.db.prepare('INSERT INTO feedback(shop_id,kind,message,from_user,from_role,page,created_at) VALUES (?,?,?,?,?,?,?) RETURNING id')
      .get(shopId, kind, text, oneLine(fromUser, 80), oneLine(fromRole, 20), oneLine(page, 60), now()).id;
    this.audit(`staff:${oneLine(fromUser, 80)}`, 'feedback.sent', shopId, `${kind} #${id}`);
    return id;
  }
  feedback({ status = 'open', shopId = null, limit = 200 } = {}) {
    const where = [], args = [];
    if (status !== 'all') { where.push('status=?'); args.push(status); }
    if (shopId) { where.push('shop_id=?'); args.push(shopId); }
    return this.db.prepare(`SELECT id, shop_id AS shopId, kind, message, from_user AS fromUser, from_role AS fromRole, page, created_at AS createdAt, status, resolved_by AS resolvedBy, resolved_at AS resolvedAt, reply
      FROM feedback ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit);
  }
  resolveFeedback(id, reply, actor) {
    const changed = this.db.prepare("UPDATE feedback SET status='resolved', resolved_by=?, resolved_at=?, reply=? WHERE id=? AND status='open'").run(actor, now(), oneLine(reply, 500), id).changes === 1;
    if (changed) this.audit(actor, 'feedback.resolved', null, `#${id}`);
    return changed;
  }

  // ---- Billing -------------------------------------------------------------
  setting(key) { return this.db.prepare('SELECT value FROM platform_settings WHERE key=?').get(key)?.value ?? null; }
  setSetting(key, value) {
    this.db.prepare('INSERT INTO platform_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }
  // Windows till release notice: { version, url, sha256, notes, publishedAt }.
  tillRelease() { try { return JSON.parse(this.setting('till_release') || 'null'); } catch { return null; } }
  setTillRelease({ version, url, sha256, notes = '' }, actor = 'cli') {
    if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(version))) throw new Error('Version must look like 2.0.0.');
    const link = new URL(String(url));
    if (link.protocol !== 'https:') throw new Error('The download must be an https:// address.');
    if (!/^[0-9a-f]{64}$/i.test(String(sha256))) throw new Error('Give the installer\'s SHA-256 (64 hex characters).');
    const release = { version: String(version), url: link.toString(), sha256: String(sha256).toLowerCase(), notes: oneLine(notes, 400), publishedAt: now() };
    this.setSetting('till_release', JSON.stringify(release));
    this.audit(actor, 'till.release', null, `${release.version} ${release.url}`);
    return release;
  }

  planCode(plan, interval) { return this.setting(`paystack_plan:${plan}:${interval}`); }
  planForCode(code) {
    const row = this.db.prepare("SELECT key FROM platform_settings WHERE key LIKE 'paystack_plan:%' AND value=?").get(String(code || ''));
    if (!row) return null;
    const [, plan, interval] = row.key.split(':');
    return { plan, interval };
  }

  createCheckout({ shopId, plan, interval, amount, autoRenew }) {
    const reference = `mp_${shopId.slice(4, 12)}_${randomBytes(9).toString('hex')}`;
    this.db.prepare('INSERT INTO billing_checkouts(reference,shop_id,plan,interval,amount,auto_renew,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(reference, shopId, plan, interval, amount, autoRenew ? 1 : 0, now());
    return reference;
  }
  checkout(reference) { return this.db.prepare('SELECT * FROM billing_checkouts WHERE reference=?').get(String(reference || '')) || null; }

  // Records a billing event once (Paystack retries webhooks; owners refresh the
  // return page). Returns false when this event was already handled.
  billingEvent({ key, shopId, kind, reference = null, amount = null, detail = '' }) {
    return this.db.prepare('INSERT OR IGNORE INTO billing_events(event_key,shop_id,kind,reference,amount,at,detail) VALUES (?,?,?,?,?,?,?)')
      .run(String(key), shopId, kind, reference, amount, now(), oneLine(detail, 300)).changes === 1;
  }
  billingEvents(shopId, limit = 50) {
    return this.db.prepare('SELECT kind, reference, amount, at, detail FROM billing_events WHERE shop_id=? ORDER BY id DESC LIMIT ?').all(shopId, limit);
  }

  // One verified payment extends access by its period, starting after any time
  // already covered (remaining trial or an earlier payment). Idempotent by
  // reference.
  recordPayment({ shopId, plan, interval, reference, amount, actor = 'paystack', customerCode, autoRenew }) {
    if (!PLANS[plan] || !INTERVALS[interval]) throw new Error('Unknown plan or billing period.');
    const shop = this.byId(shopId);
    if (!shop) throw new Error('Shop not found.');
    if (!this.billingEvent({ key: `payment:${reference}`, shopId, kind: 'payment', reference, amount, detail: `${plan}/${interval} by ${actor}` })) return false;
    const start = Math.max(Date.now(), shop.trialEndsAt ? Date.parse(shop.trialEndsAt) : 0, shop.billing.paidUntil ? Date.parse(shop.billing.paidUntil) : 0);
    const paidUntil = new Date(addMonths(start, INTERVALS[interval].months)).toISOString();
    this.db.prepare(`UPDATE shops SET plan=?, billing_status='active', paid_until=?, auto_renew=COALESCE(?, auto_renew),
      paystack_customer=COALESCE(?, paystack_customer), version=version+1, updated_at=? WHERE id=?`)
      .run(plan, paidUntil, autoRenew === undefined ? null : (autoRenew ? 1 : 0), customerCode || null, now(), shopId);
    this.db.prepare('UPDATE billing_checkouts SET paid_at=? WHERE reference=?').run(now(), reference);
    this.audit(actor, 'billing.payment', shopId, `${plan}/${interval} ${amount} until ${paidUntil}`);
    return true;
  }

  setBilling(shopId, change, actor) {
    const fields = { plan: 'plan', status: 'billing_status', paidUntil: 'paid_until', autoRenew: 'auto_renew', subscriptionCode: 'paystack_subscription', emailToken: 'paystack_email_token', customerCode: 'paystack_customer', trialEndsAt: 'trial_ends_at' };
    const sets = [], values = [];
    for (const [key, value] of Object.entries(change)) {
      if (!(key in fields)) throw new Error(`Unknown billing field: ${key}.`);
      if (key === 'plan' && !PLANS[value]) throw new Error('Unknown plan.');
      sets.push(`${fields[key]}=?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (!sets.length) return this.byId(shopId);
    this.db.prepare(`UPDATE shops SET ${sets.join(',')}, version=version+1, updated_at=? WHERE id=?`).run(...values, now(), shopId);
    this.audit(actor, 'billing.updated', shopId, Object.keys(change).join(','));
    return this.byId(shopId);
  }

  byCustomer(code) { return shopView(this.db.prepare('SELECT * FROM shops WHERE paystack_customer=?').get(String(code || ''))); }
  bySubscription(code) { return shopView(this.db.prepare('SELECT * FROM shops WHERE paystack_subscription=?').get(String(code || ''))); }
  emailToken(shopId) { return this.db.prepare('SELECT paystack_email_token AS t FROM shops WHERE id=?').get(shopId)?.t || null; }

  recentAudit(limit = 100, shopId = null) {
    return shopId
      ? this.db.prepare('SELECT at, actor, action, shop_id AS shopId, detail FROM platform_audit WHERE shop_id=? ORDER BY id DESC LIMIT ?').all(shopId, limit)
      : this.db.prepare('SELECT at, actor, action, shop_id AS shopId, detail FROM platform_audit ORDER BY id DESC LIMIT ?').all(limit);
  }

  hasSecret(id, kind) { return Boolean(this.db.prepare('SELECT 1 FROM shop_secrets WHERE shop_id=? AND kind=?').get(id, kind)); }

  // Decrypted credentials for opening one shop. Throws (fails closed) if any
  // stored value does not authenticate for exactly this shop and kind.
  secretsFor(id) {
    const out = {};
    for (const row of this.db.prepare('SELECT kind, sealed FROM shop_secrets WHERE shop_id=?').all(id)) {
      out[row.kind] = openSecret(this.config.masterKey, id, row.kind, row.sealed);
    }
    return out;
  }
}
