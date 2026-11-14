import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Substitute npm: this exercises only the local retention wrapper, never a
// real POS ledger or remote backup. All files live in an isolated temp folder.
test('generic backup wrapper preserves files by default and prunes only explicit manifested pairs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-phase1-backup-script-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dest = path.join(dir, 'backups');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(dest);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const pair = path.join(dest, 'pos-live-verified.db');
  const legacy = path.join(dest, 'pos-live-legacy.db');
  fs.writeFileSync(pair, 'isolated fixture');
  fs.writeFileSync(`${pair}.manifest.json`, '{}');
  fs.writeFileSync(legacy, 'isolated legacy fixture');
  const old = new Date(Date.now() - 5 * 86400000);
  for (const file of [pair, `${pair}.manifest.json`, legacy]) fs.utimesSync(file, old, old);
  const invoke = retention => spawnSync('bash', ['deploy/backup.sh', dest], {
    cwd: path.resolve('.'), encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RETENTION_DAYS: retention },
  });
  const defaultRun = invoke('');
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  assert.ok(fs.existsSync(pair));
  assert.ok(fs.existsSync(`${pair}.manifest.json`));
  const invalid = invoke('0');
  assert.notEqual(invalid.status, 0);
  assert.ok(fs.existsSync(pair));
  const pruned = invoke('1');
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.equal(fs.existsSync(pair), false);
  assert.equal(fs.existsSync(`${pair}.manifest.json`), false);
  assert.ok(fs.existsSync(legacy), 'Unmanifested historical backup is retained for review.');
});
