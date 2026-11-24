import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { openSecret, masterKeyCheck } from './secrets.js';
import { acquireLock } from './lock.js';

// Restores a backup made by backupPlatform (CLI `backup` or the scheduled job).
//   verifyBackup  - read-only: checksums, SQLite integrity, every shop copy
//                   still names its own shop, and every saved store key opens
//                   with this server's master key.
//   restoreBackup - the platform must be stopped (the data-folder lock
//                   enforces it). Nothing is deleted: the current files are
//                   moved to <data>/pre-restore-<time>/ first, so a restore
//                   can itself be undone.
// A whole-platform restore replaces platform.db and every shop; --shop
// restores one shop's database and leaves the rest alone.
const SHOP_ID = /^shp_[a-z2-7]{20}$/;
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const DB_FILES = name => [name, `${name}-wal`, `${name}-shm`];

function inspectDb(file, check) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (Object.values(db.prepare('PRAGMA integrity_check').get())[0] !== 'ok') return 'SQLite integrity check failed';
    return check ? check(db) : null;
  } catch (error) { return `cannot be read (${error.message})`; } finally { db.close(); }
}

export function verifyBackup(from, config) {
  const dir = path.resolve(from);
  const problems = [];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return { dir, manifest: null, problems: ['No readable manifest.json: this is not a Mansu POS platform backup folder.'] }; }
  if (manifest.kind !== 'mansu-pos-platform' || !manifest.central || !Array.isArray(manifest.shops)) return { dir, manifest, problems: ['manifest.json is not a Mansu POS platform backup.'] };

  const central = path.join(dir, 'platform.db');
  let backupShops = new Map();
  let secrets = 0;
  if (!fs.existsSync(central)) problems.push('platform.db is missing.');
  else if (sha256(central) !== manifest.central.sha256) problems.push('platform.db does not match its checksum (changed or damaged since the backup).');
  else {
    const issue = inspectDb(central, db => {
      backupShops = new Map(db.prepare('SELECT id, slug FROM shops').all().map(s => [s.id, s.slug]));
      const stored = db.prepare("SELECT value FROM platform_settings WHERE key='master_key_check'").get()?.value;
      if (stored && stored !== masterKeyCheck(config.masterKey)) return 'it was made with a different PLATFORM_MASTER_KEY. Use the master key that was in use when the backup was made.';
      for (const row of db.prepare('SELECT shop_id, kind, sealed FROM shop_secrets').all()) {
        try { openSecret(config.masterKey, row.shop_id, row.kind, row.sealed); secrets++; } catch {
          return 'saved store keys do not open with this server\'s PLATFORM_MASTER_KEY. Use the master key that was in use when the backup was made.';
        }
      }
      return null;
    });
    if (issue) problems.push(`platform.db: ${issue}`);
  }
  for (const entry of manifest.shops) {
    // Paths come from the shop id, never from the manifest's file names.
    if (!SHOP_ID.test(String(entry.id))) { problems.push(`Shop entry with an invalid id: ${String(entry.id).slice(0, 40)}`); continue; }
    const file = path.join(dir, 'shops', entry.id, 'pos-live.db');
    if (!fs.existsSync(file)) { problems.push(`${entry.slug}: database missing.`); continue; }
    if (sha256(file) !== entry.sha256) { problems.push(`${entry.slug}: database does not match its checksum.`); continue; }
    const issue = inspectDb(file, db => (db.prepare("SELECT value FROM app_meta WHERE key='tenant_id'").get()?.value === entry.id ? null : 'belongs to a different shop'));
    if (issue) problems.push(`${entry.slug}: ${issue}`);
    if (backupShops.size && !backupShops.has(entry.id)) problems.push(`${entry.slug}: not in the backup's platform.db.`);
  }
  const bytes = [manifest.central.bytes, ...manifest.shops.map(s => s.bytes)].reduce((a, b) => a + (Number(b) || 0), 0);
  return { dir, manifest, problems, bytes, secrets, shops: manifest.shops.length };
}

function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

