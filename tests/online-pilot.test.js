import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PILOT_ORIGIN, pilotRoot, requestAllowed, verifyPilot } = require('../desktop/online/policy.cjs');
const directory = path.resolve('desktop/online');
const read = name => fs.readFileSync(path.join(directory, name), 'utf8');
const request = (url, method = 'GET', resourceType = 'xhr') => requestAllowed({ url, method, resourceType });

function healthResponse({ url = `${PILOT_ORIGIN}/api/health`, status = 200, contentType = 'application/json',
  redirected = false, ok = true, mode = 'live', liveReadOnly = true } = {}) {
  return { url, status, redirected, headers: { get: () => contentType },
    text: async () => JSON.stringify({ ok, mode, liveReadOnly, version: '1.2.3' }) };
}

test('online installer has its own identity, no offline POS/website bundle and no publisher', () => {
  const config = JSON.parse(read('builder.json'));
  const manifest = JSON.parse(read('package.json'));
  const pos = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const hardware = JSON.parse(fs.readFileSync('desktop/hardware-test/builder.json', 'utf8'));
  const practice = JSON.parse(fs.readFileSync('desktop/pos-trial/builder.json', 'utf8'));
  for (const other of [pos.build, hardware, practice]) assert.notEqual(config.appId, other.appId);
  assert.equal(config.electronVersion, pos.devDependencies.electron);
  assert.equal(config.asar, true);
  assert.equal(config.npmRebuild, false);
  assert.deepEqual([...config.files].sort(), ['main.cjs', 'policy.cjs', 'package.json'].sort());
  assert.equal(config.publish, undefined);
  assert.equal(config.extraFiles, undefined);
  assert.equal(config.extraResources, undefined);
  assert.equal(config.nsis.perMachine, false);
  assert.match(config.productName, /Online.*READ ONLY PILOT/i);
  assert.match(config.nsis.artifactName, /ONLINE-READ-ONLY-PILOT/);
  assert.equal(manifest.private, true);
  assert.equal(manifest.main, 'main.cjs');
  assert.deepEqual(manifest.dependencies || {}, {});
  assert.deepEqual(manifest.devDependencies || {}, {});
  assert.ok(pos.build.files.includes('!desktop/online/**'), 'offline installer must not contain the online shell');
  assert.match(pos.scripts['dist:online:win'], /--projectDir desktop\/online.*--publish never/);
});

