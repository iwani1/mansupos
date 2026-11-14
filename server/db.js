import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { demoProducts } from './demo-catalog.js';
import { hashPassword, passwordProblem } from './passwords.js';
import { assertLedgerIdentity, initializeLedgerIdentity, ledgerInfo } from './ledger-identity.js';

// Preserve the public server API while the desktop ledger imports only the
// password code, not demo products and the central database migrations.
export { hashPassword, verifyPassword, passwordProblem } from './passwords.js';
export const SCHEMA_VERSION = 9;

function migrate(db, targetVersion = SCHEMA_VERSION) {
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
    // Historical v5 POS-only physical-store schema. Preserve any existing
    // records, but its cash gate is retired outside isolated tests: newly
    // shared physical goods require Woo IDs and Woo-owned stock instead.
    // Legacy ledger movements and paid sales committed atomically.
    () => db.exec(`
      CREATE TABLE instore_imports (
        id INTEGER PRIMARY KEY CHECK(id=1), source_hash TEXT NOT NULL,
        csv_hash TEXT NOT NULL, pdf_hash TEXT NOT NULL, imported_at TEXT NOT NULL,
        listed INTEGER NOT NULL, eligible INTEGER NOT NULL, quarantined INTEGER NOT NULL
      );
      CREATE TABLE instore_inventory (
        sku TEXT PRIMARY KEY, name TEXT NOT NULL, group_name TEXT NOT NULL,
        barcode TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL CHECK(price_cents > 0),
        initial_quantity INTEGER NOT NULL CHECK(initial_quantity >= 0),
        on_hand INTEGER NOT NULL CHECK(on_hand >= 0)
      );
      CREATE TABLE instore_sales (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL, number TEXT NOT NULL UNIQUE,
        total INTEGER NOT NULL CHECK(total > 0),
        tendered INTEGER NOT NULL CHECK(tendered >= total),
        change_due INTEGER NOT NULL CHECK(change_due = tendered - total),
        cashier_id TEXT NOT NULL REFERENCES users(id), cashier_name TEXT NOT NULL,
        shift_id TEXT NOT NULL REFERENCES shifts(id),
        items_json TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        source_hash TEXT NOT NULL, paid_at TEXT NOT NULL
      );
      CREATE TABLE instore_stock_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL REFERENCES instore_inventory(sku),
        delta INTEGER NOT NULL CHECK(delta <> 0), balance_after INTEGER NOT NULL CHECK(balance_after >= 0),
        kind TEXT NOT NULL CHECK(kind IN ('import','sale','count')),
        reason TEXT NOT NULL DEFAULT '', sale_id TEXT REFERENCES instore_sales(id), actor_id TEXT,
        occurred_at TEXT NOT NULL, UNIQUE(sale_id, sku)
      );
      CREATE TABLE instore_stock_counts (
        idempotency_key TEXT PRIMARY KEY, sku TEXT NOT NULL REFERENCES instore_inventory(sku),
        fingerprint TEXT NOT NULL, expected_quantity INTEGER NOT NULL CHECK(expected_quantity >= 0),
        counted_quantity INTEGER NOT NULL CHECK(counted_quantity >= 0),
        reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
      );
      CREATE INDEX idx_instore_sales_date ON instore_sales(paid_at DESC, seq DESC);
      CREATE INDEX idx_instore_sales_cashier_date ON instore_sales(cashier_id, paid_at DESC, seq DESC);
      CREATE INDEX idx_instore_movements_sku ON instore_stock_movements(sku, id);
      CREATE INDEX idx_instore_sales_shift ON instore_sales(shift_id);
    `),
    // Wholesale defaults are private POS pricing for existing Woo identities,
    // never WooCommerce product metadata or a second product/stock catalogue.
    // A saved identity snapshot prevents applying a price to an edited option.
    () => db.exec(`
      CREATE TABLE wholesale_prices (
        product_id INTEGER NOT NULL CHECK(product_id > 0),
        variation_id INTEGER NOT NULL CHECK(variation_id >= 0),
        parent_sku TEXT NOT NULL, option_sku TEXT NOT NULL, option_label TEXT NOT NULL,
        unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents BETWEEN 1 AND 100000000),
        revision INTEGER NOT NULL CHECK(revision > 0),
        updated_by TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
        PRIMARY KEY(product_id, variation_id)
      );
    `),
    // Add an identity snapshot beyond the label (e.g. Size:S must not become
    // Colour:S). Previously stored v6 defaults remain present but deliberately
    // require re-review: blank identity fields can never match a real product.
    // A global monotonic version prevents stale edits from passing after a
    // delete/recreate cycle, even if the same product/variation ID is reused.
    () => db.exec(`
      ALTER TABLE wholesale_prices ADD COLUMN product_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE wholesale_prices ADD COLUMN option_attributes TEXT NOT NULL DEFAULT '';
      ALTER TABLE wholesale_prices ADD COLUMN retail_price_cents INTEGER NOT NULL DEFAULT -1;
      CREATE TABLE wholesale_price_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT);
      INSERT INTO wholesale_price_revisions (id)
        SELECT MAX(revision) FROM wholesale_prices HAVING COUNT(*) > 0;
    `),
    // Central inbox for a separately enrolled offline till. Never reuse the
    // retired POS-only stock ledger; Woo's reservation plugin is the authority.
    // Keep the original event before any remote write, then ack and import the
    // order in one local transaction. Lost responses replay the SAME event ID.
    () => db.exec(`
      CREATE TABLE offline_devices (
        id TEXT PRIMARY KEY, enrolled_by TEXT NOT NULL REFERENCES users(id),
        enrolled_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
      );
      CREATE TABLE offline_events (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES offline_devices(id),
        kind TEXT NOT NULL CHECK(kind IN ('sale','return')), fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        woo_order_id INTEGER, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_offline_events_status ON offline_events(status,created_at);
    `),
    // Do not repair historical orders by deleting or remapping them. Stop the
    // upgrade for duplicate Woo links, invalid references or orphaned shifts;
    // an operator must review the exact ledger on an isolated copy first.
    () => {
      const duplicate = db.prepare('SELECT woo_order_id AS id FROM sales WHERE woo_order_id IS NOT NULL GROUP BY woo_order_id HAVING COUNT(*)>1 LIMIT 1').get();
      if (duplicate) throw new Error(`Duplicate Woo order link ${duplicate.id} in POS sales. Review both receipts before applying the v9 uniqueness constraint.`);
      const invalid = db.prepare("SELECT id FROM sales WHERE woo_order_id IS NOT NULL AND (typeof(woo_order_id)!='integer' OR woo_order_id<=0) LIMIT 1").get();
      if (invalid) throw new Error('Invalid Woo order ID in historical POS sales. Review the ledger before applying v9.');
      const orphan = db.prepare('SELECT id FROM sales WHERE shift_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shifts WHERE shifts.id=sales.shift_id) LIMIT 1').get();
      if (orphan) throw new Error('Historical POS sale refers to a missing shift. Review the ledger before applying v9.');
      const fk = db.prepare('PRAGMA foreign_key_check').get();
      if (fk) throw new Error(`Historical POS ledger has an orphan reference in ${fk.table}. Review it before applying v9.`);
      db.exec(`
        CREATE UNIQUE INDEX idx_sales_one_woo_order ON sales(woo_order_id) WHERE woo_order_id IS NOT NULL;
        CREATE TABLE sale_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_id TEXT NOT NULL REFERENCES sales(id),
          event TEXT NOT NULL CHECK(length(event) BETWEEN 3 AND 64),
          actor_id TEXT NOT NULL, woo_order_id INTEGER,
          amount_cents INTEGER CHECK(amount_cents IS NULL OR amount_cents >= 0),
          detail_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail_json)),
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_sale_events_sale ON sale_events(sale_id,id);
        CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
        CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit is append-only'); END;
        CREATE TRIGGER sale_events_no_update BEFORE UPDATE ON sale_events BEGIN SELECT RAISE(ABORT,'Sale events are append-only'); END;
        CREATE TRIGGER sale_events_no_delete BEFORE DELETE ON sale_events BEGIN SELECT RAISE(ABORT,'Sale events are append-only'); END;
        CREATE TRIGGER cash_movements_no_update BEFORE UPDATE ON cash_movements BEGIN SELECT RAISE(ABORT,'Cash movements are append-only'); END;
        CREATE TRIGGER cash_movements_no_delete BEFORE DELETE ON cash_movements BEGIN SELECT RAISE(ABORT,'Cash movements are append-only'); END;
        CREATE TRIGGER closed_shift_no_cash_insert BEFORE INSERT ON cash_movements
          WHEN EXISTS (SELECT 1 FROM shifts WHERE id=NEW.shift_id AND status='closed')
          BEGIN SELECT RAISE(ABORT,'Closed shifts cannot receive cash movements'); END;
        CREATE TRIGGER closed_shifts_no_update BEFORE UPDATE ON shifts WHEN OLD.status='closed' BEGIN SELECT RAISE(ABORT,'Closed shifts are immutable'); END;
        CREATE TRIGGER closed_shifts_no_delete BEFORE DELETE ON shifts WHEN OLD.status='closed' BEGIN SELECT RAISE(ABORT,'Closed shifts are immutable'); END;
      `);
    },
  ];
  if (current > migrations.length) throw new Error('POS ledger schema is newer than this application. Do not downgrade a trading ledger.');
  for (let version = current + 1; version <= targetVersion; version++) {
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
  const existing = fs.existsSync(file) && fs.statSync(file).size > 0;
  const db = new DatabaseSync(file);
  try {
    // Check identity BEFORE migrations, cache/stock cleanup or user creation.
    // A copied legacy pilot ledger must not silently become a trading ledger.
    const identity = ledgerInfo(db);
    assertLedgerIdentity(identity, config, { existing });
    // Refuse before ANY migration, seeding, owner bootstrap or session write.
    // A backup restored into an empty volume cannot reveal later revocations;
    // only the explicit stopped-service owner recovery can clear this marker.
    if (existing && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'").get() &&
        db.prepare("SELECT 1 FROM app_meta WHERE key='restored_accounts_locked'").get()) {
      throw new Error('Restored POS accounts are locked. Stop this service; obtain approval for offline owner recovery with a new password before signing in or migrating.');
    }
    try { fs.chmodSync(file, 0o600); } catch {}
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    // A fully migrated v9 ledger must always have an identity, including after
    // a later bootstrap/seed error. Bind new or legacy non-live ledgers BEFORE
    // the v9 step; legacy live ledgers require the separate offline review.
    migrate(db, SCHEMA_VERSION - 1);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES (?,?)').run('mode', config.mode);
      initializeLedgerIdentity(db, config);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    migrate(db);
    if (config.mode === 'demo') {
      const insert = db.prepare('INSERT OR IGNORE INTO demo_stock(line_key,stock) VALUES (?,?)');
      for (const p of demoProducts) {
        if (p.type === 'simple') insert.run(`${p.id}:0`, p.stock);
        for (const v of p.variations) insert.run(`${p.id}:${v.id}`, v.stock);
      }
      const add = db.prepare('INSERT OR IGNORE INTO users(id,username,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)');
      add.run('demo-owner', 'demo.owner', 'Demo Owner', 'owner', hashPassword(randomUUID()), new Date().toISOString());
      if (!db.prepare('SELECT id FROM sales LIMIT 1').get()) seedDemoSales(db);
    } else {
      // Never reuse a demo ledger for live/staging sales. Older versions inserted
      // demo_stock rows even in non-demo ledgers; remove only those unused rows,
      // preserving all owners, sessions, catalogue cache and real sales.
      if (db.prepare("SELECT 1 FROM users WHERE id='demo-owner' LIMIT 1").get() ||
          db.prepare("SELECT 1 FROM sales WHERE id LIKE 'demo-seed-%' LIMIT 1").get()) {
        throw new Error('Demo records found in a non-demo POS ledger. Stop and use a separate private trading ledger.');
      }
      db.prepare('DELETE FROM demo_stock').run();
      if (config.ownerUsername && config.ownerPassword && !db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get()) {
        const problem = passwordProblem(config.ownerPassword, config.ownerUsername);
        if (problem) throw new Error(`POS_OWNER_PASSWORD: ${problem}`);
        db.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at,must_change_password) VALUES (?,?,?,?,?,?,1)')
          .run(randomUUID(), config.ownerUsername, 'Store Owner', 'owner', hashPassword(config.ownerPassword), new Date().toISOString());
      }
    }
    db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('schema_version', String(SCHEMA_VERSION));
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    return db;
  } catch (error) { db.close(); throw error; }
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
  // Schema v4 used `trade` names. Keep the historical rows and approved quote
  // intact while presenting them through the replacement Wholesale workflow.
  const wholesale = row.sale_type === 'trade';
  const quote = wholesale && row.trade_quote_json ? JSON.parse(row.trade_quote_json) : null;
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
    saleType: wholesale ? 'wholesale' : 'retail', buyerId: row.buyer_id || null, buyerName: row.buyer_name || '',
    wholesaleApprovedById: row.trade_approved_by_id || null, wholesaleApprovedByName: row.trade_approved_by_name || '', wholesaleApprovedAt: row.trade_approved_at || null,
    agreedTotal: quote?.reduce((sum, item) => sum + item.agreedUnitPrice * item.quantity, 0) ?? null,
    paymentMethod: row.payment_method, paymentReference: row.payment_reference,
    total: row.total, tax: row.tax, subtotal: row.subtotal, refunded: row.refunded, tendered: row.tendered, changeDue: row.change_due,
    currency: row.currency, cashierId: row.cashier_id, cashierName: row.cashier_name, shiftId: row.shift_id,
    note: row.note, items, createdAt: row.created_at,
    updatedAt: row.updated_at, paidAt: row.paid_at, error: row.error,
  };
}
