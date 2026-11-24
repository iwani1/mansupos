import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// One verified snapshot of the whole platform: the central database plus every
// shop's own database, taken with SQLite's online backup (safe while running).
// Each shop copy must still say which shop it belongs to. The master key is
// NOT in the snapshot: keep it backed up separately, or the shop keys in
// platform.db cannot be read after a restore.
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function copyVerified(source, destination, check) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const partial = `${destination}.partial`;
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, partial); } finally { db.close(); }
  try {
    const copy = new DatabaseSync(partial, { readOnly: true });
    try {
      const result = copy.prepare('PRAGMA integrity_check').get();
      if (Object.values(result)[0] !== 'ok') throw new Error(`Integrity check failed for ${path.basename(source)}.`);
      check?.(copy);
    } finally { copy.close(); }
    fs.renameSync(partial, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    for (const leftover of [partial, `${partial}-shm`, `${partial}-wal`]) fs.rmSync(leftover, { force: true });
  }
  return { file: path.relative(path.dirname(path.dirname(destination)), destination), sha256: sha256(destination), bytes: fs.statSync(destination).size };
}

export async function backupPlatform(config, registry, destinationRoot = path.join(config.dataDir, 'backups')) {
  const stamp = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(destinationRoot, stamp);
  if (fs.existsSync(dir)) throw new Error('Backup folder already exists; refusing to overwrite.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifest = { createdAt: new Date().toISOString(), kind: 'mansu-pos-platform', central: null, shops: [], skipped: [] };
  manifest.central = await copyVerified(config.registryFile, path.join(dir, 'platform.db'));
  for (const shop of registry.list()) {
    const source = path.join(registry.shopDir(shop), 'pos-live.db');
    if (!fs.existsSync(source)) { manifest.skipped.push({ id: shop.id, slug: shop.slug, reason: 'no database yet' }); continue; }
    const entry = await copyVerified(source, path.join(dir, 'shops', shop.id, 'pos-live.db'), copy => {
      const owner = copy.prepare("SELECT value FROM app_meta WHERE key='tenant_id'").get()?.value;
      if (owner !== shop.id) throw new Error(`Database in ${shop.slug}'s folder does not belong to that shop.`);
    });
    manifest.shops.push({ id: shop.id, slug: shop.slug, status: shop.status, ...entry });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { dir, manifest };
}
