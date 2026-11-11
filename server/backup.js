import 'dotenv/config';
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.js';

process.umask(0o077);
const config = readConfig();
const source = path.join(config.dataDir, `pos-${config.mode}.db`);
if (!fs.existsSync(source)) throw new Error(`No POS database found at ${source}`);
const destinationDir = process.argv[2] || path.join(config.dataDir, 'backups');
fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
const destination = path.join(destinationDir, `pos-${config.mode}-${new Date().toISOString().replaceAll(':','-')}.db`);
if (fs.existsSync(destination)) throw new Error('Backup destination already exists; refusing to overwrite.');
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, destination);
  fs.chmodSync(destination, 0o600);
  const check = new DatabaseSync(destination, { readOnly: true });
  const result = check.prepare('PRAGMA integrity_check').get();
  check.close();
  if (result.integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
  console.log(`Verified POS ledger backup: ${destination}`);
  console.log('This backs up the POS ledger only. Back up WordPress files and its database separately before deployment.');
} finally { db.close(); }
