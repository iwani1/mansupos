import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { runRestoreDrill } from '../server/restore-drill.js';

// Everything lives in an isolated temp folder with a demo ledger.
function makeBackup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-restore-drill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { POS_MODE: 'demo', POS_DATA_DIR: dir };
  openDatabase(readConfig(env)).close();
  const backups = path.join(dir, 'backups');
  const run = spawnSync(process.execPath, ['server/backup.js', backups], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(run.status, 0, run.stderr);
  const file = fs.readdirSync(backups).find(name => name.endsWith('.db'));
  return { dir, file: path.join(backups, file) };
}

test('restore drill passes on a verified backup and leaves the original untouched', async t => {
  const { file } = makeBackup(t);
  const before = fs.readFileSync(file);
  const result = await runRestoreDrill(file);
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'demo');
  assert.equal(typeof result.contents.users, 'number');
  assert.equal(result.workDir, null);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('restore drill fails when the manifest is missing or the snapshot was altered', async t => {
  const { dir, file } = makeBackup(t);
  const lonely = path.join(dir, 'copy.db');
  fs.copyFileSync(file, lonely);
  await assert.rejects(runRestoreDrill(lonely), /manifest\.json file is missing/);

  fs.copyFileSync(`${file}.manifest.json`, `${lonely}.manifest.json`);
  const manifest = JSON.parse(fs.readFileSync(`${lonely}.manifest.json`, 'utf8'));
  manifest.sha256 = '0'.repeat(64);
  fs.writeFileSync(`${lonely}.manifest.json`, JSON.stringify(manifest));
  await assert.rejects(runRestoreDrill(lonely), /checksum/);
  await assert.rejects(runRestoreDrill(path.join(dir, 'nope.db')), /not found/);
});

test('restore drill command reports pass/fail with an exit code', t => {
  const { file } = makeBackup(t);
  const ok = spawnSync(process.execPath, ['server/restore-drill.js', file], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /RESTORE DRILL PASSED/);
  const bad = spawnSync(process.execPath, ['server/restore-drill.js'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /RESTORE DRILL FAILED: Usage/);
});
