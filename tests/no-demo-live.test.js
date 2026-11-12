import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../server/db.js';
import { readConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-no-demo-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const envFor = (mode, dir) => ({ NODE_ENV: 'test', POS_MODE: mode,
  POS_LIVE_READ_ONLY: mode === 'live' ? 'true' : 'false',
  POS_DATA_DIR: dir, POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'private-initial-passphrase-123',
  WOO_BASE_URL: mode === 'live' ? 'https://mansutrendzgh.com' : 'https://staging.example.com',
  WOO_CONSUMER_KEY: 'ck_mock', WOO_CONSUMER_SECRET: 'cs_mock',
});

test('live and staging ledgers contain no demo data; a restart scrubs only legacy sample stock', t => {
  for (const mode of ['live', 'staging']) {
    const dir = tempDir(t);
    const config = readConfig(envFor(mode, dir));
    const db = openDatabase(config);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM demo_stock').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    const ownerId = db.prepare("SELECT id FROM users WHERE role='owner'").get().id;
    db.prepare('INSERT INTO demo_stock(line_key,stock) VALUES (?,?)').run('7331:0', 5);
    const date = new Date().toISOString();
    db.prepare(`INSERT INTO sales(id,idempotency_key,fingerprint,number,status,total,tax,subtotal,currency,cashier_id,cashier_name,items_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('real-record-fixture', 'fixture-key', 'fixture-print', 'POS-FIXTURE', 'paid', 500, 0, 500, 'GHS', ownerId, 'Owner', '[]', date, date);
    db.prepare('INSERT INTO catalog_cache(id,payload,updated_at) VALUES (1,?,?)').run('{"products":[]}', date);
    db.close();
    const reopened = openDatabase(config);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM demo_stock').get().n, 0);
    assert.equal(reopened.prepare("SELECT id FROM users WHERE role='owner'").get().id, ownerId);
    assert.equal(reopened.prepare('SELECT number FROM sales WHERE id=?').get('real-record-fixture').number, 'POS-FIXTURE');
    assert.equal(reopened.prepare('SELECT payload FROM catalog_cache WHERE id=1').get().payload, '{"products":[]}');
    reopened.close();
  }
});

test('a renamed demo database is refused as a live ledger without deleting its records', t => {
  const dir = tempDir(t);
  const demo = openDatabase(readConfig({ POS_MODE: 'demo', POS_DATA_DIR: dir }));
  const sampleCount = demo.prepare('SELECT COUNT(*) AS n FROM sales').get().n;
  assert.ok(sampleCount > 0);
  demo.close();
  fs.copyFileSync(path.join(dir, 'pos-demo.db'), path.join(dir, 'pos-live.db'));
  const older = new DatabaseSync(path.join(dir, 'pos-live.db'));
  older.prepare('DELETE FROM schema_migrations WHERE version=4').run();
  older.close();
  assert.throws(() => openDatabase(readConfig(envFor('live', dir))), /POS ledger mode does not match/,
    'Reject a different-mode ledger before attempting any migrations.');
  fs.copyFileSync(path.join(dir, 'pos-demo.db'), path.join(dir, 'pos-live.db'));
  const copied = new DatabaseSync(path.join(dir, 'pos-live.db'));
  copied.prepare("DELETE FROM app_meta WHERE key='mode'").run();
  copied.close();
  assert.throws(() => openDatabase(readConfig(envFor('live', dir))), /Demo records found/,
    'Even a legacy demo ledger without a mode marker must be refused before sample-stock cleanup.');
  const refused = new DatabaseSync(path.join(dir, 'pos-live.db'), { readOnly: true });
  assert.equal(refused.prepare('SELECT COUNT(*) AS n FROM sales').get().n, sampleCount);
  assert.ok(refused.prepare('SELECT COUNT(*) AS n FROM demo_stock').get().n > 0);
  refused.close();
  const original = openDatabase(readConfig({ POS_MODE: 'demo', POS_DATA_DIR: dir }));
  assert.equal(original.prepare('SELECT COUNT(*) AS n FROM sales').get().n, sampleCount);
  original.close();
});

test('a live pilot has no demo sign-in API and no sample sales or stock', async t => {
  const dir = tempDir(t);
  const instance = createApp({ env: envFor('live', dir), api: {
    async products() { return { data: [], total: 0, pages: 1 }; },
    async variations() { return { data: [], total: 0, pages: 1 }; },
  }, logger: { info() {}, warn() {}, error() {} } });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); instance.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const demo = await fetch(`${base}/api/auth/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(demo.status, 404);
  assert.equal((await demo.json()).error, 'API endpoint not found.');
  const session = await (await fetch(`${base}/api/session`)).json();
  assert.equal(session.config.mode, 'live');
  assert.equal(session.user, null);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM demo_stock').get().n, 0);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
});

test('live build removes only copied demo images and preserves the application shell', t => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'dist', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'demo', 'sample.jpg'), 'sample');
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(dir, 'dist', 'favicon.svg'), '<svg/>');
  execFileSync(process.execPath, [path.resolve('scripts/prepare-live-build.mjs')], { cwd: dir });
  assert.equal(fs.existsSync(path.join(dir, 'dist', 'demo')), false);
  assert.equal(fs.existsSync(path.join(dir, 'dist', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(dir, 'dist', 'favicon.svg')), true);
  const empty = tempDir(t);
  assert.throws(() => execFileSync(process.execPath, [path.resolve('scripts/prepare-live-build.mjs')], { cwd: empty, stdio: 'pipe' }));
});

test('live production server blocks /demo files even if a regular build left them behind', async t => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'dist', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html><title>Live POS fixture</title>');
  fs.writeFileSync(path.join(dir, 'dist', 'demo', 'sample.jpg'), 'should-not-be-public');
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const free = probe.address().port;
      probe.close(() => resolve(free));
    });
  });
  const child = spawn(process.execPath, [path.resolve('server/index.js')], {
    cwd: dir,
    env: { ...process.env, NODE_ENV: 'production', POS_MODE: 'live', POS_LIVE_READ_ONLY: 'true',
      POS_ALLOW_LIVE_WRITES: 'false', POS_LIVE_WHOLESALE_APPROVED: 'false',
      WOO_BASE_URL: 'https://mansutrendzgh.com', WOO_CONSUMER_KEY: 'ck_mock', WOO_CONSUMER_SECRET: 'cs_mock',
      POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com', POS_DATA_DIR: path.join(dir, 'ledger'),
      POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'private-initial-passphrase-123',
      POS_BIND_HOST: '127.0.0.1', POS_TRUST_PROXY: 'loopback', PORT: String(port) },
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data.toString(); });
  child.stderr.on('data', data => { logs += data.toString(); });
  child.on('error', error => { logs += error.message; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  });
  let listening = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) { listening = true; break; }
    } catch { /* Startup and isolated DB migration can take a moment. */ }
    await delay(100);
  }
  assert.ok(listening, `Fixture server did not start: ${logs}`);
  const hidden = await fetch(`http://127.0.0.1:${port}/demo/sample.jpg`);
  assert.equal(hidden.status, 404);
  const shell = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Live POS fixture/);
});
