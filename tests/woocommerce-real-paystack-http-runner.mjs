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
    const errorLines = (p.stderr || '').split('\n').filter(line =>
      /Fatal error|RuntimeException|Uncaught|stock|Payment|Paystack|assertions|Error:/.test(line)
    ).slice(0, 15).join('\n');
    throw new Error('Paystack synthetic WP-CLI ' + phase + ' failed: ' +
      errorLines.slice(0, 2400) + '\n' + (p.stdout || '').slice(-1400));
  }
  return p.stdout;
}
const setup = wpCli('setup');
const match = setup.match(/^DISPOSABLE_PAYSTACK_HTTP_SETUP (.+)$/m);
assert.ok(match, 'Fixture setup did not return synthetic orders');
const cases = JSON.parse(match[1]);
// Two independent loopback server processes share the SAME disposable Woo DB.
// Distinct listener ports guarantee that overlapping callbacks are processed
// by separate PHP workers; one multiworker server may accept two sockets on
// the same worker and deadlock a deterministic entry barrier.
const primaryServer = spawn('php', ['-S', '127.0.0.1:8091', '-t', wp], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
const secondaryServer = spawn('php', ['-S', '127.0.0.1:8092', '-t', wp], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErrors = '';
for (const server of [primaryServer, secondaryServer]) {
  server.stderr.on('data', d => { serverErrors = (serverErrors + d.toString()).slice(-5000); });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function call(method, endpoint, body = undefined, signature = undefined, port = 8091) {
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
      hostname: '127.0.0.1', port, path: endpoint,
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
async function webhook(key, validSignature = true, port = 8091) {
  const payload = JSON.stringify({
    event: 'charge.success',
    data: { reference: cases[key].ref },
  });
  const signature = validSignature
    ? createHmac('sha512', syntheticSecret).update(payload).digest('hex')
    : '0'.repeat(128);
  const res = await call('POST', '/?wc-api=tbz_wc_paystack_webhook', payload, signature, port);
  // The draft bridge rejects forged signatures before taking its per-order
  // advisory lock; a valid signed webhook still returns 200.
  assert.equal(res.status, validSignature ? 200 : 401,
    'Synthetic signed/forged webhook returned unexpected HTTP status');
}
async function redirected(key, port = 8091, expectedStatus = 302) {
  const ref = encodeURIComponent(cases[key].ref);
  const res = await call('GET', '/?wc-api=wc_gateway_paystack&reference=' + ref, undefined, undefined, port);
  if (Array.isArray(expectedStatus)) {
    assert.ok(expectedStatus.includes(res.status),
      'Concurrent original-order late return must be rejected or redirected after signed quarantine: ' + res.status);
  } else if (expectedStatus === 302) {
    assert.ok(res.status === 302 || res.status === 303,
      'Synthetic valid Paystack return must redirect');
  } else {
    assert.equal(res.status, expectedStatus,
      'Unbound or expired Paystack return must fail closed');
  }
}
try {
  for (const [server, port] of [[primaryServer, 8091], [secondaryServer, 8092]]) {
    let started = false;
    for (let i = 0; i < 40; i++) {
      if (server.exitCode !== null) break;
      try {
        const resp = await call('GET', '/', undefined, undefined, port);
        if (resp.status < 500) { started = true; break; }
      } catch {}
      await sleep(250);
    }
    assert.ok(started, 'Local synthetic WordPress HTTP server on ' + port +
      ' did not start: ' + serverErrors);
  }

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
  await redirected('return_late', 8091, 409);
  process.stdout.write(wpCli('return-late'));
  await webhook('webhook_mismatch');
  process.stdout.write(wpCli('webhook-mismatch'));
  await webhook('webhook_underpaid');
  process.stdout.write(wpCli('webhook-underpaid'));
  await redirected('return_reference_mismatch', 8091, 403);
  process.stdout.write(wpCli('return-reference-mismatch'));
  await webhook('webhook_verify_failed');
  process.stdout.write(wpCli('webhook-verify-failed'));
  // A PHP worker sleeps 10s in upstream webhook processing. The other
  // worker must still be able to reach the same verified transaction before
  // either one proceeds. The mock's on-disk barrier proves genuine overlap.
  await Promise.all([webhook('race_valid', true, 8091), redirected('race_valid', 8092)]);
  process.stdout.write(wpCli('race-valid'));
  // A signed webhook quarantines the expired order. The unsigned return
  // either sees pending and receives 409, or sees the already-on-hold order
  // and safely redirects; neither is evidence of Paystack payment success.
  await Promise.all([webhook('race_late', true, 8091), redirected('race_late', 8092, [302, 303, 409])]);
  process.stdout.write(wpCli('race-late'));
  process.stdout.write('DISPOSABLE_REAL_PAYSTACK_HTTP_OK: signed/invalid/replayed webhooks, ' +
    'valid/late returns, verified transaction identity and two-worker same-order races; synthetic local HTTP only.\n');
} finally {
  primaryServer.kill('SIGTERM');
  secondaryServer.kill('SIGTERM');
}
