import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { APP_VERSION } from './config.js';
import { ledgerInfo } from './ledger-identity.js';

export const BACKUP_FORMAT = 'mansu-pos-sqlite-v1';

// A matching hash proves only that the manifest describes THESE bytes. It does
// not prove that the file contains the tables needed to resume the POS. Keep
// forensic backups possible, but refuse an incomplete image at restore/preflight.
export function assertRestorableSchema(db, version) {
  if (version < 3 || version > 9) return; // The restore caller rejects unsupported versions.
  const objects = new Set(db.prepare("SELECT type || ':' || name AS object FROM sqlite_master").all().map(row => row.object));
  if (!objects.has('table:sales')) throw new Error(`POS snapshot is missing sales table required by schema v${version}.`);
  const tables = [
    'schema_migrations', 'app_meta', 'users', 'sessions', 'demo_stock', 'sales', 'audit',
    'catalog_cache', 'shifts', 'cash_movements',
    ...(version >= 4 ? ['trade_buyers'] : []),
    ...(version >= 5 ? ['instore_imports', 'instore_inventory', 'instore_sales', 'instore_stock_movements', 'instore_stock_counts'] : []),
    ...(version >= 6 ? ['wholesale_prices'] : []),
    ...(version >= 7 ? ['wholesale_price_revisions'] : []),
    ...(version >= 8 ? ['offline_devices', 'offline_events'] : []),
    ...(version >= 9 ? ['sale_events'] : []),
  ];
  for (const table of tables) {
    if (!objects.has(`table:${table}`)) throw new Error(`POS snapshot is missing required table ${table} for schema v${version}.`);
  }
  const requiredSales = ['id', 'idempotency_key', 'fingerprint', 'number', 'woo_order_id', 'status',
    'payment_method', 'payment_reference', 'total', 'tax', 'subtotal', 'refunded', 'tendered', 'change_due',
    'currency', 'cashier_id', 'cashier_name', 'note', 'items_json', 'created_at', 'updated_at', 'paid_at',
    'error', 'shift_id', 'prepared_total', 'last_reconciled_at', 'reconcile_attempts',
    ...(version >= 4 ? ['sale_type', 'buyer_id', 'buyer_name', 'trade_quote_json', 'trade_verified_json'] : [])];
  const requiredColumns = [
    ['sales', requiredSales],
    ['schema_migrations', ['version', 'applied_at']], ['app_meta', ['key', 'value']],
    ['users', ['id', 'username', 'name', 'role', 'password_hash', 'active', 'created_at',
      'failed_attempts', 'locked_until', 'must_change_password']],
    ['sessions', ['token_hash', 'user_id', 'expires_at', 'last_seen']],
    ['audit', ['id', 'actor', 'action', 'subject', 'created_at']],
    ['shifts', ['id', 'user_id', 'user_name', 'status', 'opening_float', 'closing_cash',
      'expected_cash', 'variance', 'note', 'opened_at', 'closed_at', 'summary_json']],
    ['cash_movements', ['id', 'shift_id', 'user_id', 'type', 'amount', 'reason', 'created_at']],
    ...(version >= 4 ? [['trade_buyers', ['id', 'name', 'created_at', 'created_by']]] : []),
    ...(version >= 9 ? [['sale_events', ['id', 'sale_id', 'event', 'actor_id', 'woo_order_id',
      'amount_cents', 'detail_json', 'created_at']]] : []),
  ];
  for (const [table, expected] of requiredColumns) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    for (const column of expected) {
      if (!columns.has(column)) throw new Error(`POS snapshot is missing required ${table} column ${column} for schema v${version}.`);
    }
  }
  const uniqueIndexes = db.prepare('PRAGMA index_list(sales)').all().filter(index => index.unique);
  const uniqueOn = column => uniqueIndexes.some(index => {
    const safeName = `"${index.name.replaceAll('"', '""')}"`;
    const keys = db.prepare(`PRAGMA index_info(${safeName})`).all();
    return keys.length === 1 && keys[0].name === column;
  });
  if (!uniqueOn('idempotency_key')) throw new Error('POS snapshot is missing required unique sale idempotency constraint.');
  if (version >= 9) {
    if (!uniqueOn('woo_order_id')) throw new Error('POS snapshot is missing required unique Woo order link constraint.');
    for (const object of [
      'index:idx_sales_one_woo_order', 'index:idx_sale_events_sale',
      ...['audit_no_update', 'audit_no_delete', 'sale_events_no_update', 'sale_events_no_delete',
        'cash_movements_no_update', 'cash_movements_no_delete', 'closed_shift_no_cash_insert',
        'closed_shifts_no_update', 'closed_shifts_no_delete'].map(name => `trigger:${name}`),
    ]) {
      if (!objects.has(object)) throw new Error(`POS snapshot is missing required ${object} for schema v9.`);
    }
  }
  const history = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version);
  if (history.length !== version || history.some((step, index) => step !== index + 1)) {
    throw new Error(`POS snapshot is missing required migration history for schema v${version}.`);
  }
}

