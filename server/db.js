import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { demoProducts } from './demo-catalog.js';

export const SCHEMA_VERSION = 4;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64, SCRYPT).toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  if (!encoded || typeof password !== 'string' || password.length > 256) return false;
  const parts = encoded.split(':');
  const [salt, hash] = parts[0] === 'scrypt' ? [parts[1], parts[2]] : [parts[0], parts[1]];
  if (!salt || !hash) return false;
  try {
    const actual = scryptSync(password, salt, 64, SCRYPT);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}
const COMMON_PASSWORDS = new Set(['password1234', 'password12345', 'qwerty12345', 'letmein12345', 'mansutrendzgh', 'mansutrendzgh123', 'welcome12345', 'admin1234567']);
export function passwordProblem(password, username = '') {
  if (typeof password !== 'string' || password.length < 12) return 'Use a password of at least 12 characters.';
  if (password.length > 256) return 'Password is too long.';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'Choose a less common password.';
  if (username && lower.includes(username.toLowerCase()) && username.length >= 3) return 'Password must not contain the username.';
  if (/^(.)\1+$/.test(password)) return 'Choose a less repetitive password.';
  return '';
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`);
  const current = db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get().version;
  const migrations = [
    () => db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS demo_stock (line_key TEXT PRIMARY KEY, stock INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sales (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, number TEXT NOT NULL, woo_order_id INTEGER, status TEXT NOT NULL, payment_method TEXT, payment_reference TEXT, total INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0, subtotal INTEGER NOT NULL DEFAULT 0, refunded INTEGER NOT NULL DEFAULT 0, tendered INTEGER, change_due INTEGER, currency TEXT NOT NULL, cashier_id TEXT NOT NULL, cashier_name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', items_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS catalog_cache (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, updated_at TEXT NOT NULL);
    `),
    () => db.exec(`
      ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN locked_until INTEGER;
      ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN shift_id TEXT;
      CREATE TABLE IF NOT EXISTS shifts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), user_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', opening_float INTEGER NOT NULL DEFAULT 0, closing_cash INTEGER, expected_cash INTEGER, variance INTEGER, note TEXT NOT NULL DEFAULT '', opened_at TEXT NOT NULL, closed_at TEXT);
      CREATE TABLE IF NOT EXISTS cash_movements (id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id), user_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('in','out')), amount INTEGER NOT NULL CHECK(amount > 0), reason TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_sales_cashier_created ON sales(cashier_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
      CREATE INDEX IF NOT EXISTS idx_sales_shift ON sales(shift_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);
      CREATE INDEX IF NOT EXISTS idx_shifts_user_status ON shifts(user_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_shift_per_user ON shifts(user_id) WHERE status='open';
    `),
    () => db.exec(`
      ALTER TABLE sales ADD COLUMN prepared_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN last_reconciled_at TEXT;
      ALTER TABLE sales ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE shifts ADD COLUMN summary_json TEXT;
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_sales_recovery ON sales(cashier_id, fingerprint, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_sales_reconcile ON sales(status, last_reconciled_at);
      UPDATE sales SET prepared_total=total WHERE prepared_total=0;
    `),
    () => db.exec(`
      CREATE TABLE trade_buyers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id)
      );
      ALTER TABLE sales ADD COLUMN sale_type TEXT NOT NULL DEFAULT 'retail' CHECK(sale_type IN ('retail','trade'));
      ALTER TABLE sales ADD COLUMN buyer_id TEXT REFERENCES trade_buyers(id);
      ALTER TABLE sales ADD COLUMN buyer_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE sales ADD COLUMN trade_quote_json TEXT;
      ALTER TABLE sales ADD COLUMN trade_verified_json TEXT;
      ALTER TABLE sales ADD COLUMN trade_approved_by_id TEXT;
      ALTER TABLE sales ADD COLUMN trade_approved_by_name TEXT;
      ALTER TABLE sales ADD COLUMN trade_approved_at TEXT;
      CREATE INDEX idx_sales_trade_buyer ON sales(buyer_id, created_at);
    `),
  ];
  for (let version = current + 1; version <= migrations.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migrations[version - 1]();
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}

