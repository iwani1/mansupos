// One-time OFFLINE adoption tool for a reviewed pre-v9 live ledger. Never run
// during an ordinary app start or restore. Requires a verified, unchanged
// SQLite backup of this exact ledger and an explicit pilot/trading designation.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from './config.js';
import { createManifest, inspectSnapshot, verifyManifest, assertRestorableSnapshot } from './backup-metadata.js';
import { ledgerInfo, serviceIdentity } from './ledger-identity.js';
import { acquireInstanceLease } from './instance-lease.js';

process.umask(0o077);
const config = readConfig();
const [command, service, backupFile] = process.argv.slice(2);
if (config.mode !== 'live' || command !== '--bind' || service !== serviceIdentity(config) || !backupFile || process.argv.length !== 5) {
  throw new Error('Usage: with the reviewed LIVE service configuration and a STOPPED service: node server/bind-legacy-ledger.js --bind live-pilot|live-trading /private/exact-verified-backup.db');
}
const file = path.join(config.dataDir, 'pos-live.db');
if (!fs.existsSync(file) || !fs.existsSync(backupFile)) throw new Error('Ledger and its prior verified backup must both exist.');
const lease = acquireInstanceLease(config);
let tempDir = '';
try {
  const info = inspectSnapshot(file);
  const saved = inspectSnapshot(backupFile);
  await verifyManifest(backupFile, saved);
  if (info.version >= 3 && info.version <= 8) {
    assertRestorableSnapshot(file, info.version);
    assertRestorableSnapshot(backupFile, saved.version);
  }
  if (info.mode !== 'live' || info.version < 3 || info.version > 8 || info.service || info.ledgerId ||
      saved.mode !== info.mode || saved.version !== info.version || saved.service || saved.ledgerId ||
      info.foreignKeyViolations || saved.foreignKeyViolations) {
    throw new Error('Ledger is not an unbound legacy live ledger, or its backup does not match. Review it; no identity was assigned.');
  }
  // A SHA of a running WAL file is not the content of a consistent database.
  // Under the exclusive service lease, compare a second SQLite online snapshot
  // to the original verified backup before changing ANY app_meta row.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-bind-'));
  fs.chmodSync(tempDir, 0o700);
  const snapshot = path.join(tempDir, 'comparison.db');
  const source = new DatabaseSync(file, { readOnly: true });
  try { await backup(source, snapshot); } finally { source.close(); }
  const expected = await createManifest(backupFile, saved);
  const actual = await createManifest(snapshot);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new Error('The live ledger changed since its verified backup. Stop and take a new reviewed backup before binding.');
  }
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    try {
      const current = ledgerInfo(db);
      if (current.mode !== 'live' || current.service || current.ledgerId || current.version !== info.version) {
        throw new Error('Ledger changed while being bound. No identity was assigned.');
      }
      const id = randomUUID();
      db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run('service_identity', service);
      db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run('ledger_uuid', id);
      db.prepare('INSERT INTO audit(actor,action,subject,created_at) VALUES (?,?,?,?)')
        .run('system', 'ledger.identity_bound', service, new Date().toISOString());
      db.exec('COMMIT');
      console.log(`Bound reviewed legacy ${service} ledger (UUID ${id}). Keep its pre-bind backup and create a NEW verified backup with a new manifest before any upgrade/restore.`);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
} finally {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  lease.release();
}
