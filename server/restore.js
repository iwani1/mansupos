import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.js';
import { SCHEMA_VERSION } from './db.js';
import { inspectSnapshot, createManifest, verifyManifest, writeManifest, assertRestorableSnapshot } from './backup-metadata.js';
import { assertLedgerIdentity } from './ledger-identity.js';
import { acquireInstanceLease } from './instance-lease.js';

// A safety copy is not permission to hide newer receipts, Woo intents, cash
// movements or staff changes by swapping an older database into service. Use
// shared historical columns so a valid earlier-schema snapshot can be compared
// with a later migration; missing/newer business rows must be reviewed offline.
const protectedRows = [
  ['sales', ['id']], ['sale_events', ['id']], ['shifts', ['id']], ['cash_movements', ['id']],
  ['audit', ['id']], ['users', ['id']], ['trade_buyers', ['id']],
  ['instore_imports', ['id']], ['instore_inventory', ['sku']], ['instore_sales', ['id']],
  ['instore_stock_movements', ['id']], ['instore_stock_counts', ['idempotency_key']],
  ['offline_devices', ['id']], ['offline_events', ['id']],
  ['wholesale_prices', ['product_id', 'variation_id']], ['wholesale_price_revisions', ['id']],
];
function refuseNewerLedgerWork(destination, source) {
  const active = new DatabaseSync(destination, { readOnly: true });
  const saved = new DatabaseSync(source, { readOnly: true });
  try {
    const hasTable = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const quoted = name => `"${name.replaceAll('"', '""')}"`;
    for (const [table, keys] of protectedRows) {
      if (!hasTable(active, table)) {
        // A backup may have a later table that the active ledger lacks; never
        // skip its business rows just because the comparison direction changed.
        if (hasTable(saved, table) && saved.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
          throw new Error(`Active POS ${table} has deleted records still present in the backup. Restore refused; review both ledgers and WooCommerce offline.`);
        }
        continue;
      }
      if (!hasTable(saved, table)) {
        if (active.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
          throw new Error(`Active POS ${table} has newer records absent from this backup. Restore refused; review both ledgers and WooCommerce offline.`);
        }
        continue;
      }
      const savedColumns = new Set(saved.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      const columns = active.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name).filter(name => savedColumns.has(name));
      if (keys.some(key => !columns.includes(key))) throw new Error(`Active POS ${table} cannot be compared to the backup. Restore refused.`);
      const selection = columns.map(quoted).join(',');
      const where = keys.map(key => `${quoted(key)}=?`).join(' AND ');
      const inBackup = saved.prepare(`SELECT ${selection} FROM ${table} WHERE ${where}`);
      for (const row of active.prepare(`SELECT ${selection} FROM ${table}`).iterate()) {
        const original = inBackup.get(...keys.map(key => row[key]));
        if (!original || columns.some(column => row[column] !== original[column])) {
          throw new Error(`Active POS ${table} has newer or changed records absent from this backup. Restore refused; review both ledgers and WooCommerce offline.`);
        }
      }
      // The reverse check matters too: a deleted user, receipt or other
      // protected record must not reappear when an older image is restored.
      // A first restore to an empty volume has no active history to compare;
      // its accounts are quarantined separately below.
      const inActive = active.prepare(`SELECT 1 FROM ${table} WHERE ${where}`);
      for (const row of saved.prepare(`SELECT ${keys.map(quoted).join(',')} FROM ${table}`).iterate()) {
        if (!inActive.get(...keys.map(key => row[key]))) {
          throw new Error(`Active POS ${table} has deleted records still present in the backup. Restore refused; review both ledgers and WooCommerce offline.`);
        }
      }
    }
  } finally { saved.close(); active.close(); }
}

process.umask(0o077);
const config = readConfig();
const source = process.argv[2];
const confirm = process.argv[3];
if (!source) throw new Error('Usage: npm run restore -- /private/backup/pos-live-DATE.db --confirm-restore');
if (confirm !== '--confirm-restore') throw new Error('Restore is destructive. Stop the POS service, verify the backup, then pass --confirm-restore.');
if (!fs.existsSync(source)) throw new Error(`Backup not found: ${source}`);
const destination = path.join(config.dataDir, `pos-${config.mode}.db`);
if (fs.existsSync(destination) && fs.realpathSync(source) === fs.realpathSync(destination)) throw new Error('Backup source is the active POS ledger. Refusing self-restore.');

