import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireInstanceLease } from '../server/instance-lease.js';

test('one instance per ledger mode; releasing the lease allows a restart', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-lease-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { dataDir: dir, mode: 'staging' };
  const first = acquireInstanceLease(config);
  assert.throws(() => acquireInstanceLease(config), /Another POS instance or restore/);
  const live = acquireInstanceLease({ ...config, mode: 'live' });
  live.release();
  first.release();
  first.release();
  const restarted = acquireInstanceLease(config);
  restarted.release();
});

test('a killed process releases the cross-process lease without deleting a PID file', { timeout: 10000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-crash-lease-'));
  const config = { dataDir: dir, mode: 'staging' };
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "import { acquireInstanceLease } from './server/instance-lease.js'; acquireInstanceLease({ mode: 'staging', dataDir: process.env.TEST_LEASE_DIR }); console.log('LOCKED'); setInterval(() => {}, 60000);",
  ], { cwd: path.resolve('.'), env: { ...process.env, TEST_LEASE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGKILL');
      await done;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => chunk.toString().includes('LOCKED') ? resolve() : reject(new Error(`Unexpected child output: ${chunk}`)));
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Lease holder exited early (${code}): ${stderr}`)));
  });
  assert.throws(() => acquireInstanceLease(config), /Another POS instance or restore/);
  const done = once(child, 'exit');
  child.kill('SIGKILL');
  await done;
  const restarted = acquireInstanceLease(config);
  restarted.release();
});
