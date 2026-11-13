import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../server/passwords.js';
import { prepareSchema, paymentSchema, normalizeItems } from '../server/sale-inputs.js';
import { AppError } from '../server/errors.js';
import { bootstrapSchema, grantSchema, returnInputSchema, syncEventSchema } from './contracts.js';

const SCHEMA = 2;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = () => new Date().toISOString();
const management = user => ['owner', 'manager'].includes(user?.role);
const clockProblem = () => new AppError('The computer clock moved backwards. Reconnect for an owner review before selling.', 403, 'CLOCK_REVIEW');
const locked = () => new AppError('Offline checkout needs a verified Woo reservation and an unexpired allocation for this till. No sale was recorded.', 403, 'OFFLINE_CHECKOUT_LOCKED');
const permit = condition => { if (!condition) throw new AppError('Your staff role does not allow this action.', 403, 'ROLE_DENIED'); };
const lineKey = (productId, variationId = 0) => `${productId}:${variationId}`;

export function openDesktopDatabase(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'desktop-ledger.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  try { fs.chmodSync(filename, 0o600); } catch { /* Windows userData uses the current Windows user's ACL. */ }
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
    const current = db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get().version;
    if (current > SCHEMA) throw new Error('Desktop ledger was created by a newer version. Never downgrade or overwrite it.');
    if (current < 1) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          CREATE TABLE settings (key TEXT PRIMARY KEY, value BLOB NOT NULL);
          CREATE TABLE staff (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('owner','manager','cashier')), password_hash TEXT NOT NULL,
            active INTEGER NOT NULL CHECK(active IN (0,1)), offline_until TEXT NOT NULL);
          CREATE TABLE catalog (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL, fetched_at TEXT NOT NULL);
          CREATE TABLE wholesale_cache (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL);
          CREATE TABLE allocations (stock_key TEXT PRIMARY KEY, product_id INTEGER NOT NULL, variation_id INTEGER NOT NULL,
            remaining INTEGER NOT NULL CHECK(remaining>=0), revision INTEGER NOT NULL, expires_at TEXT NOT NULL);
          CREATE TABLE sales (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
            sale_type TEXT NOT NULL, cashier_id TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL,
            refunded INTEGER NOT NULL DEFAULT 0, payload BLOB NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE returns (id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), fingerprint TEXT NOT NULL,
            payload BLOB NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, sale_id TEXT NOT NULL REFERENCES sales(id),
            kind TEXT NOT NULL CHECK(kind IN ('sale','return')), fingerprint TEXT NOT NULL, payload BLOB NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','retry','conflict','acked')),
            attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT NOT NULL DEFAULT '', acked_at TEXT);
          CREATE TABLE movements (seq INTEGER PRIMARY KEY AUTOINCREMENT, stock_key TEXT NOT NULL, delta INTEGER NOT NULL,
            balance_after INTEGER NOT NULL CHECK(balance_after>=0), kind TEXT NOT NULL, event_id TEXT NOT NULL,
            actor_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(event_id,stock_key));
          CREATE TABLE customers (id TEXT PRIMARY KEY, payload BLOB NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
          CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
            subject TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE INDEX idx_queue_state ON queue(state,seq);
          CREATE INDEX idx_sales_created ON sales(created_at DESC,seq DESC);
          CREATE INDEX idx_movements_stock ON movements(stock_key,seq);
        `);
        db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (1,?)').run(time());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (current < 2) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('CREATE TABLE IF NOT EXISTS image_map (url TEXT PRIMARY KEY, filename TEXT NOT NULL);');
        db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (2,?)').run(time());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Desktop ledger integrity check failed. Stop and restore from a verified backup.');
    return db;
  } catch (error) { db.close(); throw error; }
}

// The codec must be OS-backed DPAPI on a packaged Windows application. Tests
// inject a deterministic codec; plaintext fallback is deliberately forbidden.
export class DesktopStore {
  constructor(db, codec, remote, { practiceMode = false } = {}) {
    if (!codec?.encryptString || !codec?.decryptString || !remote?.request || !remote?.validateOrigin ||
        !remote?.expectedService?.mode || !remote?.expectedService?.storeUrl) {
      throw new Error('Protected local storage and an explicitly identified transport are required.');
    }
    this.db = db; this.codec = codec; this.remote = remote;
    // Only the separately packaged QA shell opts in; the normal till remains
    // unchanged and never reads a practice ledger or issues practice numbers.
    this.practiceMode = practiceMode === true;
    this.userData = path.dirname(db.location());
    this.user = null; this.prepared = new Map(); this.syncing = false;
  }
  seal(value) { return this.codec.encryptString(JSON.stringify(value)); }
  unseal(blob) { return JSON.parse(this.codec.decryptString(blob)); }
  setting(key) { return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value?.toString() || ''; }
  put(key, value) { this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  audit(action, subject) { this.db.prepare('INSERT INTO audit(actor,action,subject,created_at) VALUES (?,?,?,?)').run(this.user?.id || 'system', action, String(subject), time()); }
  requireUser() {
    if (!this.user) throw new AppError('Sign in on this computer to continue.', 401, 'LOGIN_REQUIRED');
    const row = this.db.prepare('SELECT * FROM staff WHERE id=? AND active=1').get(this.user.id);
    if (!row || Date.parse(row.offline_until) <= Date.now()) { this.user = null; this.prepared.clear(); throw new AppError('Offline sign-in expired. Reconnect and sign in online.', 401, 'OFFLINE_LOGIN_EXPIRED'); }
    return this.user;
  }
  hasAccount() { return Boolean(this.db.prepare('SELECT 1 FROM staff LIMIT 1').get()); }
  pendingAllocation() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='pendingAllocation'").get();
    return row ? this.unseal(row.value) : null;
  }
  deviceId() { return this.setting('deviceId') || randomUUID(); }
  async connect({ origin, username, password }) {
    // Reject an unapproved host BEFORE sending even the first staff credential.
    // The central transport repeats the check as a defense-in-depth boundary.
    const url = new URL(this.remote.validateOrigin(origin));
    z.string().min(1).max(80).parse(username); z.string().min(12).max(256).parse(password);
    const existingOrigin = this.setting('origin');
    if (existingOrigin && existingOrigin !== url.origin) throw new AppError('This device belongs to a different POS service. Do not reconnect it to another ledger.', 409, 'DEVICE_BINDING');
    const signed = await this.remote.request(url.origin, '', '/auth/login', 'POST', { username, password });
    const { user, token, config } = signed;
    if (!user?.id || !['owner','manager','cashier'].includes(user.role) || user.mustChangePassword || !token ||
        config?.mode !== this.remote.expectedService.mode || config?.storeUrl !== this.remote.expectedService.storeUrl) {
      throw new AppError('Use a fully activated account on the separate live trading service, not the demo or read-only catalogue pilot.', 403, 'WRONG_SERVICE');
    }
    if (!this.hasAccount() && user.role !== 'owner') throw new AppError('An owner must enroll this computer first.', 403);
    if (this.hasAccount() && !this.db.prepare('SELECT 1 FROM staff WHERE id=?').get(user.id) && user.role !== 'owner') {
      throw new AppError('An owner must provision new staff on this computer while connected.', 403);
    }
    const deviceId = this.deviceId();
    // Persist the ID before the first network enrolment. If the bootstrap
    // response is lost, a retry MUST use the same ID (one till only).
    if (!this.setting('deviceId')) this.put('deviceId', deviceId);
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key='deviceSecret'").get()) {
      if (user.role !== 'owner') throw new AppError('An owner must finish enrolling this till before staff can connect.', 403);
      const enrolled = await this.remote.request(url.origin, token, '/desktop/enroll', 'POST', { deviceId });
      if (enrolled?.deviceId !== deviceId || !/^[a-f0-9]{64}$/.test(enrolled.deviceSecret || '')) {
        throw new AppError('The central service did not confirm this device signing key.', 409, 'DEVICE_MISMATCH');
      }
      this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('deviceSecret',this.seal(enrolled.deviceSecret));
    }
    // An online sign-in must also work after a lease expires, so a queued
    // receipt can be synced. While any event is pending, do not ask Woo for
    // new balances or renew selling authority: the public pool has not yet
    // accounted for this till's completed local sales. Sign in for recovery,
    // preserve the exact local allocation and require sync + explicit refresh.
    const outstanding = this.db.prepare("SELECT 1 FROM queue WHERE state<>'acked' LIMIT 1").get();
    let bootstrap;
    if (!outstanding) {
      const snapshot = await this.remote.request(url.origin, token, `/desktop/bootstrap?deviceId=${deviceId}`, 'GET');
      bootstrap = bootstrapSchema.parse(snapshot);
      if (bootstrap.deviceId !== deviceId) throw new AppError('The central service returned a different device. No data was changed.', 409, 'DEVICE_MISMATCH');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Another IPC checkout may commit while the remote bootstrap is in
      // flight. Under the writer lock, downgrade to recovery-only rather than
      // installing a Woo snapshot that predates a just-collected cash sale.
      const installSnapshot = Boolean(bootstrap && !this.db.prepare("SELECT 1 FROM queue WHERE state<>'acked' LIMIT 1").get());
      this.put('origin', url.origin); this.put('deviceId', deviceId);
      this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('centralToken', this.seal(token));
      // Staff authentication is a separate 24-hour window. An expired stock
      // lease blocks NEW sales, not viewing/syncing already committed cash.
      const until = new Date(Date.now() + 24 * 3600000).toISOString();
      this.db.prepare(`INSERT INTO staff(id,username,name,role,password_hash,active,offline_until) VALUES (?,?,?,?,?,1,?)
        ON CONFLICT(id) DO UPDATE SET username=excluded.username,name=excluded.name,role=excluded.role,password_hash=excluded.password_hash,active=1,offline_until=excluded.offline_until`)
        .run(user.id, user.username, user.name, user.role, hashPassword(password), until);
      if (!management(user)) this.db.prepare('DELETE FROM wholesale_cache').run();
      if (installSnapshot) {
        this.db.prepare('INSERT INTO catalog(id,payload,fetched_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at')
          .run(this.seal(bootstrap.catalog), bootstrap.catalog.fetchedAt);
        // Never retain private price defaults when a cashier provisions or logs
        // in. The central service also omits them for cashiers.
        if (management(user)) this.db.prepare('INSERT INTO wholesale_cache(id,payload) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(this.seal(bootstrap.wholesalePrices));
        this.db.prepare('DELETE FROM allocations').run();
        for (const grant of bootstrap.grants) this.db.prepare('INSERT INTO allocations(stock_key,product_id,variation_id,remaining,revision,expires_at) VALUES (?,?,?,?,?,?)')
          .run(grant.stockKey, grant.productId, grant.variationId, grant.remaining, grant.revision, grant.expiresAt);
        this.put('canSell', bootstrap.canSell ? 'true' : 'false');
        this.put('canWholesale', bootstrap.canWholesale ? 'true' : 'false');
        this.put('leaseExpiresAt', bootstrap.leaseExpiresAt);
        this.put('lastClock', String(Date.now()));
      } else {
        this.put('canSell','false'); this.put('canWholesale','false');
      }
      this.db.prepare('INSERT INTO audit(actor,action,subject,created_at) VALUES (?,?,?,?)')
        .run(user.id,installSnapshot?'desktop.provisioned':'desktop.recovery_signin',deviceId,time());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.user = { id: user.id, username: user.username, name: user.name, role: user.role };
    this.prepared.clear();
    return this.session();
  }
  login({ username, password }) {
    const row = this.db.prepare('SELECT * FROM staff WHERE username=? AND active=1').get(String(username || '').trim());
    if (!row || !verifyPassword(password, row.password_hash)) throw new AppError('Username or password is incorrect on this computer.', 401);
    if (Date.parse(row.offline_until) <= Date.now()) throw new AppError('Offline access expired. Reconnect to the trading service and sign in online.', 401, 'OFFLINE_LOGIN_EXPIRED');
    this.user = { id: row.id, username: row.username, name: row.name, role: row.role };
    this.audit('desktop.login', row.id);
    return this.session();
  }
  logout() { this.audit('desktop.logout', this.user?.id || ''); this.user = null; this.prepared.clear(); return { ok: true }; }
  leaseValid() {
    return Boolean(this.user && this.setting('canSell') === 'true' &&
      Date.parse(this.setting('leaseExpiresAt')) > Date.now() &&
      Number(this.setting('lastClock')) <= Date.now() + 5 * 60000);
  }
  eligible() {
    return this.leaseValid() && Boolean(this.db.prepare('SELECT 1 FROM allocations WHERE remaining>0 AND expires_at>? LIMIT 1').get(time()));
  }
  session() {
    const user = this.user ? this.requireUser() : null;
    return { user, provisioned:this.hasAccount(), config: {
      mode: 'desktop', version: '1.2.3',
      businessName: this.practiceMode ? 'MansutRENDZGH PRACTICE' : 'MansutRENDZGH',
      ...(this.practiceMode ? { practiceMode: true } : {}), currency: 'GHS', receiptWidth: '80',
      receiptFooter: this.practiceMode ? 'SIMULATION ONLY — NO MONEY COLLECTED OR GOODS RELEASED.' : 'Thank you for shopping with MansutRENDZGH.', paymentMethods: ['cash'],
      writesEnabled: user ? this.eligible() : false, wholesaleWritesEnabled: Boolean(management(user) && this.eligible() && this.setting('canWholesale') === 'true'),
      requireShift: false, lowStockThreshold: 5, storeUrl: this.remote.expectedService.storeUrl,
    }, deviceId: this.setting('deviceId') || null, origin: this.setting('origin') || '',
      leaseExpiresAt: this.setting('leaseExpiresAt') || null,
      pendingAllocation: user?.role === 'owner' ? this.pendingAllocation() : null };
  }
  rawCatalog() {
    const row = this.db.prepare('SELECT payload FROM catalog WHERE id=1').get();
    if (!row) return { products: [], source: 'woocommerce', complete: false, stale: true, error: 'Connect an owner to cache the Woo catalogue and obtain an offline reservation.' };
    return this.unseal(row.payload);
  }
  catalog() {
    this.requireUser();
    const source = this.rawCatalog();
    const allocations = new Map(this.db.prepare('SELECT * FROM allocations').all().map(row => [row.stock_key, row]));
    const authority = this.eligible();
    const images = new Map(this.db.prepare('SELECT * FROM image_map').all().map(row => [row.url, row.filename]));
    const localImage = url => images.has(url) ? `app://mansu/image/${images.get(url)}` : '';
    const option = (product, item, variationId) => {
      const key = item.stockSource === 'parent' ? lineKey(product.id, 0) : lineKey(product.id, variationId);
      const grant = allocations.get(key);
      const usable = authority && grant && Date.parse(grant.expires_at) > Date.now() &&
        item.manageStock === true && !item.backordersAllowed && !['yes','notify'].includes(item.backorders) &&
        item.stockSource !== 'unknown' && item.stockSource !== 'untracked' && item.purchasable !== false;
      const stock = usable ? grant.remaining : 0;
      return { ...item, image: localImage(item.image), manageStock: true, stock, stockStatus: stock > 0 ? 'instock' : 'outofstock',
        purchasable: Boolean(usable && stock > 0), backorders: 'no', backordersAllowed: false };
    };
    return { ...source, offlineAllocation: true, fetchedAt: source.fetchedAt,
      products: source.products.map(p => {
        if (p.type === 'variable') {
          const variations = p.variations.map(v => option(p, v, v.id));
          return { ...p, image: localImage(p.image), variations, stockStatus: variations.some(v => v.stock > 0) ? 'instock' : 'outofstock',
            purchasable: variations.some(v => v.purchasable) };
        }
        return { ...p, ...option(p, p, 0) };
      }),
    };
  }
  rememberImage(url, filename) {
    if (!/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(filename)) throw new Error('Invalid cached image identity.');
    this.db.prepare('INSERT INTO image_map(url,filename) VALUES (?,?) ON CONFLICT(url) DO UPDATE SET filename=excluded.filename').run(url,filename);
  }
  wholesalePrices() { permit(management(this.requireUser())); const row = this.db.prepare('SELECT payload FROM wholesale_cache WHERE id=1').get(); return { prices: row ? this.unseal(row.payload) : [] }; }
  getPrepared(id) { return this.prepared.get(id); }
  prepare(input) {
    const user = this.requireUser();
    if (Number(this.setting('lastClock')) > Date.now() + 5 * 60000) throw clockProblem();
    if (!this.eligible()) throw locked();
    const value = prepareSchema.parse(input);
    if (value.saleType === 'wholesale') {
      permit(management(user));
      if (this.setting('canWholesale') !== 'true') throw new AppError('Wholesale requires separate live approval. No sale was recorded.', 403, 'WHOLESALE_CHECKOUT_LOCKED');
    }
    const id = value.idempotencyKey;
    const existing = this.db.prepare('SELECT * FROM sales WHERE id=?').get(id);
    if (existing) return this.view(existing);
    const items = normalizeItems(value.items);
    const products = new Map(this.catalog().products.map(p => [p.id, p]));
    let total = 0;
    const lines = items.map(item => {
      const p = products.get(item.productId);
      const v = item.variationId ? p?.variations.find(x => x.id === item.variationId) : null;
      if (!p || (p.type === 'variable' && !v) || (p.type !== 'variable' && item.variationId)) throw new AppError('Product or option is missing from the approved snapshot.', 409);
      const source = v || p;
      const stockKey = source.stockSource === 'parent' ? lineKey(p.id, 0) : lineKey(p.id, item.variationId);
      const grant = this.db.prepare('SELECT * FROM allocations WHERE stock_key=?').get(stockKey);
      if (!grant || grant.remaining < item.quantity || Date.parse(grant.expires_at) <= Date.now() || !source.purchasable ||
          !Number.isSafeInteger(source.price) || source.price < 1) throw new AppError('Allocated stock or price changed. Review the cart before collecting payment.', 409, 'ALLOCATED_STOCK_CHANGED');
      if (p.soldIndividually && items.filter(i => i.productId === p.id).reduce((n, i) => n + i.quantity, 0) > 1) throw new AppError('This product is limited to one per sale.', 409);
      const unit = value.saleType === 'wholesale' ? item.agreedUnitPrice : source.price;
      total += unit * item.quantity;
      return { productId: p.id, variationId: item.variationId, stockKey, name: p.name, label: v?.label || '',
        sku: source.sku || '', image: source.image || '', quantity: item.quantity, price: source.price,
        ...(value.saleType === 'wholesale' ? { agreedUnitPrice: unit, agreedLineTotal: unit * item.quantity, cataloguePrice: source.price } : { total: unit * item.quantity }) };
    });
    const poolQuantities = new Map();
    for (const line of lines) poolQuantities.set(line.stockKey,(poolQuantities.get(line.stockKey)||0)+line.quantity);
    for (const [key,qty] of poolQuantities) {
      if (this.db.prepare('SELECT remaining FROM allocations WHERE stock_key=?').get(key)?.remaining < qty) {
        throw new AppError('The combined options exceed their shared offline stock pool. No payment was recorded.',409,'ALLOCATED_STOCK_CHANGED');
      }
    }
    if (!Number.isSafeInteger(total) || total < 1 || total > 1000000000) throw new AppError('The sale total is outside the permitted range.', 400);
    const sale = { id, number: 'Local draft', status: 'awaiting_payment', saleType: value.saleType,
      buyerName: value.buyerName || '', wholesaleApprovedById: value.saleType === 'wholesale' ? user.id : null,
      wholesaleApprovedByName: value.saleType === 'wholesale' ? user.name : '', wholesaleApprovedAt: value.saleType === 'wholesale' ? time() : null,
      agreedTotal: value.saleType === 'wholesale' ? total : null, items: lines, note: value.note,
      total, subtotal: total, tax: 0, currency: 'GHS', cashierId: user.id, cashierName: user.name };
    this.prepared.set(id, sale); // No stock, money or order changes at prepare time.
    return sale;
  }
  view(row) {
    const sale = this.unseal(row.payload);
    return { ...sale, status: row.status, refunded: row.refunded, syncState: this.db.prepare("SELECT state FROM queue WHERE sale_id=? AND kind='sale'").get(row.id)?.state || 'pending' };
  }
  sale(id) { const user = this.requireUser(); const row = this.db.prepare('SELECT * FROM sales WHERE id=?').get(id); if (!row) throw new AppError('Sale not found.', 404); if (!management(user) && row.cashier_id !== user.id) throw new AppError('Sale belongs to another cashier.', 403); return this.view(row); }
  sales() { const user = this.requireUser(); return { sales: this.db.prepare(`SELECT * FROM sales ${management(user) ? '' : 'WHERE cashier_id=?'} ORDER BY seq DESC LIMIT 500`).all(...(management(user) ? [] : [user.id])).map(row => this.view(row)) }; }
  pay(id, input) {
    const user = this.requireUser();
    const payment = paymentSchema.parse(input);
    if (payment.method !== 'cash') throw new AppError('Offline checkout is cash-only. A MoMo reference cannot confirm payment or release goods without a live verification workflow.', 403, 'OFFLINE_CASH_ONLY');
    const draft = this.getPrepared(id);
    // Recovery of an already committed receipt is always possible after the
    // grant expires; only a NEW commit needs active selling authority.
    if (!this.db.prepare('SELECT 1 FROM sales WHERE id=?').get(id)) {
      if (Number(this.setting('lastClock')) > Date.now() + 5 * 60000) throw clockProblem();
      if (!this.eligible()) throw locked();
    }
    if (!draft && !this.db.prepare('SELECT 1 FROM sales WHERE id=?').get(id)) throw new AppError('This local draft expired. Prepare the cart again; no money or stock was recorded.', 409);
    if (payment.method === 'cash' && (!Number.isSafeInteger(payment.tendered) || payment.tendered < draft?.total)) throw new AppError('Count enough cash before completing this sale.', 400);
    if (draft && draft.cashierId !== user.id) throw new AppError('This draft belongs to another cashier.', 403);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM sales WHERE id=?').get(id);
      if (existing) {
        const saved = this.view(existing);
        if (saved.paymentMethod !== payment.method || (payment.method === 'cash' && saved.tendered !== payment.tendered) ||
            (payment.method === 'momo' && saved.paymentReference !== payment.reference)) throw new AppError('This checkout key already belongs to a different completed transaction. Review Sales.', 409, 'IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT'); return saved;
      }
      if (!draft) throw new AppError('This local draft expired. Prepare it again.', 409);
      const spent = new Map(); const revisions = {};
      for (const item of draft.items) spent.set(item.stockKey, (spent.get(item.stockKey) || 0) + item.quantity);
      for (const [key, quantity] of spent) {
        const grant = this.db.prepare('SELECT * FROM allocations WHERE stock_key=?').get(key);
        if (!grant || grant.remaining < quantity || Date.parse(grant.expires_at) <= Date.now()) throw new AppError('Another local sale used this allocation. No money or stock was recorded.', 409, 'ALLOCATED_STOCK_CHANGED');
        revisions[key] = grant.revision;
      }
      const when = time(), status = payment.method === 'cash' ? 'paid_local_pending_sync' : 'payment_unverified';
      const tendered = payment.method === 'cash' ? payment.tendered : 0;
      const event = syncEventSchema.parse({ kind: 'sale', id, deviceId: this.setting('deviceId'),
        cashierId: user.id, cashierName: user.name, saleType: draft.saleType, buyerName: draft.buyerName,
        approvedById: draft.wholesaleApprovedById, approvedByName: draft.wholesaleApprovedByName,
        paymentMethod: payment.method, paymentReference: payment.method === 'cash' ? '' : payment.reference,
        paymentStatus: payment.method === 'cash' ? 'cash_received' : 'unverified', tendered, total: draft.total,
        items: draft.items.map(({ productId, variationId, stockKey, quantity, name, label, sku, price, agreedUnitPrice }) => ({
          productId, variationId, stockKey, quantity, name, label, sku, price,
          ...(agreedUnitPrice != null ? { agreedUnitPrice } : {}),
        })), note: draft.note, createdAt: when, grantRevisions: revisions });
      const saved = { ...draft, number: `${this.practiceMode ? 'PRACTICE' : 'MTD'}-${when.slice(0,10).replaceAll('-','')}-${id.slice(0,8).toUpperCase()}`,
        paymentMethod: payment.method, paymentReference: event.paymentReference, tendered,
        changeDue: payment.method === 'cash' ? tendered - draft.total : 0,
        paidAt: payment.method === 'cash' ? when : null, createdAt: when,
        status, refunded: 0, returnedItems: [], wooOrderId: null };
      this.db.prepare('INSERT INTO sales(id,fingerprint,sale_type,cashier_id,status,total,payload,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, sha(event), draft.saleType, user.id, status, draft.total, this.seal(saved), when);
      for (const [key, quantity] of spent) {
        const grant = this.db.prepare('UPDATE allocations SET remaining=remaining-? WHERE stock_key=? AND remaining>=?').run(quantity, key, quantity);
        if (grant.changes !== 1) throw new AppError('Allocated stock changed. No sale was recorded.', 409);
        const balance = this.db.prepare('SELECT remaining FROM allocations WHERE stock_key=?').get(key).remaining;
        this.db.prepare('INSERT INTO movements(stock_key,delta,balance_after,kind,event_id,actor_id,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(key, -quantity, balance, 'sale', id, user.id, when);
      }
      this.db.prepare('INSERT INTO queue(id,sale_id,kind,fingerprint,payload) VALUES (?,?,?,?,?)').run(id, id, 'sale', sha(event), this.seal(event));
      this.audit('desktop.sale_committed', id);
      this.put('lastClock', String(Date.now()));
      this.db.exec('COMMIT'); this.prepared.delete(id);
      return { ...saved, syncState: 'pending' };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  returnSale(input) {
    const user = this.requireUser(); permit(management(user));
    const value = returnInputSchema.parse(input);
    const row = this.db.prepare('SELECT * FROM sales WHERE id=?').get(value.saleId);
    if (!row || row.status === 'payment_unverified') throw new AppError('Only a recorded cash sale can be returned here. Unverified payments need owner review.', 409);
    const original = this.view(row);
    const fingerprint = sha(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM returns WHERE id=?').get(value.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new AppError('Return key already used for different items.', 409, 'IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT'); return { sale: this.sale(value.saleId), returnId: value.idempotencyKey };
      }
      const prior = new Map((original.returnedItems || []).map(i => [lineKey(i.productId, i.variationId), i.quantity]));
      const increments = new Map(); let amount = 0;
      const items = value.items.map(item => {
        const key = lineKey(item.productId, item.variationId);
        const line = original.items.find(i => lineKey(i.productId, i.variationId) === key);
        if (!line || (prior.get(key) || 0) + item.quantity > line.quantity || value.items.filter(i => lineKey(i.productId, i.variationId) === key).length !== 1) {
          throw new AppError('Return quantities exceed the original sale.', 409);
        }
        prior.set(key, (prior.get(key) || 0) + item.quantity);
        increments.set(line.stockKey, (increments.get(line.stockKey) || 0) + item.quantity);
        const price = line.agreedUnitPrice ?? line.price;
        amount += item.quantity * price;
        return { ...item, stockKey: line.stockKey, amount: item.quantity * price };
      });
      if (!Number.isSafeInteger(amount) || original.refunded + amount > original.total) throw new AppError('Refund exceeds the original amount.', 409);
      const event = syncEventSchema.parse({ kind:'return', id: value.idempotencyKey, deviceId: this.setting('deviceId'),
        saleId: value.saleId, actorId: user.id, actorName: user.name, items, amount, reason: value.reason,
        cashRefunded: true, createdAt: time() });
      const returnedItems = [...prior].map(([key, quantity]) => ({ productId: Number(key.split(':')[0]), variationId: Number(key.split(':')[1]), quantity }));
      const nextStatus = original.refunded + amount === original.total ? 'returned_local_pending_sync' : 'partially_returned_local_pending_sync';
      const updated = { ...original, returnedItems, refunded: original.refunded + amount, status: nextStatus };
      this.db.prepare('UPDATE sales SET status=?,refunded=?,payload=? WHERE id=?').run(nextStatus, updated.refunded, this.seal(updated), row.id);
      this.db.prepare('INSERT INTO returns(id,sale_id,fingerprint,payload,created_at) VALUES (?,?,?,?,?)')
        .run(event.id, row.id, fingerprint, this.seal(event), event.createdAt);
      // Only put returned goods back in the offline pool while its lease is
      // valid; an expired grant keeps them quarantined for owner reconciliation.
      for (const [key, quantity] of increments) {
        const grant = this.db.prepare('SELECT * FROM allocations WHERE stock_key=?').get(key);
        const usable = grant && this.leaseValid() && Date.parse(grant.expires_at) > Date.now();
        if (usable) this.db.prepare('UPDATE allocations SET remaining=remaining+? WHERE stock_key=?').run(quantity, key);
        const balance = this.db.prepare('SELECT remaining FROM allocations WHERE stock_key=?').get(key)?.remaining || 0;
        this.db.prepare('INSERT INTO movements(stock_key,delta,balance_after,kind,event_id,actor_id,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(key, usable ? quantity : 0, balance, usable ? 'return' : 'return_quarantine', event.id, user.id, event.createdAt);
      }
      this.db.prepare('INSERT INTO queue(id,sale_id,kind,fingerprint,payload) VALUES (?,?,?,?,?)')
        .run(event.id, row.id, 'return', sha(event), this.seal(event));
      this.audit('desktop.return_committed', event.id);
      this.db.exec('COMMIT');
      return { sale: this.sale(row.id), returnId: event.id };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  customerList() { permit(management(this.requireUser())); return { customers: this.db.prepare('SELECT * FROM customers ORDER BY created_at DESC LIMIT 500').all().map(row => this.unseal(row.payload)) }; }
  addCustomer(input) {
    const user = this.requireUser(); permit(management(user));
    const data = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().max(40).optional().default('') }).strict().parse(input);
    const customer = { ...data, id: randomUUID(), createdAt: time(), createdBy: user.id };
    this.db.prepare('INSERT INTO customers(id,payload,created_at,created_by) VALUES (?,?,?,?)').run(customer.id,this.seal(customer),customer.createdAt,user.id);
    this.audit('desktop.customer_created', customer.id);
    return { customer };
  }
  queueStatus() {
    this.requireUser();
    const rows = this.db.prepare('SELECT seq,id,sale_id,kind,state,attempts,next_attempt_at,last_error,acked_at FROM queue ORDER BY seq DESC LIMIT 500').all();
    const counts = this.db.prepare("SELECT COUNT(*) AS pending, SUM(CASE WHEN state='conflict' THEN 1 ELSE 0 END) AS conflicts FROM queue WHERE state<>'acked'").get();
    return { rows: rows.map(r => ({ id:r.id, saleId:r.sale_id, kind:r.kind, state:r.state, attempts:r.attempts, nextAttemptAt:r.next_attempt_at,
      lastError:r.last_error, ackedAt:r.acked_at })), pending: counts.pending,
      conflicts: counts.conflicts || 0, leaseExpiresAt:this.setting('leaseExpiresAt'),
      canSell:this.eligible(), deviceId:this.setting('deviceId') || null, syncing:this.syncing };
  }
  async sync(force = false) {
    this.requireUser();
    if (this.syncing) return this.queueStatus();
    const origin = this.setting('origin');
    if (!origin) throw new AppError('This device is not connected to a trading service.', 409);
    const tokenBlob = this.db.prepare("SELECT value FROM settings WHERE key='centralToken'").get()?.value;
    if (!tokenBlob) throw new AppError('Online credentials expired. Sign in online again; local sales are still safe.', 401);
    const token = this.unseal(tokenBlob);
    const secretBlob = this.db.prepare("SELECT value FROM settings WHERE key='deviceSecret'").get()?.value;
    if (!secretBlob) throw new AppError('Device signing key is missing. Owner re-enrolment is required; keep local sales safe.', 403);
    const secret = this.unseal(secretBlob);
    this.syncing = true;
    try {
      for (const row of this.db.prepare("SELECT * FROM queue WHERE state<>'acked' ORDER BY seq LIMIT 100").all()) {
        if (row.state === 'conflict' || (!force && row.next_attempt_at && Date.parse(row.next_attempt_at) > Date.now())) break;
        const event = this.unseal(row.payload);
        try {
          const signature = createHmac('sha256',secret).update(JSON.stringify(event)).digest('hex');
          const result = await this.remote.request(origin, token, '/desktop/sync', 'POST', {event,signature});
          if (result?.id !== row.id || result?.fingerprint !== row.fingerprint || result?.status !== 'acked') {
            throw new AppError('Central acknowledgement did not match this local event. Owner must review before retrying.', 409, 'SYNC_CONFLICT');
          }
          this.db.exec('BEGIN IMMEDIATE');
          try {
            this.db.prepare("UPDATE queue SET state='acked',attempts=attempts+1,next_attempt_at=NULL,last_error='',acked_at=? WHERE id=?").run(time(),row.id);
            if (row.kind === 'sale' && Number.isInteger(result.wooOrderId)) {
              const sale = this.db.prepare('SELECT * FROM sales WHERE id=?').get(row.sale_id);
              const value = this.unseal(sale.payload);
              this.db.prepare('UPDATE sales SET payload=? WHERE id=?').run(this.seal({ ...value, wooOrderId: result.wooOrderId }), row.sale_id);
            }
            this.audit('desktop.sync_ack', row.id);
            this.db.exec('COMMIT');
          } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        } catch (error) {
          const conflict = error.status === 409 || error.code === 'SYNC_CONFLICT' || error.status === 403;
          const attempts = row.attempts + 1;
          const next = conflict ? null : new Date(Date.now() + Math.min(3600000, 5000 * 2 ** Math.min(attempts, 9))).toISOString();
          this.db.prepare('UPDATE queue SET state=?,attempts=?,next_attempt_at=?,last_error=? WHERE id=?')
            .run(conflict ? 'conflict' : 'retry', attempts, next, String(error.message || 'Connection interrupted.').slice(0,400), row.id);
          this.audit(conflict ? 'desktop.sync_conflict' : 'desktop.sync_retry', row.id);
          break; // Preserve event ordering: a return must never precede its sale.
        }
      }
    } finally { this.syncing = false; }
    return this.queueStatus();
  }
  async refresh() {
    const user = this.requireUser();
    if (this.queueStatus().pending) throw new AppError('Sync every completed local event before replacing its allocation snapshot.', 409, 'PENDING_LOCAL_SALES');
    const origin = this.setting('origin');
    const blob = this.db.prepare("SELECT value FROM settings WHERE key='centralToken'").get()?.value;
    if (!origin || !blob) throw new AppError('Sign in online on this computer before refreshing stock.', 401);
    const snapshot = bootstrapSchema.parse(await this.remote.request(origin,this.unseal(blob),
      `/desktop/bootstrap?deviceId=${this.setting('deviceId')}`,'GET'));
    if (snapshot.deviceId !== this.setting('deviceId')) throw new AppError('The central service returned another till.', 409);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare("SELECT 1 FROM queue WHERE state<>'acked' LIMIT 1").get()) {
        throw new AppError('A cash sale completed while Woo stock was loading. Sync it before replacing this device’s allocation.',409,'PENDING_LOCAL_SALES');
      }
      this.db.prepare('INSERT INTO catalog(id,payload,fetched_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at')
        .run(this.seal(snapshot.catalog),snapshot.catalog.fetchedAt);
      this.db.prepare('DELETE FROM allocations').run();
      for (const grant of snapshot.grants) this.db.prepare('INSERT INTO allocations(stock_key,product_id,variation_id,remaining,revision,expires_at) VALUES (?,?,?,?,?,?)')
        .run(grant.stockKey,grant.productId,grant.variationId,grant.remaining,grant.revision,grant.expiresAt);
      this.put('canSell',snapshot.canSell?'true':'false');
      this.put('canWholesale',snapshot.canWholesale?'true':'false');
      this.put('leaseExpiresAt',snapshot.leaseExpiresAt);
      this.put('lastClock',String(Date.now()));
      if (management(user) && snapshot.canWholesale) this.db.prepare('INSERT INTO wholesale_cache(id,payload) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
        .run(this.seal(snapshot.wholesalePrices));
      else this.db.prepare('DELETE FROM wholesale_cache').run();
      this.audit('desktop.snapshot_refreshed',snapshot.deviceId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.prepared.clear();
    return this.session();
  }
  async allocate(input) {
    const user = this.requireUser(); permit(user.role === 'owner');
    if (this.queueStatus().pending) throw new AppError('Sync the pending local sales before requesting more stock.', 409, 'PENDING_LOCAL_SALES');
    const value = z.object({ idempotencyKey:z.string().uuid(), productId:z.number().int().positive(),
      variationId:z.number().int().min(0),quantity:z.number().int().min(1).max(1000) }).strict().parse(input);
    const origin = this.setting('origin');
    const tokenBlob = this.db.prepare("SELECT value FROM settings WHERE key='centralToken'").get()?.value;
    if (!origin || !tokenBlob) throw new AppError('Reconnect as the owner before reserving Woo stock.', 401);
    const request = { ...value, deviceId:this.setting('deviceId') };
    const prior = this.pendingAllocation();
    if (prior && Object.keys(request).some(key => request[key] !== prior[key])) {
      throw new AppError(`Allocation ${prior.idempotencyKey} is unresolved. Review Woo and retry that SAME request; do not use a new allocation ID.`, 409, 'ALLOCATION_UNCERTAIN');
    }
    // The pending request is durable BEFORE network I/O. A response lost
    // after Woo subtracts stock must not lead to a new ID after a restart.
    if (!prior) {
      const product = this.rawCatalog().products.find(p => p.id === value.productId);
      const item = value.variationId ? product?.variations.find(v => v.id === value.variationId) : product;
      if (!product || (product.type === 'variable' && !value.variationId) ||
          (product.type !== 'variable' && value.variationId) || !item || !item.manageStock ||
          item.backordersAllowed || !item.purchasable || item.price < 1) {
        throw new AppError('Select a priced, managed Woo product or exact option with backorders disabled.', 409);
      }
      const expectedKey = lineKey(product.id, item.stockSource === 'parent' ? 0 : value.variationId);
      this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('pendingAllocation', this.seal({ ...request, stockKey:expectedKey }));
      this.audit('desktop.allocation_requested',`${value.idempotencyKey}:${expectedKey}:${value.quantity}`);
    }
    const saved = this.pendingAllocation();
    const result = await this.remote.request(origin,this.unseal(tokenBlob),'/desktop/allocate','POST',request);
    const grant = grantSchema.parse(result?.grant);
    if (result?.deviceId !== request.deviceId || result?.stockKey !== saved.stockKey || grant.stockKey !== saved.stockKey ||
        grant.stockKey !== lineKey(grant.productId, grant.variationId) || grant.productId !== request.productId ||
        (request.variationId === 0 && grant.variationId !== 0)) {
      throw new AppError('Woo acknowledgement did not match the original allocation. Keep the saved request for owner review.',409,'ALLOCATION_UNCERTAIN');
    }
    await this.refresh();
    const current = this.db.prepare('SELECT revision FROM allocations WHERE stock_key=?').get(saved.stockKey);
    if (!current || current.revision < grant.revision) {
      throw new AppError('The refreshed Woo stock pool did not confirm this allocation. Keep its original request ID.',409,'ALLOCATION_UNCERTAIN');
    }
    this.db.prepare("DELETE FROM settings WHERE key='pendingAllocation'").run();
    this.audit('desktop.allocation_confirmed',value.idempotencyKey);
    return result;
  }
  retry(id, reason) {
    const user = this.requireUser(); permit(user.role === 'owner');
    z.string().uuid().parse(id); z.string().trim().min(10).max(250).parse(reason);
    const row = this.db.prepare("SELECT * FROM queue WHERE id=? AND state='conflict'").get(id);
    if (!row) throw new AppError('No blocked event with this ID.', 404);
    this.db.prepare("UPDATE queue SET state='retry',next_attempt_at=NULL,last_error=? WHERE id=?").run(`Owner retry: ${reason}`,id);
    this.audit('desktop.sync_owner_retry', `${id}:${reason}`);
    return this.queueStatus();
  }
  async backupLedger() {
    permit(management(this.requireUser()));
    const destinationDir = path.join(this.userData,'backups');
    fs.mkdirSync(destinationDir,{recursive:true,mode:0o700});
    const destination = path.join(destinationDir,`${this.practiceMode ? 'mansu-practice' : 'mansu-offline'}-${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}.db`);
    try {
      await backup(this.db,destination);
      fs.chmodSync(destination,0o600);
      const check = new DatabaseSync(destination,{readOnly:true});
      try { if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('Backup integrity check failed.'); }
      finally { check.close(); }
      this.audit('desktop.ledger_backup',destination);
      return {path:destination,verified:true};
    } catch (error) {
      try { fs.rmSync(destination,{force:true}); } catch { /* report original error */ }
      throw error;
    }
  }
  movements(stockKey) { permit(management(this.requireUser())); return { movements: this.db.prepare('SELECT * FROM movements WHERE stock_key=? ORDER BY seq DESC LIMIT 100').all(stockKey) }; }
  close() { this.user = null; this.prepared.clear(); this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); }
}