function moveAside(file, safetyDir, relative) {
  if (!fs.existsSync(file)) return false;
  const target = path.join(safetyDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.renameSync(file, target);
  return true;
}

function place(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const partial = `${destination}.restoring`;
  fs.copyFileSync(source, partial);
  fs.chmodSync(partial, 0o600);
  fs.renameSync(partial, destination);
}

// Shops on this server now that a whole-platform restore would take away
// (created after the backup was made). Their files are kept in the
// pre-restore folder, but they would no longer be served.
function currentShops(config) {
  if (!fs.existsSync(config.registryFile)) return [];
  const reg = new DatabaseSync(config.registryFile, { readOnly: true });
  try { return reg.prepare('SELECT id, slug FROM shops').all(); } finally { reg.close(); }
}

export function planRestore({ from, config, shopSlug = null }) {
  const check = verifyBackup(from, config);
  const inBackup = new Set((check.manifest?.shops || []).map(s => s.id));
  return { ...check, notInBackup: shopSlug ? [] : currentShops(config).filter(s => !inBackup.has(s.id)).map(s => s.slug),
    restoring: shopSlug ? [shopSlug] : (check.manifest?.shops || []).map(s => s.slug) };
}

export function restoreBackup({ from, config, shopSlug = null, now = new Date() }) {
  const release = acquireLock(config.dataDir, 'restore');
  try {
    const check = verifyBackup(from, config);
    if (check.problems.length) throw new Error(`The backup did not pass its checks; nothing was changed:\n- ${check.problems.join('\n- ')}`);
    const { dir, manifest } = check;
    const safetyDir = path.join(config.dataDir, `pre-restore-${now.toISOString().replaceAll(':', '-')}`);
    if (fs.existsSync(safetyDir)) throw new Error('A pre-restore folder for this moment already exists.');

    if (shopSlug) {
      const entry = manifest.shops.find(s => s.slug === shopSlug);
      if (!entry) throw new Error(`The backup has no database for "${shopSlug}".`);
      if (!fs.existsSync(config.registryFile)) throw new Error('No platform.db here: restore the whole platform instead of one shop.');
      const reg = new DatabaseSync(config.registryFile, { readOnly: true });
      let current;
      try { current = reg.prepare('SELECT id, slug FROM shops WHERE slug=?').get(shopSlug); } finally { reg.close(); }
      if (!current || current.id !== entry.id) throw new Error(`"${shopSlug}" on this server is not the shop in the backup (different id). Restore the whole platform instead.`);
      if (freeBytes(config.dataDir) < (entry.bytes || 0) * 1.2) throw new Error('Not enough free disk space for the restore.');
      const shopDir = path.join(config.shopsDir, entry.id);
      fs.mkdirSync(safetyDir, { recursive: true, mode: 0o700 });
      for (const name of DB_FILES('pos-live.db')) moveAside(path.join(shopDir, name), safetyDir, path.join('shops', entry.id, name));
      place(path.join(dir, 'shops', entry.id, 'pos-live.db'), path.join(shopDir, 'pos-live.db'));
      return { safetyDir, restored: [entry.slug], central: false, backupCreatedAt: manifest.createdAt };
    }

    if (freeBytes(config.dataDir) < check.bytes * 1.2) throw new Error('Not enough free disk space for the restore.');
    fs.mkdirSync(safetyDir, { recursive: true, mode: 0o700 });
    for (const name of DB_FILES('platform.db')) moveAside(path.join(config.dataDir, name), safetyDir, name);
    moveAside(config.shopsDir, safetyDir, 'shops');
    place(path.join(dir, 'platform.db'), config.registryFile);
    for (const entry of manifest.shops) place(path.join(dir, 'shops', entry.id, 'pos-live.db'), path.join(config.shopsDir, entry.id, 'pos-live.db'));
    fs.mkdirSync(config.shopsDir, { recursive: true, mode: 0o700 });
    return { safetyDir, restored: manifest.shops.map(s => s.slug), central: true, backupCreatedAt: manifest.createdAt };
  } finally { release(); }
}
