/**
 * Disposable HTTP-level Paystack gateway callback conformance.
 * Runs ONLY against local PHP built-in server and isolated WordPress fixture.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const wp = process.env.MANSU_CI_WP_PATH;
const cli = process.env.MANSU_CI_WP_CLI;
const fixture = resolve('tests/woocommerce-real-paystack-http-fixture.php');
const syntheticSecret = 'sk_test_synthetic_ci_no_real_account';
assert.equal(process.env.CI, 'true', 'This is a CI-only test');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub CI must be verified');
assert.ok(wp?.endsWith('/mansu-disposable-wordpress') && cli?.endsWith('/wp-cli.phar'),
  'Only isolated synthetic WordPress and WP-CLI paths are allowed');

function wpCli(phase) {
  const p = spawnSync('php', [cli, 'eval-file', fixture, '--path=' + wp, '--skip-themes'], {
    env: { ...process.env, MANSU_CI_PAYSTACK_HTTP_PHASE: phase },
    encoding: 'utf8',
    timeout: 90_000,
  });
  if (p.status !== 0) {
    throw new Error('Paystack synthetic WP-CLI ' + phase + ' failed: ' +
      (p.stderr || '').slice(-2200) + ' ' + (p.stdout || '').slice(-1000));
  }
  return p.stdout;
}
const setup = wpCli('setup');
const match = setup.match(/^DISPOSABLE_PAYSTACK_HTTP_SETUP (.+)$/m);
assert.ok(match, 'Fixture setup did not return synthetic orders');
const cases = JSON.parse(match[1]);
const server = spawn('php', ['-S', '127.0.0.1:8091', '-t', wp], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErrors = '';
server.stderr.on('data', d => { serverErrors = (serverErrors + d.toString()).slice(-5000); });
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function call(method, endpoint, body = undefined, signature = undefined) {
  // Use an explicit loopback-only HTTP/1.1 client with connection close.
  // Avoid keepalive/parser ambiguity when Paystack's WC-API handlers call exit.
  return new Promise((resolve, reject) => {
    const headers = { Connection: 'close' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (signature) headers['x-paystack-signature'] = signature;
    const request = http.request({
      hostname: '127.0.0.1', port: 8091, path: endpoint,
      method, headers, timeout: 70_000,
    }, response => {
      const chunks = [];
      response.on('data', data => chunks.push(data));
      response.on('error', reject);
      response.on('end', () => {
        const textBody = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode;
        if (status >= 500) {
          return reject(new Error('Synthetic Paystack ' + method + ' ' + endpoint +
            ' returned ' + status + ' body=' + textBody.slice(0, 300) +
            ' server=' + serverErrors.slice(-700)));
        }
        resolve({ status, text: textBody, headers: response.headers });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Synthetic HTTP timeout')));
    request.end(body);
  });
}
async function webhook(key, validSignature = true) {
  const payload = JSON.stringify({
    event: 'charge.success',
    data: { reference: cases[key].ref },
  });
  const signature = validSignature
    ? createHmac('sha512', syntheticSecret).update(payload).digest('hex')
    : '0'.repeat(128);
  const res = await call('POST', '/?wc-api=tbz_wc_paystack_webhook', payload, signature);
  assert.equal(res.status, 200, 'Synthetic Paystack webhook must return 200');
}
async function redirected(key) {
  const ref = encodeURIComponent(cases[key].ref);
  const res = await call('GET', '/?wc-api=wc_gateway_paystack&reference=' + ref);
  assert.ok(res.status === 302 || res.status === 303,
    'Synthetic Paystack return must redirect, not fail');
}
try {
  let started = false;
  for (let i = 0; i < 40; i++) {
    if (server.exitCode !== null) break;
    try {
      const resp = await call('GET', '/');
      if (resp.status < 500) { started = true; break; }
    } catch {}
    await sleep(250);
  }
  assert.ok(started, 'Local synthetic WordPress HTTP server did not start: ' + serverErrors);

  await webhook('webhook_late', false);
  process.stdout.write(wpCli('invalid-hmac'));
  await webhook('webhook_valid');
  process.stdout.write(wpCli('webhook-valid'));
  await webhook('webhook_valid');
  process.stdout.write(wpCli('webhook-replay'));
  await webhook('webhook_late');
  process.stdout.write(wpCli('webhook-late'));
  await webhook('webhook_late');
  process.stdout.write(wpCli('webhook-late-replay'));
  await redirected('return_valid');
  process.stdout.write(wpCli('return-valid'));
  await redirected('return_late');
  process.stdout.write(wpCli('return-late'));
  await webhook('webhook_mismatch');
  process.stdout.write(wpCli('webhook-mismatch'));
  await webhook('webhook_underpaid');
  process.stdout.write(wpCli('webhook-underpaid'));
  process.stdout.write('DISPOSABLE_REAL_PAYSTACK_HTTP_OK: signed/invalid/replayed webhooks, ' +
    'valid/late return callbacks, wrong-currency and underpaid last-unit safety; synthetic local HTTP only.\n');
} finally {
  server.kill('SIGTERM');
}
