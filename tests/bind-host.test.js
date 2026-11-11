import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
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
  // A listener accidentally bound to 0.0.0.0 would also accept a connection
  // through a non-loopback interface on the same host.
  const address = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
  if (address) {
    await assert.rejects(fetch(`http://${address}:${port}/api/health`, { signal: AbortSignal.timeout(1200) }));
  }
});
