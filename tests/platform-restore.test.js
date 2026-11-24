// Restoring platform backups: checks before anything changes, nothing deleted,
// one shop or everything, and never while the platform is running.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { createPlatform } from '../server/platform/platform.js';
import { backupPlatform } from '../server/platform/backup.js';
import { verifyBackup, planRestore, restoreBackup } from '../server/platform/restore.js';
import { acquireLock } from '../server/platform/lock.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const api = { async request() { return { data: [], total: 0, pages: 1 }; }, async products() { return { data: [], total: 0, pages: 1 }; } };

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-restore-'));
  const key = randomBytes(32).toString('hex');
  const env = { NODE_ENV: 'test', PLATFORM_BASE_DOMAIN: 'mansupos.test', PLATFORM_DATA_DIR: path.join(dir, 'data'), PLATFORM_MASTER_KEY: key, PLATFORM_JOBS: 'off' };
  let platform = null;
  const open = () => { platform = createPlatform({ env, logger: quiet, appFactory: ({ env: e, logger, extend }) => createApp({ env: e, logger, extend, api }) }); return platform; };
  const close = () => { platform?.close(); platform = null; };
  t.after(() => { close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, env, open, close, get platform() { return platform; } };
}

async function makeShops(h) {
  const p = h.open();
  const a = p.provisionShop({ slug: 'amaboutique', name: 'Ama Boutique', storeUrl: 'https://ama.example.com', ownerUsername: 'ama', actor: 'test' }).shop;
  const b = p.provisionShop({ slug: 'kofistyles', name: 'Kofi Styles', storeUrl: 'https://kofi.example.com', ownerUsername: 'kofi', actor: 'test' }).shop;
  p.registry.setSecret(a.id, 'woo_key', `ck_${'a'.repeat(40)}`, 'test');
  return { p, a, b };
}

const shopDb = (h, id) => path.join(h.env.PLATFORM_DATA_DIR, 'shops', id, 'pos-live.db');
const mark = (file, value) => { const db = new DatabaseSync(file); db.exec('CREATE TABLE IF NOT EXISTS restore_probe(v TEXT)'); db.prepare('DELETE FROM restore_probe').run(); db.prepare('INSERT INTO restore_probe VALUES (?)').run(value); db.close(); };
const probe = file => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare('SELECT v FROM restore_probe').get()?.v ?? null; } catch { return null; } finally { db.close(); } };

test('a whole-platform restore brings back every shop and keeps the files it replaced', async t => {
  const h = setup(t);
  const { p, a, b } = await makeShops(h);
  assert.ok(fs.existsSync(shopDb(h, a.id)) && fs.existsSync(shopDb(h, b.id)), 'provisioning creates each shop database');
  mark(shopDb(h, a.id), 'before');
  const { dir } = await backupPlatform(p.config, p.registry, path.join(h.dir, 'backups'));
  // Things change after the backup: a sale-like edit, a new shop, a renamed shop.
  mark(shopDb(h, a.id), 'after');
  const c = p.provisionShop({ slug: 'latecomer', name: 'Late', storeUrl: 'https://late.example.com', ownerUsername: 'late', actor: 'test' }).shop;
  p.registry.update(b.id, { name: 'Kofi Renamed' }, 'test');
  const config = p.config;

  const plan = planRestore({ from: dir, config });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.secrets, 1);
  assert.deepEqual(plan.notInBackup, ['latecomer'], 'warns about shops the backup does not have');
  const serverLock = acquireLock(config.dataDir, 'server'); // what server/platform/index.js holds while running
  assert.throws(() => restoreBackup({ from: dir, config }), /in use by process \d+ \(server/, 'refuses while the platform holds the data folder');
  assert.equal(probe(shopDb(h, a.id)), 'after', 'nothing changed');
  serverLock();

  h.close();
  const done = restoreBackup({ from: dir, config });
  assert.equal(done.central, true);
  assert.deepEqual(done.restored.sort(), ['amaboutique', 'kofistyles']);
  assert.equal(probe(shopDb(h, a.id)), 'before');
  assert.equal(probe(path.join(done.safetyDir, 'shops', a.id, 'pos-live.db')), 'after', 'the replaced database is kept');
  assert.ok(fs.existsSync(path.join(done.safetyDir, 'shops', c.id, 'pos-live.db')), 'the late shop is kept aside, not deleted');
  assert.ok(fs.existsSync(path.join(done.safetyDir, 'platform.db')));

  const back = h.open();
  assert.equal(back.registry.bySlug('kofistyles').name, 'Kofi Styles');
  assert.equal(back.registry.bySlug('latecomer'), null);
  assert.equal(back.registry.secretsFor(a.id).woo_key, `ck_${'a'.repeat(40)}`, 'store keys open after the restore');
});

