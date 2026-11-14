import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.js';
import { inspectSnapshot, createManifest, writeManifest } from './backup-metadata.js';
import { assertLedgerIdentity, ledgerInfo } from './ledger-identity.js';

process.umask(0o077);
const config = readConfig();
const source = path.join(config.dataDir, `pos-${config.mode}.db`);
if (!fs.existsSync(source)) throw new Error(`No POS database found at ${source}`);
const destinationDir = process.argv[2] || path.join(config.dataDir, 'backups');
fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
const destination = path.join(destinationDir, `pos-${config.mode}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.db`);
const partial = `${destination}.partial`;
const db = new DatabaseSync(source, { readOnly: true });
try {
  const sourceInfo = ledgerInfo(db);
  if (sourceInfo.mode !== config.mode) throw new Error('Source ledger mode is missing or does not match this backup service.');
  // An unbound pre-v9 live ledger may be backed up before an identity review,
  // but its manifest must NOT claim a pilot/trading identity it does not have.
  assertLedgerIdentity(sourceInfo, config, { existing: false });
  if (sourceInfo.version >= 9 && (!sourceInfo.service || !sourceInfo.ledgerId)) throw new Error('POS ledger v9 is missing its service identity. Stop and investigate.');
  await backup(db, partial);
  fs.chmodSync(partial, 0o600);
  const info = inspectSnapshot(partial);
  if (info.mode !== sourceInfo.mode || info.service !== sourceInfo.service || info.ledgerId !== sourceInfo.ledgerId) {
    throw new Error('POS ledger changed identity during backup. No verified snapshot was published.');
  }
  const manifest = await createManifest(partial, info);
  if (fs.existsSync(destination) || fs.existsSync(`${destination}.manifest.json`)) throw new Error('Backup destination already exists; refusing to overwrite.');
  fs.renameSync(partial, destination);
  try { writeManifest(destination, manifest); }
  catch (error) { fs.rmSync(destination); throw error; }
  console.log(`Verified POS ledger backup and manifest: ${destination}`);
  if (info.mode === 'live' && !info.service) console.log('LEGACY LIVE BACKUP IS UNBOUND: do not restore or upgrade it until this exact ledger has been reviewed and explicitly bound.');
  if (info.foreignKeyViolations) console.log(`WARNING: ${info.foreignKeyViolations} foreign-key violation(s) found. Preserve this backup and investigate before migration.`);
  console.log('This backs up the POS ledger only. Back up WordPress files and its database separately before deployment.');
} finally {
  db.close();
  if (fs.existsSync(partial)) fs.rmSync(partial);
}
