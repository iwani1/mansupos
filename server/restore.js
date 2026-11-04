import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.js';

const config = readConfig();
const source = process.argv[2];
const confirm = process.argv[3];
if (!source) throw new Error('Usage: npm run restore -- /private/backup/pos-live-DATE.db --confirm-restore');
if (confirm !== '--confirm-restore') throw new Error('Restore is destructive. Stop the POS service, verify the backup, then pass --confirm-restore.');
if (!fs.existsSync(source)) throw new Error(`Backup not found: ${source}`);
const check = new DatabaseSync(source, { readOnly: true });
const integrity = check.prepare('PRAGMA integrity_check').get();
const version = check.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get().version;
check.close();
if (integrity.integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
if (version < 2) throw new Error('Backup schema is too old for this application version.');
const destination = path.join(config.dataDir, `pos-${config.mode}.db`);
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
if (fs.existsSync(destination)) {
  const safety = `${destination}.before-restore-${new Date().toISOString().replaceAll(':', '-')}`;
  fs.copyFileSync(destination, safety);
  fs.chmodSync(safety, 0o600);
  console.log(`Existing database preserved at: ${safety}`);
}
for (const suffix of ['', '-wal', '-shm']) {
  const file = `${destination}${suffix}`;
  if (fs.existsSync(file)) fs.rmSync(file);
}
fs.copyFileSync(source, destination);
fs.chmodSync(destination, 0o600);
const restored = new DatabaseSync(destination, { readOnly: true });
const result = restored.prepare('PRAGMA integrity_check').get();
restored.close();
if (result.integrity_check !== 'ok') throw new Error('Restored database failed integrity check.');
console.log(`Restored POS ledger for mode=${config.mode}. Reconcile WooCommerce orders before resuming sales.`);