test('one shop can be restored without touching the others', async t => {
  const h = setup(t);
  const { p, a, b } = await makeShops(h);
  mark(shopDb(h, a.id), 'a-before'); mark(shopDb(h, b.id), 'b-before');
  const { dir } = await backupPlatform(p.config, p.registry, path.join(h.dir, 'backups'));
  mark(shopDb(h, a.id), 'a-after'); mark(shopDb(h, b.id), 'b-after');
  p.registry.update(b.id, { name: 'Kofi Renamed' }, 'test');
  const config = p.config;
  h.close();
  assert.throws(() => restoreBackup({ from: dir, config, shopSlug: 'nosuch' }), /no database for "nosuch"/);
  const done = restoreBackup({ from: dir, config, shopSlug: 'amaboutique' });
  assert.equal(done.central, false);
  assert.equal(probe(shopDb(h, a.id)), 'a-before');
  assert.equal(probe(shopDb(h, b.id)), 'b-after', 'the other shop is untouched');
  assert.equal(h.open().registry.bySlug('kofistyles').name, 'Kofi Renamed', 'platform.db is untouched');
});

test('a damaged, tampered or wrong-key backup is refused before anything changes', async t => {
  const h = setup(t);
  const { p, a, b } = await makeShops(h);
  const { dir } = await backupPlatform(p.config, p.registry, path.join(h.dir, 'backups'));
  const config = p.config;
  h.close();
  const copy = name => { const to = path.join(h.dir, name); fs.cpSync(dir, to, { recursive: true }); return to; };

  const damaged = copy('damaged');
  fs.appendFileSync(path.join(damaged, 'shops', a.id, 'pos-live.db'), 'x');
  assert.match(verifyBackup(damaged, config).problems.join(), /amaboutique: database does not match its checksum/);

  // Swapping two shops' files (with matching checksums) is caught by the tenant check.
  const swapped = copy('swapped');
  const manifest = JSON.parse(fs.readFileSync(path.join(swapped, 'manifest.json'), 'utf8'));
  fs.copyFileSync(path.join(dir, 'shops', b.id, 'pos-live.db'), path.join(swapped, 'shops', a.id, 'pos-live.db'));
  manifest.shops.find(s => s.id === a.id).sha256 = manifest.shops.find(s => s.id === b.id).sha256;
  fs.writeFileSync(path.join(swapped, 'manifest.json'), JSON.stringify(manifest));
  assert.match(verifyBackup(swapped, config).problems.join(), /amaboutique: belongs to a different shop/);

  const escape = copy('escape');
  const m2 = JSON.parse(fs.readFileSync(path.join(escape, 'manifest.json'), 'utf8'));
  m2.shops[0].id = '../../etc';
  fs.writeFileSync(path.join(escape, 'manifest.json'), JSON.stringify(m2));
  assert.match(verifyBackup(escape, config).problems.join(), /invalid id/);

  const otherKey = { ...config, masterKey: randomBytes(32) };
  assert.match(verifyBackup(dir, otherKey).problems.join(), /different PLATFORM_MASTER_KEY/);
  assert.throws(() => createPlatform({ env: { ...h.env, PLATFORM_MASTER_KEY: randomBytes(32).toString('hex') }, logger: quiet }), /not the key this platform data was created with/, 'the platform will not start with the wrong key');
  assert.match(verifyBackup(h.dir, config).problems.join(), /not a Mansu POS platform backup/);

  const before = fs.readFileSync(config.registryFile);
  assert.throws(() => restoreBackup({ from: damaged, config }), /nothing was changed/);
  assert.deepEqual(fs.readFileSync(config.registryFile), before);
  assert.equal(fs.readdirSync(config.dataDir).some(n => n.startsWith('pre-restore-')), false);
});

test('the data-folder lock keeps a restore and a running platform apart', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const release = acquireLock(dir, 'server');
  // Another process cannot take it while this one is alive...
  const other = spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(path.resolve('server/platform/lock.js'))}; try { acquireLock(${JSON.stringify(dir)}, 'restore'); console.log('TOOK'); } catch (e) { console.log(e.message); }`], { encoding: 'utf8' });
  assert.match(other.stdout, /in use by process \d+ \(server/);
  release();
  // ...and a lock left by a process that has died is taken over.
  fs.writeFileSync(path.join(dir, 'platform.lock'), JSON.stringify({ pid: 2147483646, purpose: 'server', since: 'x' }));
  acquireLock(dir, 'restore')();
  // A live process id from before a reboot does not count either.
  fs.writeFileSync(path.join(dir, 'platform.lock'), JSON.stringify({ pid: process.pid, purpose: 'server', since: 'x', boot: 'an-earlier-boot' }));
  const again = acquireLock(dir, 'restore');
  again();
  assert.equal(fs.existsSync(path.join(dir, 'platform.lock')), false);
});
