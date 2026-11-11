import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { acquireInstanceLease } from '../server/instance-lease.js';

test('restore preserves committed WAL data in the safety backup and rejects mode/schema mismatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-restore-test-'));
  const file = path.join(dir, 'pos-staging.db');
  const snapshot = path.join(dir, 'snapshot.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT);
    INSERT INTO schema_migrations VALUES(3,'2026-11-04');
    CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_meta VALUES('mode','staging');
    CREATE TABLE probe(value TEXT);
    INSERT INTO probe VALUES('baseline');`);
  await backup(db, snapshot);
  db.prepare('INSERT INTO probe VALUES(?)').run('committed-after-backup');
  const env = { ...process.env, POS_MODE: 'staging', POS_DATA_DIR: dir, WOO_BASE_URL: 'https://staging.example.com' };
  const lease = acquireInstanceLease({ mode: 'staging', dataDir: dir });
  const blocked = spawnSync(process.execPath, ['server/restore.js', snapshot, '--confirm-restore'], {
    cwd: path.resolve('.'), env, encoding: 'utf8',
  });
  assert.notEqual(blocked.status, 0, 'restore must refuse a running POS, even across container PID namespaces');
  assert.match(blocked.stderr, /Another POS instance or restore/);
  lease.release();
  assert.deepEqual(db.prepare('SELECT value FROM probe').all().map(r => r.value), ['baseline', 'committed-after-backup']);
  const result = spawnSync(process.execPath, ['server/restore.js', snapshot, '--confirm-restore'], {
    cwd: path.resolve('.'), env, encoding: 'utf8',
  });
  db.close();
  assert.equal(result.status, 0, result.stderr);
  const safety = result.stdout.match(/Existing database preserved at: (.+)/)[1];
  const check = f => { const d = new DatabaseSync(f, { readOnly: true }); const rows = d.prepare('SELECT value FROM probe').all().map(r => r.value); d.close(); return rows; };
  assert.deepEqual(check(file), ['baseline']);
  assert.deepEqual(check(safety), ['baseline', 'committed-after-backup']);

  const wrongMode = path.join(dir, 'wrong-mode.db');
  const wm = new DatabaseSync(wrongMode);
  wm.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO schema_migrations VALUES(3,'2026-11-04'); CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO app_meta VALUES('mode','live');`);
  wm.close();
  const rejected = spawnSync(process.execPath, ['server/restore.js', wrongMode, '--confirm-restore'], {
    cwd: path.resolve('.'),
    env: { ...process.env, POS_MODE: 'staging', POS_DATA_DIR: dir, WOO_BASE_URL: 'https://staging.example.com' },
    encoding: 'utf8',
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not match restore mode/);

  const futureSchema = path.join(dir, 'future-schema.db');
  const fsdb = new DatabaseSync(futureSchema);
  fsdb.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO schema_migrations VALUES(99,'2026-11-04'); CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO app_meta VALUES('mode','staging');`);
  fsdb.close();
  const schemaRejected = spawnSync(process.execPath, ['server/restore.js', futureSchema, '--confirm-restore'], {
    cwd: path.resolve('.'),
    env: { ...process.env, POS_MODE: 'staging', POS_DATA_DIR: dir, WOO_BASE_URL: 'https://staging.example.com' },
    encoding: 'utf8',
  });
  assert.notEqual(schemaRejected.status, 0);
  assert.match(schemaRejected.stderr, /schema 99 is not supported/);
  fs.rmSync(dir, { recursive: true, force: true });
});