export function openDatabase(config) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(config.dataDir, `pos-${config.mode}.db`);
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;`);
  migrate(db);
  try { fs.chmodSync(file, 0o600); } catch {}
  const insert = db.prepare('INSERT OR IGNORE INTO demo_stock(line_key,stock) VALUES (?,?)');
  for (const p of demoProducts) {
    if (p.type === 'simple') insert.run(`${p.id}:0`, p.stock);
    for (const v of p.variations) insert.run(`${p.id}:${v.id}`, v.stock);
  }
  if (config.mode === 'demo') {
    const add = db.prepare('INSERT OR IGNORE INTO users(id,username,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)');
    add.run('demo-owner', 'demo.owner', 'Demo Owner', 'owner', hashPassword(randomUUID()), new Date().toISOString());
    if (!db.prepare('SELECT id FROM sales LIMIT 1').get()) seedDemoSales(db);
  } else if (config.ownerUsername && config.ownerPassword) {
    if (!db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get()) {
      const problem = passwordProblem(config.ownerPassword, config.ownerUsername);
      if (problem) throw new Error(`POS_OWNER_PASSWORD: ${problem}`);
      db.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at,must_change_password) VALUES (?,?,?,?,?,?,1)')
        .run(randomUUID(), config.ownerUsername, 'Store Owner', 'owner', hashPassword(config.ownerPassword), new Date().toISOString());
    }
  }
  db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('mode', config.mode);
  db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('schema_version', String(SCHEMA_VERSION));
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return db;
}

function seedDemoSales(db) {
  const samples = [
    [2, 'cash', 1, 'M'], [3, 'momo', 1, 'L'], [6, 'card', 1, 'S'],
    [1, 'cash', 2, 'M'], [4, 'momo', 1, 'S'], [7, 'cash', 1, 'L'],
  ];
  const add = db.prepare('INSERT INTO sales(id,idempotency_key,fingerprint,number,status,payment_method,total,tax,subtotal,currency,cashier_id,cashier_name,items_json,created_at,updated_at,paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  samples.forEach(([index, method, quantity, size], i) => {
    const p = demoProducts[index];
    const v = p.variations.find(x => x.label === size) || p.variations[0];
    const date = new Date(Date.now() - (i + 1) * 47 * 60000).toISOString();
    const item = { productId: p.id, variationId: v?.id || 0, name: p.name, label: v?.label || '', sku: v?.sku || p.sku, image: p.image, price: p.price, quantity, total: p.price * quantity };
    add.run(`demo-seed-${i}`, `demo-seed-${i}`, 'seed', `DEMO-${String(i + 1001)}`, 'paid', method, item.total, 0, item.total, 'GHS', 'demo-owner', 'Demo Owner', JSON.stringify([item]), date, date, date);
  });
}

export function audit(db, actor, action, subject) {
  db.prepare('INSERT INTO audit(actor,action,subject,created_at) VALUES (?,?,?,?)').run(actor, action, String(subject), new Date().toISOString());
}
export function userView(row) {
  return row ? { id: row.id, username: row.username, name: row.name, role: row.role, active: Boolean(row.active), mustChangePassword: Boolean(row.must_change_password) } : null;
}
export function saleView(row) {
  if (!row) return null;
  const quote = row.sale_type === 'trade' && row.trade_quote_json ? JSON.parse(row.trade_quote_json) : null;
  const savedItems = JSON.parse(row.items_json);
  // A lost create response may leave only the approved quote in the ledger.
  // Keep the agreement visible in Sales even while the Woo order is under review.
  const items = (savedItems.length ? savedItems : quote || []).map(item => {
    const agreed = quote?.find(line => line.productId === item.productId && line.variationId === item.variationId);
    return agreed ? { ...item, name: item.name || `Product #${item.productId}`,
      cataloguePrice: agreed.catalogueUnitPrice ?? item.cataloguePrice ?? item.price ?? null,
      agreedUnitPrice: agreed.agreedUnitPrice, agreedLineTotal: agreed.agreedUnitPrice * agreed.quantity } : item;
  });
  return {
    id: row.id, number: row.number, wooOrderId: row.woo_order_id, status: row.status,
    saleType: row.sale_type || 'retail', buyerId: row.buyer_id || null, buyerName: row.buyer_name || '',
    tradeApprovedById: row.trade_approved_by_id || null, tradeApprovedByName: row.trade_approved_by_name || '', tradeApprovedAt: row.trade_approved_at || null,
    agreedTotal: quote?.reduce((sum, item) => sum + item.agreedUnitPrice * item.quantity, 0) ?? null,
    paymentMethod: row.payment_method, paymentReference: row.payment_reference,
    total: row.total, tax: row.tax, subtotal: row.subtotal, refunded: row.refunded, tendered: row.tendered, changeDue: row.change_due,
    currency: row.currency, cashierId: row.cashier_id, cashierName: row.cashier_name, shiftId: row.shift_id,
    note: row.note, items, createdAt: row.created_at,
    updatedAt: row.updated_at, paidAt: row.paid_at, error: row.error,
  };
}
