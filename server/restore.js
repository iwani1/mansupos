import 'dotenv/config';
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.js';
import { SCHEMA_VERSION } from './db.js';
import { acquireInstanceLease } from './instance-lease.js';

process.umask(0o077);
const config = readConfig();
const source = process.argv[2];
const confirm = process.argv[3];
if (!source) throw new Error('Usage: npm run restore -- /private/backup/pos-live-DATE.db --confirm-restore');
if (confirm !== '--confirm-restore') throw new Error('Restore is destructive. Stop the POS service, verify the backup, then pass --confirm-restore.');
if (!fs.existsSync(source)) throw new Error(`Backup not found: ${source}`);

// Fail closed even when the POS runs in another container with its own PID 1.
// The same lease also prevents a POS process from starting during the restore.
const lease = acquireInstanceLease(config);
try {
  const destination = path.join(config.dataDir, `pos-${config.mode}.db`);
  const check = new DatabaseSync(source, { readOnly: true });
  let version = 0;
  let mode = '';
  try {
    const integrity = check.prepare('PRAGMA integrity_check').get();
    if (integrity.integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
    version = check.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get().version;
    const meta = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get();
    if (meta) mode = check.prepare("SELECT value FROM app_meta WHERE key='mode'").get()?.value || '';
  } finally { check.close(); }
  if (version < 2 || version > SCHEMA_VERSION) throw new Error(`Backup schema ${version} is not supported by this application (supported: 2-${SCHEMA_VERSION}).`);
  if (!mode) throw new Error('Backup does not declare its POS mode. Create a new backup with this application version before restoring.');
  if (mode !== config.mode) throw new Error(`Backup mode "${mode}" does not match restore mode "${config.mode}".`);

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  let safety = '';
  if (fs.existsSync(destination)) {
    safety = `${destination}.before-restore-${new Date().toISOString().replaceAll(':', '-')}`;
    const current = new DatabaseSync(destination);
    try {
      await backup(current, safety);
      fs.chmodSync(safety, 0o600);
      const verify = new DatabaseSync(safety, { readOnly: true });
      const ok = verify.prepare('PRAGMA integrity_check').get();
      verify.close();
      if (ok.integrity_check !== 'ok') throw new Error('Safety backup failed integrity check; restore aborted.');
    } finally { current.close(); }
    console.log(`Existing database preserved at: ${safety}`);
  }

  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${destination}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try { await backup(sourceDb, destination); } finally { sourceDb.close(); }
  fs.chmodSync(destination, 0o600);
  const restored = new DatabaseSync(destination, { readOnly: true });
  const result = restored.prepare('PRAGMA integrity_check').get();
  restored.close();
  if (result.integrity_check !== 'ok') throw new Error('Restored database failed integrity check.');
  console.log(`Restored POS ledger for mode=${config.mode}. Reconcile WooCommerce orders before resuming sales.`);
} finally { lease.release(); }
