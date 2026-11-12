import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

test('host-level POS listener can bind only to loopback without exposing another app port', { timeout: 15000 }, async t => {
  const unit = fs.readFileSync('deploy/mansu-pos-staging.service', 'utf8');
  const starts = unit.split('\n').filter(line => /^ExecStart(Pre)?=/.test(line));
  assert.equal(starts.length, 2);
  for (const start of starts) {
    for (const required of ['POS_MODE=staging', 'POS_BIND_HOST=127.0.0.1', 'PORT=3187', 'POS_DATA_DIR=/var/lib/mansu-pos-staging']) {
      assert.ok(start.includes(required), `Staging unit must enforce ${required}: ${start}`);
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-bind-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, NODE_ENV: 'test', POS_MODE: 'demo', POS_DATA_DIR: dir, PORT: String(port), POS_BIND_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGTERM');
      await done;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (logs.includes('"msg":"server.started"')) resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`POS exited before listening (${code}): ${logs}`)));
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'demo');
  // Inspect the kernel listener rather than fetching the sandbox's non-loopback
  // address: its preview proxy can route a request back to a loopback service.
  const listeners = execFileSync('ss', ['-ltnH', `( sport = :${port} )`], { encoding: 'utf8' });
  assert.match(listeners, new RegExp(`\\b127\\.0\\.0\\.1:${port}\\s`));
  assert.doesNotMatch(listeners, new RegExp(`(?:0\\.0\\.0\\.0|\\*):${port}\\s`));
});
