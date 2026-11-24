import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { slugProblem } from './slug.js';
import { normaliseStoreUrl } from './store-url.js';
import { sealSecret, openSecret } from './secrets.js';

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
      CREATE TABLE IF NOT EXISTS platform_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, shop_id TEXT, detail TEXT NOT NULL DEFAULT ''
      );
    `);
    // Columns added after phase 1: upgrade an existing registry in place.
    const columns = new Set(this.db.prepare('PRAGMA table_info(shops)').all().map(c => c.name));
    for (const [name, type] of [['owner_name', 'TEXT'], ['owner_email', 'TEXT'], ['owner_phone', 'TEXT'], ['trial_ends_at', 'TEXT'],
      ['connected_at', 'TEXT'], ['health', 'TEXT'], ['health_at', 'TEXT']]) {
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