test('app has no local sale path, credential bridge, updater or browser-exposed Node access', () => {
  const main = read('main.cjs'), policy = read('policy.cjs');
  assert.match(main, /session\.fromPartition\(partition, \{ cache: false \}\)/);
  assert.match(main, /webRequest\.onBeforeRequest/);
  assert.match(main, /verifyPilot\(\)/);
  assert.match(main, /window\.loadURL\('about:blank'\)/); // explicit no-network packaged smoke navigation
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /will-download/);
  assert.doesNotMatch(main + policy, /\bnode:sqlite\b|\bsafeStorage\b|\belectron-updater\b|\bDesktopStore\b|\bDesktopRemote\b|\bmansuDesktop\s*=|\brequire\(['"]\.\.\/store/);
  assert.doesNotMatch(policy, /process\.env|http:\/\/|trading\.mansutrendzgh\.com/);
  assert.equal(PILOT_ORIGIN, 'https://pos.mansutrendzgh.com');
});

test('read-only request policy allows pilot login, catalogue and constrained product images', () => {
  assert.ok(pilotRoot(`${PILOT_ORIGIN}/`));
  assert.ok(request(`${PILOT_ORIGIN}/`, 'GET', 'mainFrame'));
  for (const path of ['/assets/index-abc123.js', '/icons/mansu-512.png', '/manifest.webmanifest']) {
    assert.ok(request(`${PILOT_ORIGIN}${path}`, 'GET', 'script'), path);
  }
  for (const path of ['/api/session', '/api/catalog?refresh=1', '/api/sales?cursor=fake', '/api/wholesale-prices',
    '/api/instore/catalog', '/api/connection/diagnostics']) {
    assert.ok(request(`${PILOT_ORIGIN}${path}`), path);
  }
  for (const path of ['/api/auth/login', '/api/auth/logout', '/api/auth/password']) {
    assert.ok(request(`${PILOT_ORIGIN}${path}`, 'POST'), path);
  }
  assert.ok(request('https://www.mansutrendzgh.com/wp-content/uploads/2026/photo.jpg', 'GET', 'image'));
});

test('mutations, service workers, arbitrary origins, frames and navigations fail closed', () => {
  for (const path of ['/api/sales/prepare', '/api/sales/fake/pay', '/api/sales/fake/cancel',
    '/api/desktop/allocate', '/api/desktop/bootstrap', '/api/instore/sales', '/api/wholesale-prices/1/0',
    '/api/shifts/open', '/api/staff', '/api/connection/test', '/api/auth/demo']) {
    assert.equal(request(`${PILOT_ORIGIN}${path}`, 'POST'), false, path);
  }
  assert.equal(request(`${PILOT_ORIGIN}/api/wholesale-prices/1/0`, 'DELETE'), false);
  assert.equal(request(`${PILOT_ORIGIN}/api/desktop/bootstrap?deviceId=fake`), false);
  assert.equal(request(`${PILOT_ORIGIN}/api/sales/prepare`), false);
  assert.equal(request(`${PILOT_ORIGIN}/sw.js`, 'GET', 'serviceWorker'), false);
  assert.equal(request(`${PILOT_ORIGIN}/api/auth/login?redirect=x`, 'POST'), false);
  assert.equal(request(`${PILOT_ORIGIN}/api/auth/login`, 'POST', 'mainFrame'), false);
  assert.equal(request(`${PILOT_ORIGIN}/api/auth/login`, 'POST', 'subFrame'), false);
  assert.equal(request(`${PILOT_ORIGIN}/other`, 'GET', 'mainFrame'), false);
  assert.equal(pilotRoot(`${PILOT_ORIGIN}/?next=/`), false);
  for (const url of [
    'http://pos.mansutrendzgh.com/', 'https://pos.mansutrendzgh.com.evil.test/',
    'https://evil.test@pos.mansutrendzgh.com/', 'https://trading.mansutrendzgh.com/',
    'https://www.mansutrendzgh.com/wp-json/wc/v3/orders', 'file:///C:/Windows/system.ini',
    'https://example.com/wp-content/uploads/p.png',
  ]) assert.equal(request(url, 'GET', 'mainFrame'), false, url);
  assert.equal(request('https://www.mansutrendzgh.com/wp-json/wc/v3/orders', 'GET', 'xhr'), false);
  assert.equal(request('https://www.mansutrendzgh.com/wp-content/uploads/photo.jpg', 'GET', 'xhr'), false);
  assert.equal(request('https://www.mansutrendzgh.com/wp-content/uploads/photo.jpg', 'POST', 'image'), false);
});

test('pilot must respond directly over HTTPS as healthy live read-only JSON before opening', async () => {
  let called;
  await verifyPilot(async (url, options) => {
    called = { url, options };
    return healthResponse();
  });
  assert.equal(called.url, `${PILOT_ORIGIN}/api/health`);
  assert.equal(called.options.redirect, 'error');
  assert.equal(called.options.method, 'GET');
  for (const response of [
    { status: 503 }, { url: 'https://other.test/api/health' }, { redirected: true },
    { contentType: 'text/html' }, { mode: 'demo' }, { mode: 'staging' },
    { liveReadOnly: false }, { ok: false },
  ]) await assert.rejects(() => verifyPilot(async () => healthResponse(response)), /could not be verified/);
  await assert.rejects(() => verifyPilot(async () => { throw new Error('certificate rejected'); }), /could not be verified/);
});