export function assertRestorableSnapshot(file, version) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { assertRestorableSchema(db, version); } finally { db.close(); }
}

async function digest(file) {
  const sha = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) sha.update(chunk);
  return sha.digest('hex');
}

export function inspectSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('POS backup failed SQLite integrity_check.');
    const info = ledgerInfo(db);
    // Older fixtures may not contain the complete schema; never infer that
    // missing tables mean there were no historical orders on a real service.
    const hasSales = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sales'").get();
    const counts = hasSales ? db.prepare(`SELECT COUNT(*) AS sales,
      COALESCE(SUM(status IN ('creating','needs_reconciliation','awaiting_payment')),0) AS pending,
      COALESCE(SUM(status IN ('partially_refunded','refunded')),0) AS refunded FROM sales`).get() : null;
    return { ...info, counts, foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length };
  } finally { db.close(); }
}

export async function createManifest(file, info = inspectSnapshot(file)) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('POS backup must be a regular SQLite file.');
  return {
    format: BACKUP_FORMAT, createdAt: new Date().toISOString(), appVersion: APP_VERSION,
    mode: info.mode, service: info.service || null, ledgerId: info.ledgerId || null,
    schemaVersion: info.version, bytes: stat.size, sha256: await digest(file),
    counts: info.counts, foreignKeyViolations: info.foreignKeyViolations,
  };
}

export function writeManifest(file, manifest) {
  fs.writeFileSync(`${file}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export async function verifyManifest(file, info) {
  const manifestFile = `${file}.manifest.json`;
  if (!fs.existsSync(manifestFile)) {
    // A pre-v9 staging/demo snapshot can still be restored to a matching
    // unbound legacy destination. LIVE always needs explicit identity and
    // a manifest, including a bound legacy ledger after its safety backup.
    if (info.mode === 'live' || info.version >= 9 || info.service || info.ledgerId) {
      throw new Error('Backup manifest is missing. Use a verified backup with its matching .manifest.json file.');
    }
    return null;
  }
  if (fs.statSync(manifestFile).size > 16384) throw new Error('Backup manifest is unexpectedly large.');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
  catch { throw new Error('Backup manifest is not valid JSON.'); }
  if (manifest.format !== BACKUP_FORMAT || manifest.mode !== info.mode ||
      manifest.service !== (info.service || null) || manifest.ledgerId !== (info.ledgerId || null) ||
      manifest.schemaVersion !== info.version || manifest.bytes !== fs.statSync(file).size ||
      manifest.foreignKeyViolations !== info.foreignKeyViolations ||
      JSON.stringify(manifest.counts) !== JSON.stringify(info.counts) ||
      manifest.sha256 !== await digest(file)) {
    throw new Error('Backup manifest, checksum, or ledger identity does not match the SQLite snapshot. Restore was not started.');
  }
  return manifest;
}