// A stopped POS holds no lease. This prevents another POS process from starting
// or a second restore running while the identity checks and swap take place.
const lease = acquireInstanceLease(config);
let staged = '';
try {
  const info = inspectSnapshot(source);
  // v1/v2 have no service-mode marker, so their destination cannot be checked.
  if (info.version < 3 || info.version > SCHEMA_VERSION) throw new Error(`Backup schema ${info.version} is not supported by this application (supported: 3-${SCHEMA_VERSION}).`);
  if (!info.mode) throw new Error('Backup does not declare its POS mode. Create a new backup with this application version before restoring.');
  if (info.mode !== config.mode) throw new Error(`Backup mode "${info.mode}" does not match restore mode "${config.mode}".`);
  assertLedgerIdentity(info, config, { existing: config.mode === 'live' || info.version >= 9 });
  if (!info.counts || info.foreignKeyViolations) throw new Error('Backup is missing its sale ledger or has orphan references. Review it on an isolated copy before restore.');
  if (info.version >= 9 && (!info.service || !info.ledgerId)) throw new Error('Backup has an incomplete service identity. Review it on an isolated copy before restore.');
  const manifest = await verifyManifest(source, info);
  assertRestorableSnapshot(source, info.version);
  if (!manifest) console.log('Legacy staging/demo backup has no manifest. Verify its provenance before resuming service.');
  // Pin the exact verified image, not just its declared mode and ledger UUID.
  // The source could be replaced or acquire WAL changes after inspection.
  const expected = manifest || await createManifest(source, info);

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  let safety = '';
  if (fs.existsSync(destination)) {
    const current = inspectSnapshot(destination);
    if (current.mode !== config.mode || current.service !== info.service || current.ledgerId !== info.ledgerId) {
      throw new Error('Destination ledger identity does not match the backup. Wrong-service or different-ledger restore refused before replacing any files.');
    }
    assertRestorableSnapshot(destination, current.version);
    refuseNewerLedgerWork(destination, source);
    safety = `${destination}.before-restore-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.db`;
    const active = new DatabaseSync(destination);
    try { await backup(active, safety); } finally { active.close(); }
    fs.chmodSync(safety, 0o600);
    const safetyInfo = inspectSnapshot(safety);
    if (safetyInfo.mode !== current.mode || safetyInfo.service !== current.service || safetyInfo.ledgerId !== current.ledgerId) {
      throw new Error('Safety snapshot changed ledger identity. Restore aborted before replacing the existing ledger.');
    }
    writeManifest(safety, await createManifest(safety, safetyInfo));
    console.log(`Existing database preserved at: ${safety}`);
  }

  staged = `${destination}.restore-${randomUUID()}.partial`;
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try { await backup(sourceDb, staged); } finally { sourceDb.close(); }
  fs.chmodSync(staged, 0o600);
  const stagedInfo = inspectSnapshot(staged);
  if (stagedInfo.mode !== info.mode || stagedInfo.service !== info.service || stagedInfo.ledgerId !== info.ledgerId) {
    throw new Error('Staged restore changed ledger identity. Existing ledger was not replaced.');
  }
  const stagedManifest = await createManifest(staged, stagedInfo);
  if (stagedManifest.sha256 !== expected.sha256 || stagedManifest.bytes !== expected.bytes) {
    throw new Error('Staged restore differs from the verified backup. Existing ledger was not replaced.');
  }
  // A fresh disaster-recovery volume has no active ledger to reveal which
  // backed-up users were subsequently deleted or revoked. Even a same-ledger
  // restore must not revive an old password. Disable EVERY real account and
  // replace its hash with an invalid sentinel before publishing the image.
  // No role, user ID, receipt, shift, or historical audit row is discarded.
  // The demo workspace is disposable sample data and has its own passwordless
  // /auth/demo route; it never carries real staff credentials.
  // DELETE journaling keeps the changes in the staged base DB, not an orphaned
  // WAL file after the base is renamed.
  const disabledHash = '!disabled-after-restore'; // deliberately not a valid password hash
  const stagedDb = new DatabaseSync(staged);
  try {
    stagedDb.exec('PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
    try {
      stagedDb.prepare('DELETE FROM sessions').run();
      if (config.mode !== 'demo') {
        stagedDb.prepare('UPDATE users SET active=0,password_hash=?,must_change_password=1,failed_attempts=0,locked_until=NULL').run(disabledHash);
        stagedDb.prepare("INSERT INTO app_meta(key,value) VALUES ('restored_accounts_locked','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
      }
      stagedDb.prepare('INSERT INTO audit(actor,action,subject,created_at) VALUES (?,?,?,?)')
        .run('system', 'ledger.restored', config.mode === 'demo' ? 'demo_sessions_revoked' : 'sessions_revoked_accounts_disabled', new Date().toISOString());
      stagedDb.exec('COMMIT');
    } catch (error) { stagedDb.exec('ROLLBACK'); throw error; }
  } finally { stagedDb.close(); }
  const cleaned = inspectSnapshot(staged);
  if (cleaned.mode !== info.mode || cleaned.service !== info.service || cleaned.ledgerId !== info.ledgerId || cleaned.foreignKeyViolations) {
    throw new Error('Session-cleared staged ledger failed verification. Existing ledger was not replaced.');
  }
  if (config.mode !== 'demo') {
    const check = new DatabaseSync(staged, { readOnly: true });
    try {
      if (check.prepare("SELECT value FROM app_meta WHERE key='restored_accounts_locked'").get()?.value !== '1' ||
          check.prepare('SELECT 1 FROM sessions LIMIT 1').get() ||
          check.prepare('SELECT 1 FROM users WHERE active<>0 OR password_hash<>? OR must_change_password<>1 LIMIT 1').get(disabledHash)) {
        throw new Error('Restored accounts were not locked. Existing ledger was not replaced.');
      }
    } finally { check.close(); }
  }
  // The verified safety copy already contains committed WAL data. Do not
  // combine the restored base with stale WAL/SHM pages from the old ledger.
  for (const suffix of ['-wal', '-shm']) {
    const file = `${destination}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  fs.renameSync(staged, destination);
  staged = '';
  const restored = inspectSnapshot(destination);
  if (restored.mode !== info.mode || restored.service !== info.service || restored.ledgerId !== info.ledgerId) {
    throw new Error('Restored ledger identity failed verification. Keep the POS stopped and use the safety snapshot.');
  }
  console.log(`Restored POS ledger for mode=${config.mode}, service=${info.service || 'legacy-unbound'}. Saved sessions were revoked.${config.mode === 'demo' ? ' Demo sample accounts remain disposable.' : ' All real accounts and old passwords are DISABLED; the POS cannot start until a separately authorized offline owner recovery with a NEW temporary password.'} Reconcile WooCommerce orders and physical cash before any approved restart.`);
} finally {
  if (staged && fs.existsSync(staged)) fs.rmSync(staged);
  lease.release();
}
