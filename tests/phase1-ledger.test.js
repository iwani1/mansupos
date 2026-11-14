import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../server/db.js';
import { readConfig } from '../server/config.js';
import { inspectSnapshot, verifyManifest } from '../server/backup-metadata.js';
import { hashPassword, verifyPassword } from '../server/passwords.js';
import { acquireInstanceLease } from '../server/instance-lease.js';
import { createApp } from '../server/app.js';

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-phase1-ledger-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const envFor = (dir, mode = 'live', pilot = true) => ({ NODE_ENV: 'test', POS_MODE: mode,
  POS_LIVE_READ_ONLY: mode === 'live' ? String(pilot) : 'false', POS_DATA_DIR: dir,
  WOO_BASE_URL: mode === 'staging' ? 'https://staging.example.com' : 'https://www.mansutrendzgh.com' });
const run = (script, args, env) => spawnSync(process.execPath, [`server/${script}.js`, ...args], { cwd: path.resolve('.'), env: { ...process.env, ...env }, encoding: 'utf8' });

function newLedger(t, mode = 'live', pilot = true) {
  const dir = temp(t);
  const env = envFor(dir, mode, pilot);
  const db = openDatabase(readConfig(env));
  const info = inspectSnapshot(path.join(dir, `pos-${mode}.db`));
  db.close();
  return { dir, env, info, file: path.join(dir, `pos-${mode}.db`) };
}

