/**
 * CI only: real Woo/Paystack HTTP vs POS cash last-unit payment race,
 * advisory MySQL lock timeout, and same-reference safe webhook retry.
 * Local WordPress/MySQL only; real Paystack HTTP is blocked by the MU fixture.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

const wp = process.env.MANSU_CI_WP_PATH;
const cli = process.env.MANSU_CI_WP_CLI;
const fixture = path.resolve('tests/woocommerce-cross-channel-payment-fixture.php');
const secret = 'sk_test_synthetic_ci_no_real_account';
assert.equal(process.env.CI, 'true', 'CI-only cross-channel test');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub CI only');
assert.ok(wp?.endsWith('/mansu-disposable-wordpress') &&
  cli?.endsWith('/wp-cli.phar') && fs.existsSync(path.join(wp, 'wp-config.php')) &&
  fs.existsSync(cli) && fs.existsSync(fixture), 'Disposable WP fixtures not found');

function cmd(stage) {
  return ['php', [cli, 'eval-file', fixture, '--path=' + wp, '--skip-themes'],
    { ...process.env, MANSU_CI_CROSS_PHASE: stage }];
}
function outputStage(stage) {
  const [binary, args, env] = cmd(stage);
  const p = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 95000 });
  if (p.status !== 0) {
    throw new Error('Synthetic ' + stage + ' failed: ' +
      (p.stderr || '').slice(0, 1200) + ' ' + (p.stdout || '').slice(-900));
  }
  process.stdout.write(p.stdout);
  return p.stdout;
}
function asyncStage(stage) {
  const [binary, args, env] = cmd(stage);
  const p = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [p.stdout, p.stderr])
    stream.on('data', d => { log = (log + d.toString()).slice(-4000); });
  const completed = new Promise((resolve, reject) => {
    p.once('error', reject);
    p.once('close', code => code === 0 ? resolve(log) :
      reject(new Error('Synthetic ' + stage + ' exit ' + code + ': ' + log)));
  });
  void completed.catch(() => {});
  return { process: p, completed };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = spawn('php', ['-S', '127.0.0.1:8093', '-t', wp],
  { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
server.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-4000); });
function send(method, endpoint, body, signature) {
  return new Promise((resolve, reject) => {
    const headers = { Connection: 'close' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (signature !== undefined) headers['x-paystack-signature'] = signature;
    const req = http.request({
      hostname: '127.0.0.1', port: 8093, method, path: endpoint, headers,
      timeout: 65000,
    }, response => {
      const chunks = [];
      response.on('data', x => chunks.push(x));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Synthetic CI HTTP timeout')));
    req.end(body);
  });
}
async function webhook(ref, expected) {
  const payload = JSON.stringify({ event: 'charge.success', data: { reference: ref } });
  const sig = createHmac('sha512', secret).update(payload).digest('hex');
  const resp = await send('POST', '/?wc-api=tbz_wc_paystack_webhook', payload, sig);
  assert.equal(resp.status, expected, 'Expected synthetic webhook ' + expected +
    ', got ' + resp.status + ': ' + resp.body.slice(-250) + ' ' + stderr.slice(-450));
}
async function untilFile(filename, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filename)) return;
    if (child?.process.exitCode !== null) break;
    await sleep(50);
  }
  throw new Error('Synthetic advisory lock holder did not signal readiness.');
}
let holder;
try {
  let started = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await send('GET', '/');
      if (res.status < 500) { started = true; break; }
    } catch {}
    await sleep(200);
  }
  assert.ok(started, 'Disposable cross-channel WordPress server not ready: ' + stderr);
  const crossSetup = outputStage('cross-setup');
  const cross = JSON.parse(crossSetup.match(/^DISPOSABLE_CROSS_SETUP (.+)$/m)?.[1] || 'null');
  assert.ok(cross?.websiteId && cross?.posId && cross?.ref, 'No cross-channel fixture');
  const pos = asyncStage('cross-pos-pay');
  try {
    const [cashLog] = await Promise.all([
      pos.completed,
      webhook(cross.ref, 200),
    ]);
    process.stdout.write(cashLog);
  } finally {
    if (pos.process.exitCode === null) pos.process.kill('SIGTERM');
  }
  outputStage('cross-verify');

  const lockSetup = outputStage('lock-setup');
  const lock = JSON.parse(lockSetup.match(/^DISPOSABLE_LOCK_SETUP (.+)$/m)?.[1] || 'null');
  assert.ok(lock?.id && lock?.ref, 'Missing lock timeout fixture');
  const directory = path.join(wp, 'wp-content', 'mansu-ci-paystack-lock');
  holder = asyncStage('lock-hold');
  try {
    await untilFile(path.join(directory, 'held'), holder);
    await webhook(lock.ref, 503);
    outputStage('lock-timeout-verify');
  } finally {
    fs.writeFileSync(path.join(directory, 'release'), 'release', { flag: 'wx' });
    process.stdout.write(await holder.completed);
  }
  holder = undefined;
  await webhook(lock.ref, 200);
  outputStage('lock-recovered-verify');
  console.log('DISPOSABLE_CROSS_CHANNEL_AND_LOCK_RECOVERY_OK: same-item POS vs Paystack' +
    ' race and MySQL lock timeout/retry; no real Paystack or live website.');
} finally {
  if (holder?.process.exitCode === null) holder.process.kill('SIGTERM');
  server.kill('SIGTERM');
}