// Model a real additive v8->v9 migration by undoing ONLY the v9 objects on a
// freshly created isolated ledger. The v8 history/sales tables are untouched.
function rewindToV8(file) {
  const db = new DatabaseSync(file);
  const triggers = ['audit_no_update','audit_no_delete','sale_events_no_update','sale_events_no_delete',
    'cash_movements_no_update','cash_movements_no_delete','closed_shift_no_cash_insert',
    'closed_shifts_no_update','closed_shifts_no_delete'];
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger}`);
  db.exec(`DROP INDEX idx_sales_one_woo_order; DROP TABLE sale_events;
    DELETE FROM schema_migrations WHERE version=9;
    DELETE FROM app_meta WHERE key IN ('service_identity','ledger_uuid');
    UPDATE app_meta SET value='8' WHERE key='schema_version';`);
  db.close();
}

function insertSale(db, id, key, wooId, extra = {}) {
  const time = new Date().toISOString();
  db.prepare(`INSERT INTO sales(id,idempotency_key,fingerprint,number,woo_order_id,status,total,subtotal,currency,
    cashier_id,cashier_name,created_at,updated_at,items_json,sale_type,buyer_id,shift_id)
    VALUES (?,?,?,?,?,'paid',100,100,'GHS',?,?,?,?,? ,?,?,?)`)
    .run(id, key, 'fingerprint', `WC-${id}`, wooId, extra.cashierId || 'historic-user', 'Historic Cashier', time, time, '[]', extra.saleType || 'retail', extra.buyerId || null, extra.shiftId || null);
}

test('v9 refuses duplicate Woo IDs and orphan shifts before creating constraints; rows and legacy trade are retained', t => {
  const { env, file } = newLedger(t, 'staging');
  rewindToV8(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  const owner = db.prepare("SELECT id FROM users WHERE role='owner'").get();
  // newLedger has no bootstrap owner; this fixture inserts one with no password
  // because only the FK to trade_buyers is exercised, never authentication.
  const user = owner?.id || randomUUID();
  if (!owner) db.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(user, 'fixture', 'Fixture', 'owner', 'fixture-not-a-login', new Date().toISOString());
  const buyerId = randomUUID();
  db.prepare('INSERT INTO trade_buyers(id,name,created_at,created_by) VALUES (?,?,?,?)').run(buyerId, 'Historic buyer fixture', new Date().toISOString(), user);
  insertSale(db, 'historic-trade', randomUUID(), 701, { cashierId: user, saleType: 'trade', buyerId });
  insertSale(db, 'another-sale', randomUUID(), 701, { cashierId: user });
  assert.throws(() => insertSale(db, 'same-key', db.prepare("SELECT idempotency_key FROM sales WHERE id='historic-trade'").get().idempotency_key, 900), /UNIQUE constraint/);
  db.close();
  assert.throws(() => openDatabase(readConfig(env)), /Duplicate Woo order link 701/);
  let review = new DatabaseSync(file);
  assert.equal(review.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 2);
  assert.equal(review.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 8);
  review.prepare("UPDATE sales SET woo_order_id=NULL,shift_id='missing-shift' WHERE id='another-sale'").run();
  review.close();
  assert.throws(() => openDatabase(readConfig(env)), /missing shift/);
  review = new DatabaseSync(file);
  review.prepare('INSERT INTO shifts(id,user_id,user_name,opening_float,note,opened_at) VALUES (?,?,?,?,?,?)')
    .run('missing-shift', user, 'Fixture', 0, '', new Date().toISOString());
  review.close();
  const migrated = openDatabase(readConfig(env));
  assert.equal(migrated.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, SCHEMA_VERSION);
  assert.deepEqual({ ...migrated.prepare("SELECT sale_type,buyer_id,woo_order_id FROM sales WHERE id='historic-trade'").get() },
    { sale_type: 'trade', buyer_id: buyerId, woo_order_id: 701 });
  assert.throws(() => migrated.prepare("UPDATE sales SET woo_order_id=701 WHERE id='another-sale'").run(), /UNIQUE constraint/);
  assert.throws(() => migrated.prepare('INSERT INTO sale_events(sale_id,event,actor_id,created_at) VALUES (?,?,?,?)')
    .run('nonexistent', 'spoofed', user, new Date().toISOString()), /FOREIGN KEY constraint/);
  migrated.close();
});

test('v9 migration rejects orphaned historical foreign keys without deleting the sale', t => {
  const { env, file } = newLedger(t, 'staging');
  rewindToV8(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=OFF');
  insertSale(db, 'orphaned-buyer', randomUUID(), 702, { buyerId: randomUUID(), saleType: 'trade' });
  db.close();
  assert.throws(() => openDatabase(readConfig(env)), /orphan reference in sales/);
  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sales WHERE id='orphaned-buyer'").get().n, 1);
  assert.equal(check.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 8);
  check.close();
});

test('an existing unmarked staging ledger is not silently assigned a service and UUID', t => {
  const staging = newLedger(t, 'staging');
  rewindToV8(staging.file);
  const edited = new DatabaseSync(staging.file);
  edited.prepare("DELETE FROM app_meta WHERE key='mode'").run();
  edited.close();
  assert.throws(() => openDatabase(readConfig(staging.env)), /no recorded mode/);
  const unchanged = inspectSnapshot(staging.file);
  assert.deepEqual([unchanged.version, unchanged.mode, unchanged.service, unchanged.ledgerId], [8, '', '', '']);
});

test('a v9 ledger missing an identity fails startup and preflight without silently assigning a new UUID', t => {
  const pilot = newLedger(t);
  const edited = new DatabaseSync(pilot.file);
  edited.prepare("DELETE FROM app_meta WHERE key='ledger_uuid'").run();
  edited.close();
  assert.throws(() => openDatabase(readConfig(pilot.env)), /v9 is missing its bound mode\/service\/UUID/);
  const failedPreflight = run('preflight', [], pilot.env);
  assert.notEqual(failedPreflight.status, 0);
  assert.match(failedPreflight.stdout, /FAIL {2}POS ledger service identity.*v9 is missing/);
  const unchanged = inspectSnapshot(pilot.file);
  assert.equal(unchanged.version, 9);
  assert.equal(unchanged.ledgerId, '');
  assert.equal(unchanged.service, 'live-pilot');
});

test('preflight flags a partial v3 ledger rather than reporting a healthy service identity', t => {
  const dir = temp(t);
  const db = new DatabaseSync(path.join(dir, 'pos-staging.db'));
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO schema_migrations VALUES (3,'fixture'); CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO app_meta VALUES ('mode','staging');");
  db.close();
  const result = run('preflight', [], envFor(dir, 'staging'));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL {2}POS ledger service identity.*missing sales table/);
});

test('new ledger gets its service identity before a later bootstrap error, and restart retains the UUID', t => {
  const dir = temp(t);
  const env = { ...envFor(dir, 'staging'), POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'weak' };
  assert.throws(() => openDatabase(readConfig(env)), /POS_OWNER_PASSWORD/);
  const before = inspectSnapshot(path.join(dir, 'pos-staging.db'));
  assert.equal(before.service, 'staging');
  assert.equal(before.version, 9);
  assert.ok(before.ledgerId);
  const db = openDatabase(readConfig({ ...env, POS_OWNER_PASSWORD: 'phase-one-fixture-secret-123' }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner'").get().n, 1);
  db.close();
  assert.equal(inspectSnapshot(path.join(dir, 'pos-staging.db')).ledgerId, before.ledgerId);
});

test('live pilot and trading cannot open the same named ledger or restore across service identities', async t => {
  const pilot = newLedger(t);
  assert.equal(pilot.info.service, 'live-pilot');
  assert.ok(pilot.info.ledgerId);
  const trading = envFor(pilot.dir, 'live', false);
  assert.throws(() => openDatabase(readConfig(trading)), /service identity does not match/);
  const backed = run('backup', [path.join(pilot.dir, 'backups')], pilot.env);
  assert.equal(backed.status, 0, backed.stderr);
  const backupFile = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)?.[1];
  assert.ok(backupFile, backed.stdout);
  const manifest = await verifyManifest(backupFile, inspectSnapshot(backupFile));
  assert.equal(manifest.ledgerId, pilot.info.ledgerId);
  assert.equal(manifest.service, 'live-pilot');
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  const replicaDir = temp(t);
  const replica = run('restore', [backupFile, '--confirm-restore'], envFor(replicaDir, 'live', true));
  assert.equal(replica.status, 0, replica.stderr);
  assert.equal(inspectSnapshot(path.join(replicaDir, 'pos-live.db')).ledgerId, pilot.info.ledgerId);
  const wrongDir = temp(t);
  const wrongService = run('restore', [backupFile, '--confirm-restore'], envFor(wrongDir, 'live', false));
  assert.notEqual(wrongService.status, 0);
  assert.match(wrongService.stderr, /service identity does not match/);
  assert.equal(fs.existsSync(path.join(wrongDir, 'pos-live.db')), false);
  const target = newLedger(t); // same role but a different ledger UUID
  const refused = run('restore', [backupFile, '--confirm-restore'], target.env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Destination ledger identity does not match/);
  assert.equal(inspectSnapshot(target.file).ledgerId, target.info.ledgerId);
  const missing = path.join(pilot.dir, 'without-manifest.db');
  fs.copyFileSync(backupFile, missing);
  assert.match(run('restore', [missing, '--confirm-restore'], pilot.env).stderr, /manifest is missing/);
  const altered = path.join(pilot.dir, 'altered.db');
  fs.copyFileSync(backupFile, altered);
  fs.copyFileSync(`${backupFile}.manifest.json`, `${altered}.manifest.json`);
  const tamper = new DatabaseSync(altered);
  tamper.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run('probe', 'changed after checksum');
  tamper.close();
  assert.match(run('restore', [altered, '--confirm-restore'], pilot.env).stderr, /checksum, or ledger identity does not match/);
  const falseCounts = path.join(pilot.dir, 'false-counts.db');
  fs.copyFileSync(backupFile, falseCounts);
  const fabricated = JSON.parse(fs.readFileSync(`${backupFile}.manifest.json`, 'utf8'));
  fabricated.counts.sales += 1;
  fs.writeFileSync(`${falseCounts}.manifest.json`, JSON.stringify(fabricated));
  assert.match(run('restore', [falseCounts, '--confirm-restore'], pilot.env).stderr, /checksum, or ledger identity does not match/);
  assert.equal(inspectSnapshot(pilot.file).ledgerId, pilot.info.ledgerId);
});

test('a complete historical v8 staging backup restores in isolation and upgrades without losing trade or buyer rows', t => {
  const staging = newLedger(t, 'staging');
  rewindToV8(staging.file);
  const legacy = new DatabaseSync(staging.file);
  legacy.exec('PRAGMA foreign_keys=ON');
  const userId = randomUUID(), buyerId = randomUUID();
  legacy.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, 'fixture', 'Fixture', 'owner', 'not-a-login', new Date().toISOString());
  legacy.prepare('INSERT INTO trade_buyers(id,name,created_at,created_by) VALUES (?,?,?,?)')
    .run(buyerId, 'Historic buyer', new Date().toISOString(), userId);
  insertSale(legacy, 'historic-trade', randomUUID(), 905, { cashierId: userId, saleType: 'trade', buyerId });
  legacy.close();
  const backed = run('backup', [path.join(staging.dir, 'v8-backups')], staging.env);
  assert.equal(backed.status, 0, backed.stderr);
  const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)?.[1];
  const target = temp(t), targetEnv = envFor(target, 'staging');
  const restored = run('restore', [snapshot, '--confirm-restore'], targetEnv);
  assert.equal(restored.status, 0, restored.stderr);
  const raw = inspectSnapshot(path.join(target, 'pos-staging.db'));
  assert.equal(raw.version, 8);
  assert.equal(raw.counts.sales, 1);
  assert.throws(() => openDatabase(readConfig(targetEnv)), /Restored POS accounts are locked/,
    'Even an older-schema restore needs explicit owner recovery before migration or sign-in.');
  const privateFile = path.join(temp(t), 'v8-owner-password');
  fs.writeFileSync(privateFile, 'new-v8-owner-secret-123\n', { mode: 0o600 });
  const recovered = run('recover-restored-owner', ['--confirm-restored-owner', 'fixture', privateFile], targetEnv);
  assert.equal(recovered.status, 0, recovered.stderr);
  const upgraded = openDatabase(readConfig(targetEnv));
  assert.equal(upgraded.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 9);
  assert.deepEqual({ ...upgraded.prepare("SELECT sale_type,buyer_id,woo_order_id FROM sales WHERE id='historic-trade'").get() },
    { sale_type: 'trade', buyer_id: buyerId, woo_order_id: 905 });
  assert.equal(upgraded.prepare('SELECT name FROM trade_buyers WHERE id=?').get(buyerId).name, 'Historic buyer');
  assert.ok(upgraded.prepare("SELECT value FROM app_meta WHERE key='ledger_uuid'").get().value);
  upgraded.close();
});

test('pre-mode v2 backup is refused before replacing a bound ledger', t => {
  const pilot = newLedger(t);
  const backupFile = path.join(temp(t), 'legacy-v2.db');
  const old = new DatabaseSync(backupFile);
  old.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (2,'fixture');");
  old.close();
  const refused = run('restore', [backupFile, '--confirm-restore'], pilot.env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Backup schema 2 is not supported/);
  assert.equal(inspectSnapshot(pilot.file).ledgerId, pilot.info.ledgerId);
  assert.equal(fs.readdirSync(pilot.dir).some(name => name.includes('before-restore')), false);
});

test('verified same-ledger restore preserves later committed changes in a safety copy with its own manifest', async t => {
  const pilot = newLedger(t);
  const backed = run('backup', [path.join(pilot.dir, 'backups')], pilot.env);
  assert.equal(backed.status, 0, backed.stderr);
  const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)[1];
  const active = new DatabaseSync(pilot.file);
  active.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  active.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run('probe', 'committed-after-backup');
  active.close();
  const result = run('restore', [snapshot, '--confirm-restore'], pilot.env);
  assert.equal(result.status, 0, result.stderr);
  const safety = result.stdout.match(/Existing database preserved at: (.+\.db)/)[1];
  const restored = new DatabaseSync(pilot.file, { readOnly: true });
  assert.equal(restored.prepare("SELECT value FROM app_meta WHERE key='probe'").get(), undefined);
  restored.close();
  const kept = new DatabaseSync(safety, { readOnly: true });
  assert.equal(kept.prepare("SELECT value FROM app_meta WHERE key='probe'").get().value, 'committed-after-backup');
  kept.close();
  assert.equal((await verifyManifest(safety, inspectSnapshot(safety))).ledgerId, pilot.info.ledgerId);
  // The active ledger now has a newer restore audit event. Do not roll that
  // history back just to test the safety image: drill it in a fresh replica.
  const replicaDir = temp(t);
  const drill = run('restore', [safety, '--confirm-restore'], envFor(replicaDir));
  assert.equal(drill.status, 0, drill.stderr);
  const original = new DatabaseSync(path.join(replicaDir, 'pos-live.db'), { readOnly: true });
  assert.equal(original.prepare("SELECT value FROM app_meta WHERE key='probe'").get().value, 'committed-after-backup');
  original.close();
});

test('restore refuses to roll back newer sales or later refund observations in the active ledger', t => {
  const staging = newLedger(t, 'staging');
  const active = new DatabaseSync(staging.file);
  insertSale(active, 'original-sale', randomUUID(), 811);
  active.close();
  const backed = run('backup', [path.join(staging.dir, 'backups')], staging.env);
  assert.equal(backed.status, 0, backed.stderr);
  const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)?.[1];
  assert.ok(snapshot);
  const later = new DatabaseSync(staging.file);
  insertSale(later, 'later-paid-sale', randomUUID(), 812);
  later.prepare("UPDATE sales SET paid_at=? WHERE id='later-paid-sale'").run(new Date().toISOString());
  later.close();
  const missingSale = run('restore', [snapshot, '--confirm-restore'], staging.env);
  assert.notEqual(missingSale.status, 0, 'A confirmed later receipt must not disappear from the active ledger.');
  assert.match(missingSale.stderr, /Active POS sales.*backup/i);
  const retained = new DatabaseSync(staging.file);
  assert.equal(retained.prepare("SELECT COUNT(*) AS n FROM sales WHERE id='later-paid-sale'").get().n, 1);
  retained.prepare("DELETE FROM sales WHERE id='later-paid-sale'").run();
  retained.prepare("UPDATE sales SET status='partially_refunded',refunded=2000,updated_at=? WHERE id='original-sale'").run(new Date().toISOString());
  retained.close();
  const laterRefund = run('restore', [snapshot, '--confirm-restore'], staging.env);
  assert.notEqual(laterRefund.status, 0, 'A newer refund observation must not disappear from the active receipt.');
  assert.match(laterRefund.stderr, /Active POS sales.*backup/i);
  const check = new DatabaseSync(staging.file, { readOnly: true });
  assert.equal(check.prepare("SELECT refunded FROM sales WHERE id='original-sale'").get().refunded, 2000);
  check.close();
});

test('restore refuses to erase a newer Woo create intent even when the sale row is unchanged', t => {
  const staging = newLedger(t, 'staging');
  const active = new DatabaseSync(staging.file);
  insertSale(active, 'unfinished-sale', randomUUID(), null);
  active.prepare("UPDATE sales SET status='creating' WHERE id='unfinished-sale'").run();
  active.close();
  const backed = run('backup', [path.join(staging.dir, 'backups')], staging.env);
  assert.equal(backed.status, 0, backed.stderr);
  const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)?.[1];
  assert.ok(snapshot);
  const later = new DatabaseSync(staging.file);
  later.prepare('INSERT INTO sale_events(sale_id,event,actor_id,created_at) VALUES (?,?,?,?)')
    .run('unfinished-sale', 'woo.create_started', 'fixture', new Date().toISOString());
  later.close();
  const refused = run('restore', [snapshot, '--confirm-restore'], staging.env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Active POS sale_events.*backup/);
  const check = new DatabaseSync(staging.file, { readOnly: true });
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sale_events WHERE sale_id='unfinished-sale'").get().n, 1);
  check.close();
});

test('isolated restore invalidates backed-up login sessions before publishing the ledger', t => {
  const pilot = newLedger(t);
  const active = new DatabaseSync(pilot.file);
  const userId = randomUUID();
  active.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, 'fixture', 'Fixture', 'owner', 'fixture-not-a-login', new Date().toISOString());
  active.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)')
    .run('e'.repeat(64), userId, Date.now() + 3600000);
  active.close();
  const backed = run('backup', [path.join(pilot.dir, 'backups')], pilot.env);
  assert.equal(backed.status, 0, backed.stderr);
  const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)?.[1];
  const replicaDir = temp(t);
  const restored = run('restore', [snapshot, '--confirm-restore'], envFor(replicaDir));
  assert.equal(restored.status, 0, restored.stderr);
  const check = new DatabaseSync(path.join(replicaDir, 'pos-live.db'), { readOnly: true });
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.ok(check.prepare("SELECT id FROM audit WHERE action='ledger.restored'").get());
  check.close();
  const saved = new DatabaseSync(snapshot, { readOnly: true });
  assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'The verified source remains unchanged.');
  saved.close();
});

test('same-ledger restore refuses to resurrect an account deleted after the verified backup', t => {
  const staging = newLedger(t, 'staging');
  const userId = randomUUID();
  const active = new DatabaseSync(staging.file);
  active.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, 'deleted.cashier', 'Deleted fixture cashier', 'cashier', hashPassword('deleted-fixture-secret-123'), new Date().toISOString());
  active.close();
  const backed = run('backup', [path.join(staging.dir, 'backups')], staging.env);
  assert.equal(backed.status, 0, backed.stderr);
  const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)?.[1];
  const changed = new DatabaseSync(staging.file);
  assert.equal(changed.prepare('DELETE FROM users WHERE id=?').run(userId).changes, 1);
  changed.close();
  const refused = run('restore', [snapshot, '--confirm-restore'], staging.env);
  assert.notEqual(refused.status, 0, 'A deleted account must not silently regain access from an old backup.');
  assert.match(refused.stderr, /Active POS users.*(deleted|missing).*backup/i);
  const retained = new DatabaseSync(staging.file, { readOnly: true });
  assert.equal(retained.prepare('SELECT COUNT(*) AS n FROM users WHERE id=?').get(userId).n, 0);
  retained.close();
  assert.equal(fs.readdirSync(staging.dir).some(name => name.includes('before-restore')), false,
    'Refusal must precede any replacement or safety-snapshot publication.');
});

test('same-ledger restore also refuses resurrected paid receipts and already revoked credentials', t => {
  for (const mutation of ['deleted-sale', 'disabled-account', 'rotated-password']) {
    const staging = newLedger(t, 'staging');
    const userId = randomUUID();
    const active = new DatabaseSync(staging.file);
    active.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
      .run(userId, 'cashier.fixture', 'Fixture Cashier', 'cashier', hashPassword('cashier-original-secret-123'), new Date().toISOString());
    insertSale(active, 'original-sale', randomUUID(), 909, { cashierId: userId });
    active.close();
    const backed = run('backup', [path.join(staging.dir, 'backups')], staging.env);
    assert.equal(backed.status, 0, backed.stderr);
    const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)?.[1];
    const edited = new DatabaseSync(staging.file);
    if (mutation === 'deleted-sale') edited.prepare("DELETE FROM sales WHERE id='original-sale'").run();
    if (mutation === 'disabled-account') edited.prepare('UPDATE users SET active=0 WHERE id=?').run(userId);
    if (mutation === 'rotated-password') edited.prepare('UPDATE users SET password_hash=? WHERE id=?')
      .run(hashPassword('cashier-rotated-secret-123'), userId);
    edited.close();
    const refused = run('restore', [snapshot, '--confirm-restore'], staging.env);
    assert.notEqual(refused.status, 0, `${mutation}: never silently discard a current revocation or resurrect a receipt.`);
    assert.match(refused.stderr, /Active POS (users|sales).*backup/i);
    const check = new DatabaseSync(staging.file, { readOnly: true });
    if (mutation === 'deleted-sale') assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sales WHERE id='original-sale'").get().n, 0);
    if (mutation === 'disabled-account') assert.equal(check.prepare('SELECT active FROM users WHERE id=?').get(userId).active, 0);
    if (mutation === 'rotated-password') assert.equal(verifyPassword('cashier-rotated-secret-123',
      check.prepare('SELECT password_hash FROM users WHERE id=?').get(userId).password_hash), true);
    check.close();
  }
});

test('fresh restore quarantines every backed-up account until an offline owner recovery with a new secret', async t => {
  const staging = newLedger(t, 'staging');
  const ownerId = randomUUID(), cashierId = randomUUID();
  const oldOwnerPassword = 'previous-owner-fixture-secret-123';
  const oldCashierPassword = 'previous-cashier-fixture-secret-123';
  const active = new DatabaseSync(staging.file);
  active.exec('PRAGMA foreign_keys=ON');
  const addUser = active.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)');
  addUser.run(ownerId, 'owner.fixture', 'Fixture Owner', 'owner', hashPassword(oldOwnerPassword), new Date().toISOString());
  addUser.run(cashierId, 'cashier.fixture', 'Fixture Cashier', 'cashier', hashPassword(oldCashierPassword), new Date().toISOString());
  active.prepare('INSERT INTO shifts(id,user_id,user_name,status,opening_float,expected_cash,note,opened_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('historic-shift', cashierId, 'Fixture Cashier', 'open', 1000, 11000, '', new Date().toISOString());
  insertSale(active, 'historic-sale', randomUUID(), 909, { cashierId, shiftId: 'historic-shift' });
  active.prepare('INSERT INTO audit(actor,action,subject,created_at) VALUES (?,?,?,?)')
    .run(cashierId, 'sale.paid', 'historic-sale', new Date().toISOString());
  active.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)')
    .run('e'.repeat(64), ownerId, Date.now() + 3600000);
  active.close();
  const backed = run('backup', [path.join(staging.dir, 'backups')], staging.env);
  assert.equal(backed.status, 0, backed.stderr);
  const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)?.[1];
  const target = temp(t), targetEnv = envFor(target, 'staging');
  const restored = run('restore', [snapshot, '--confirm-restore'], targetEnv);
  assert.equal(restored.status, 0, restored.stderr);
  const targetFile = path.join(target, 'pos-staging.db');
  const locked = new DatabaseSync(targetFile, { readOnly: true });
  const accounts = locked.prepare('SELECT id,active,password_hash,must_change_password FROM users ORDER BY id').all();
  assert.equal(accounts.length, 2, 'Keep both historical identities and their business references.');
  assert.ok(accounts.every(row => row.active === 0 && row.must_change_password === 1));
  assert.equal(verifyPassword(oldOwnerPassword, accounts.find(row => row.id === ownerId).password_hash), false);
  assert.equal(verifyPassword(oldCashierPassword, accounts.find(row => row.id === cashierId).password_hash), false);
  assert.equal(locked.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(locked.prepare("SELECT value FROM app_meta WHERE key='restored_accounts_locked'").get().value, '1');
  assert.equal(locked.prepare("SELECT COUNT(*) AS n FROM sales WHERE id='historic-sale'").get().n, 1);
  assert.equal(locked.prepare("SELECT expected_cash FROM shifts WHERE id='historic-shift'").get().expected_cash, 11000);
  assert.equal(locked.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='sale.paid'").get().n, 1);
  assert.equal(locked.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='ledger.restored'").get().n, 1);
  locked.close();
  assert.throws(() => openDatabase(readConfig({ ...targetEnv, POS_OWNER_USERNAME: 'owner.fixture', POS_OWNER_PASSWORD: oldOwnerPassword })),
    /restored.*accounts.*locked/i, 'Restart must not rebootstrap a backed-up owner or accept an old password.');
  const preflight = run('preflight', [], {
    ...targetEnv, POS_OWNER_USERNAME: 'owner.fixture', POS_OWNER_PASSWORD: oldOwnerPassword,
  });
  assert.notEqual(preflight.status, 0);
  assert.match(preflight.stdout, /FAIL {2}Restored account recovery/);
  assert.match(preflight.stdout, /FAIL {2}Owner sign-in available.*restore lock/i,
    'Valid-looking bootstrap credentials must not make a locked restore ready.');

  const secretsDir = temp(t);
  const passwordFile = path.join(secretsDir, 'owner-password');
  const newPassword = 'fresh-offline-owner-fixture-123';
  fs.writeFileSync(passwordFile, `${newPassword}\n`, { mode: 0o644 });
  const args = ['--confirm-restored-owner', 'owner.fixture', passwordFile];
  const insecure = run('recover-restored-owner', args, targetEnv);
  assert.notEqual(insecure.status, 0, 'The recovery secret must not be world-readable.');
  fs.chmodSync(passwordFile, 0o600);
  const wrongOwner = run('recover-restored-owner', ['--confirm-restored-owner', 'cashier.fixture', passwordFile], targetEnv);
  assert.notEqual(wrongOwner.status, 0, 'Only an existing owner can be explicitly recovered.');
  const incomplete = new DatabaseSync(targetFile);
  incomplete.prepare('UPDATE users SET active=1 WHERE id=?').run(cashierId);
  incomplete.close();
  const tampered = run('recover-restored-owner', args, targetEnv);
  assert.notEqual(tampered.status, 0, 'A partially reactivated restore is not a valid owner-recovery target.');
  assert.match(tampered.stderr, /lock is missing or incomplete/i);
  const reset = new DatabaseSync(targetFile);
  reset.prepare('UPDATE users SET active=0 WHERE id=?').run(cashierId);
  reset.close();
  const symlink = path.join(secretsDir, 'password-alias');
  fs.symlinkSync(passwordFile, symlink);
  const alias = run('recover-restored-owner', ['--confirm-restored-owner', 'owner.fixture', symlink], targetEnv);
  assert.notEqual(alias.status, 0, 'Do not accept a symlink to the password file.');
  const lease = acquireInstanceLease({ mode: 'staging', dataDir: target });
  try {
    const running = run('recover-restored-owner', args, targetEnv);
    assert.notEqual(running.status, 0, 'An offline recovery cannot run beside the POS service.');
    assert.match(running.stderr, /Another POS instance or restore/);
  } finally { lease.release(); }
  const recovered = run('recover-restored-owner', args, targetEnv);
  assert.equal(recovered.status, 0, recovered.stderr);
  const again = run('recover-restored-owner', args, targetEnv);
  assert.notEqual(again.status, 0, 'A completed owner recovery must not be replayed.');
  const reopened = openDatabase(readConfig(targetEnv));
  const owner = reopened.prepare('SELECT active,password_hash,must_change_password FROM users WHERE id=?').get(ownerId);
  const cashier = reopened.prepare('SELECT active,password_hash,must_change_password FROM users WHERE id=?').get(cashierId);
  assert.deepEqual([owner.active, owner.must_change_password], [1, 1]);
  assert.equal(verifyPassword(newPassword, owner.password_hash), true);
  assert.equal(verifyPassword(oldOwnerPassword, owner.password_hash), false);
  assert.equal(cashier.active, 0);
  assert.equal(verifyPassword(oldCashierPassword, cashier.password_hash), false);
  assert.equal(reopened.prepare("SELECT value FROM app_meta WHERE key='restored_accounts_locked'").get(), undefined);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='ledger.owner_recovered'").get().n, 1);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM sales WHERE id='historic-sale'").get().n, 1);
  reopened.close();
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  const instance = createApp({ env: targetEnv, api: {}, logger }); // No real Woo client or network request.
  const server = instance.app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const request = async (route, { method = 'GET', token, body } = {}) => {
      const response = await fetch(`${base}${route}`, { method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    const login = (username, password) => request('/auth/login', { method: 'POST', body: { username, password } });
    assert.equal((await login('owner.fixture', oldOwnerPassword)).status, 401);
    assert.equal((await login('cashier.fixture', oldCashierPassword)).status, 401);
    const fresh = await login('owner.fixture', newPassword);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.data.user.mustChangePassword, true);
    assert.equal((await request('/staff', { token: fresh.data.token })).status, 403,
      'The recovered owner must rotate the temporary password before administering staff.');
    const rotated = await request('/auth/password', { method: 'POST', token: fresh.data.token,
      body: { currentPassword: newPassword, newPassword: 'accepted-rotation-fixture-123' } });
    assert.equal(rotated.status, 200);
    const renewedCashierPassword = 'renewed-cashier-fixture-secret-123';
    assert.equal((await request(`/staff/${cashierId}/password`, { method: 'POST', token: fresh.data.token,
      body: { newPassword: renewedCashierPassword } })).status, 200);
    assert.equal((await request(`/staff/${cashierId}/status`, { method: 'POST', token: fresh.data.token,
      body: { active: true } })).status, 200);
    assert.equal((await login('cashier.fixture', oldCashierPassword)).status, 401,
      'Even explicit later activation must not revive a pre-restore password.');
    assert.equal((await login('cashier.fixture', renewedCashierPassword)).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    instance.db.close();
  }
});

test('permitted same-ledger restore keeps a verified safety image but still locks old logins', async t => {
  const staging = newLedger(t, 'staging');
  const userId = randomUUID();
  const originalPassword = 'old-owner-backup-fixture-secret-123';
  const db = new DatabaseSync(staging.file);
  db.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, 'same.owner', 'Same owner', 'owner', hashPassword(originalPassword), new Date().toISOString());
  db.close();
  const backed = run('backup', [path.join(staging.dir, 'backups')], staging.env);
  assert.equal(backed.status, 0, backed.stderr);
  const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)?.[1];
  const withSession = new DatabaseSync(staging.file);
  withSession.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)')
    .run('a'.repeat(64), userId, Date.now() + 3600000);
  withSession.close();
  const restored = run('restore', [snapshot, '--confirm-restore'], staging.env);
  assert.equal(restored.status, 0, restored.stderr);
  const safety = restored.stdout.match(/Existing database preserved at: (.+\.db)/)?.[1];
  assert.ok(safety);
  assert.equal((await verifyManifest(safety, inspectSnapshot(safety))).ledgerId, staging.info.ledgerId);
  const before = new DatabaseSync(safety, { readOnly: true });
  assert.equal(before.prepare('SELECT active FROM users WHERE id=?').get(userId).active, 1);
  assert.equal(before.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  before.close();
  const after = new DatabaseSync(staging.file, { readOnly: true });
  const account = after.prepare('SELECT active,password_hash FROM users WHERE id=?').get(userId);
  assert.equal(account.active, 0);
  assert.equal(verifyPassword(originalPassword, account.password_hash), false);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(after.prepare("SELECT value FROM app_meta WHERE key='restored_accounts_locked'").get().value, '1');
  after.close();
  assert.throws(() => openDatabase(readConfig(staging.env)), /Restored POS accounts are locked/);
});

test('a disposable demo restore revokes sessions but does not quarantine sample-only demo sign-in', t => {
  const demo = newLedger(t, 'demo');
  const backed = run('backup', [path.join(demo.dir, 'backups')], demo.env);
  assert.equal(backed.status, 0, backed.stderr);
  const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)?.[1];
  const replica = temp(t), env = envFor(replica, 'demo');
  const restored = run('restore', [snapshot, '--confirm-restore'], env);
  assert.equal(restored.status, 0, restored.stderr);
  const check = new DatabaseSync(path.join(replica, 'pos-demo.db'), { readOnly: true });
  assert.equal(check.prepare("SELECT active FROM users WHERE id='demo-owner'").get().active, 1);
  assert.equal(check.prepare("SELECT value FROM app_meta WHERE key='restored_accounts_locked'").get(), undefined);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  check.close();
  const reopened = openDatabase(readConfig(env));
  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM sales WHERE id LIKE 'demo-seed-%'").get().n, 6);
  reopened.close();
});

test('preflight and restore reject incomplete v9 journals, columns and constraints despite a matching manifest', t => {
  for (const [name, damage] of [
    ['missing-events', 'DROP TABLE sale_events'],
    ['partial-sales', 'ALTER TABLE sales DROP COLUMN note'],
    ['partial-users', 'ALTER TABLE users DROP COLUMN password_hash'],
    ['missing-woo-unique', 'DROP INDEX idx_sales_one_woo_order'],
    ['missing-audit-trigger', 'DROP TRIGGER audit_no_delete'],
  ]) {
    const pilot = newLedger(t);
    const edited = new DatabaseSync(pilot.file);
    edited.exec(damage);
    edited.close();
    const preflight = run('preflight', [], pilot.env);
    assert.notEqual(preflight.status, 0);
    assert.match(preflight.stdout, /FAIL {2}POS ledger service identity.*missing required/);
    // Produce an authentic matching manifest with the backup tool, rather than
    // relying on a mismatch from copying/editing SQLite pages after backup.
    const backed = run('backup', [path.join(pilot.dir, `${name}-backups`)], pilot.env);
    assert.equal(backed.status, 0, backed.stderr);
    const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)?.[1];
    assert.ok(snapshot);
    const target = temp(t);
    const refused = run('restore', [snapshot, '--confirm-restore'], envFor(target));
    assert.notEqual(refused.status, 0, `${name} must not create a partial restored ledger.`);
    assert.match(refused.stderr, /missing required (?:table|sales column|users column|unique Woo order link|trigger:)/i);
    assert.equal(fs.existsSync(path.join(target, 'pos-live.db')), false);
  }
});

test('legacy live ledger needs explicit binding against an unchanged verified backup before migration', t => {
  const pilot = newLedger(t);
  rewindToV8(pilot.file);
  assert.throws(() => openDatabase(readConfig(pilot.env)), /no bound pilot\/trading identity/);
  const backed = run('backup', [path.join(pilot.dir, 'legacy-backups')], pilot.env);
  assert.equal(backed.status, 0, backed.stderr);
  assert.match(backed.stdout, /LEGACY LIVE BACKUP IS UNBOUND/);
  const snapshot = backed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)[1];
  assert.notEqual(run('restore', [snapshot, '--confirm-restore'], pilot.env).status, 0);
  const wrongDesignation = run('bind-legacy-ledger', ['--bind', 'live-trading', snapshot], pilot.env);
  assert.notEqual(wrongDesignation.status, 0);
  assert.match(wrongDesignation.stderr, /reviewed LIVE service configuration/);
  const changed = new DatabaseSync(pilot.file);
  changed.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run('review_probe', 'changed after prior backup');
  changed.close();
  const stale = run('bind-legacy-ledger', ['--bind', 'live-pilot', snapshot], pilot.env);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /changed since its verified backup/);
  assert.equal(inspectSnapshot(pilot.file).ledgerId, '');
  const refreshed = run('backup', [path.join(pilot.dir, 'fresh-legacy-backups')], pilot.env);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const currentSnapshot = refreshed.stdout.match(/Verified POS ledger backup and manifest: (.+\.db)/)[1];
  const bound = run('bind-legacy-ledger', ['--bind', 'live-pilot', currentSnapshot], pilot.env);
  assert.equal(bound.status, 0, bound.stderr);
  assert.match(bound.stdout, /Bound reviewed legacy live-pilot ledger/);
  const upgraded = openDatabase(readConfig(pilot.env));
  assert.equal(upgraded.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 9);
  assert.equal(upgraded.prepare("SELECT value FROM app_meta WHERE key='service_identity'").get().value, 'live-pilot');
  assert.ok(upgraded.prepare("SELECT id FROM audit WHERE action='ledger.identity_bound'").get());
  upgraded.close();
});
