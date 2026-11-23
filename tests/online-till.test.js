import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { POS_ORIGIN, posRoot, requestAllowed, downloadAllowed, downloadName, verifyPos } = require('../desktop/online/policy.cjs');
const directory = path.resolve('desktop/online');
const read = name => fs.readFileSync(path.join(directory, name), 'utf8');
const request = (url, method = 'GET', resourceType = 'xhr') => requestAllowed({ url, method, resourceType });

function healthResponse({ url = `${POS_ORIGIN}/api/health`, status = 200, contentType = 'application/json',
  redirected = false, ok = true, mode = 'live', liveReadOnly = false } = {}) {
  return { url, status, redirected, headers: { get: () => contentType },
    text: async () => JSON.stringify({ ok, mode, liveReadOnly, version: '1.2.3' }) };
}

test('Windows till has its own identity, no offline POS/website bundle and no publisher', () => {
  const config = JSON.parse(read('builder.json'));
  const manifest = JSON.parse(read('package.json'));
  const pos = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const hardware = JSON.parse(fs.readFileSync('desktop/hardware-test/builder.json', 'utf8'));
  const practice = JSON.parse(fs.readFileSync('desktop/pos-trial/builder.json', 'utf8'));
  for (const other of [pos.build, hardware, practice]) {
    assert.notEqual(config.appId, other.appId);
    assert.notEqual(config.productName, other.productName);
  }
  assert.notEqual(config.appId, 'com.mansutrendzgh.pos.online-pilot'); // installs beside, not over, the read-only pilot
  assert.equal(config.electronVersion, pos.devDependencies.electron);
  assert.equal(config.asar, true);
  assert.equal(config.npmRebuild, false);
  assert.deepEqual([...config.files].sort(), ['main.cjs', 'policy.cjs', 'package.json'].sort());
  assert.equal(config.publish, undefined);
  assert.equal(config.extraFiles, undefined);
  assert.equal(config.extraResources, undefined);
  assert.equal(config.nsis.perMachine, false);
  assert.match(config.nsis.artifactName, /^Mansu-POS-ONLINE-\$\{version\}-Windows-Setup/);
  assert.equal(manifest.private, true);
  assert.equal(manifest.main, 'main.cjs');
  assert.deepEqual(manifest.dependencies || {}, {});
  assert.deepEqual(manifest.devDependencies || {}, {});
  assert.ok(pos.build.files.includes('!desktop/online/**'), 'offline installer must not contain the online shell');
  assert.match(pos.scripts['dist:online:win'], /--projectDir desktop\/online.*--publish never/);
});

test('till has no local sale path, credential bridge, updater or browser-exposed Node access', () => {
  const main = read('main.cjs'), policy = read('policy.cjs');
  assert.match(main, /session\.fromPartition\(partition, \{ cache: false \}\)/);
  assert.match(main, /webRequest\.onBeforeRequest/);
  assert.match(main, /verifyPos\(\)/);
  assert.match(main, /window\.loadURL\('about:blank'\)/); // explicit no-network packaged smoke navigation
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /setPermissionRequestHandler\(\(_contents, _permission, callback\) => callback\(false\)\)/);
  assert.match(main, /downloadAllowed\(item\.getURL\(\)\)/);
  assert.doesNotMatch(main, /preload/);
  assert.doesNotMatch(main + policy, /\bnode:sqlite\b|\bsafeStorage\b|\belectron-updater\b|\bDesktopStore\b|\bDesktopRemote\b|\bmansuDesktop\s*=|\brequire\(['"]\.\.\/store/);
  assert.doesNotMatch(policy, /process\.env|http:\/\/|trading\.mansutrendzgh\.com/);
  assert.equal(POS_ORIGIN, 'https://pos.mansutrendzgh.com');
});

test('request policy allows the whole online POS: sign-in, selling, shifts, stock, returns and exports', () => {
  assert.ok(posRoot(`${POS_ORIGIN}/`));
  assert.ok(request(`${POS_ORIGIN}/`, 'GET', 'mainFrame'));
  for (const p of ['/assets/index-abc123.js', '/assets/dm-sans-latin-400-normal.woff2', '/icons/mansu-512.png', '/manifest.webmanifest', '/favicon.svg']) {
    assert.ok(request(`${POS_ORIGIN}${p}`, 'GET', 'script'), p);
  }
  for (const p of ['/api/session', '/api/catalog?refresh=1', '/api/sales?cursor=x', '/api/shifts/current',
    '/api/inventory', '/api/reports/export?days=7', '/api/returns/find?q=1001', '/api/purchase-orders']) {
    assert.ok(request(`${POS_ORIGIN}${p}`), p);
  }
  for (const p of ['/api/auth/login', '/api/auth/logout', '/api/auth/password', '/api/sales/prepare',
    '/api/sales/abc/confirm-cash', '/api/sales/abc/cancel', '/api/sales/abc/reconcile', '/api/shifts/open',
    '/api/shifts/1/cash', '/api/shifts/1/close', '/api/inventory/adjust', '/api/inventory/count', '/api/returns',
    '/api/products', '/api/products/media', '/api/purchase-orders/1/receive', '/api/staff']) {
    assert.ok(request(`${POS_ORIGIN}${p}`, 'POST'), p);
  }
  assert.ok(request(`${POS_ORIGIN}/api/wholesale-prices/1/0`, 'DELETE'));
  assert.ok(request('https://www.mansutrendzgh.com/wp-content/uploads/2026/photo.jpg', 'GET', 'image'));
  assert.ok(request('https://mansutrendzgh.com/wp-content/uploads/2026/photo.jpg', 'GET', 'image'));
  assert.ok(request(`blob:${POS_ORIGIN}/2b8f1c3e-0000-4000-8000-000000000000`, 'GET', 'image'));
  assert.ok(request('data:image/png;base64,iVBORw0KGgo=', 'GET', 'image'));
});

test('offline-till routes, demo sign-in, service workers, other sites, frames and navigations fail closed', () => {
  for (const p of ['/api/desktop/enroll', '/api/desktop/allocate', '/api/desktop/sync', '/api/auth/demo']) {
    assert.equal(request(`${POS_ORIGIN}${p}`, 'POST'), false, p);
  }
  assert.equal(request(`${POS_ORIGIN}/api/desktop/bootstrap?deviceId=x`), false);
  assert.equal(request(`${POS_ORIGIN}/api/sales/prepare`, 'POST', 'mainFrame'), false);
  assert.equal(request(`${POS_ORIGIN}/api/sales/prepare`, 'POST', 'subFrame'), false);
  assert.equal(request(`${POS_ORIGIN}/api/sales`, 'TRACE'), false);
  assert.equal(request(`${POS_ORIGIN}/sw.js`, 'GET', 'serviceWorker'), false);
  assert.equal(request(`${POS_ORIGIN}/sw.js`, 'GET', 'script'), false);
  assert.equal(request(`${POS_ORIGIN}/offline.html`, 'GET', 'mainFrame'), false);
  assert.equal(request(`${POS_ORIGIN}/assets/x.js`, 'POST', 'script'), false);
  assert.equal(request(`${POS_ORIGIN}/other`, 'GET', 'mainFrame'), false);
  assert.equal(request(`${POS_ORIGIN}/api/session#x`), false);
  assert.equal(request(`wss://pos.mansutrendzgh.com/socket`, 'GET', 'webSocket'), false);
  assert.equal(posRoot(`${POS_ORIGIN}/?next=/`), false);
  for (const url of [
    'http://pos.mansutrendzgh.com/', 'https://pos.mansutrendzgh.com.evil.test/',
    'https://evil.test@pos.mansutrendzgh.com/', 'https://trading.mansutrendzgh.com/',
    'https://www.mansutrendzgh.com/wp-json/wc/v3/orders', 'file:///C:/Windows/system.ini',
    'https://example.com/wp-content/uploads/p.png',
  ]) assert.equal(request(url, 'GET', 'mainFrame'), false, url);
  assert.equal(request('https://www.mansutrendzgh.com/wp-json/wc/v3/orders', 'GET', 'xhr'), false);
  assert.equal(request('https://www.mansutrendzgh.com/wp-content/uploads/photo.jpg', 'GET', 'xhr'), false);
  assert.equal(request('https://www.mansutrendzgh.com/wp-content/uploads/photo.jpg', 'POST', 'image'), false);
  assert.equal(request('blob:https://example.com/2b8f1c3e', 'GET', 'image'), false);
  assert.equal(request('data:text/html,<script>alert(1)</script>', 'GET', 'mainFrame'), false);
});

test('downloads are limited to POS exports and get a safe file name', () => {
  assert.ok(downloadAllowed(`blob:${POS_ORIGIN}/2b8f1c3e-0000-4000-8000-000000000000`));
  assert.ok(downloadAllowed(`${POS_ORIGIN}/api/reports/export?days=7`));
  assert.ok(downloadAllowed(`${POS_ORIGIN}/api/inventory/export`));
  for (const url of ['blob:https://example.com/x', 'https://example.com/a.csv', `${POS_ORIGIN}/api/staff`,
    `${POS_ORIGIN}/assets/index.js`, 'file:///C:/x.csv', undefined]) assert.equal(downloadAllowed(url), false, String(url));
  assert.equal(downloadName('mansu-stock-2026-11-23.csv'), 'mansu-stock-2026-11-23.csv');
  assert.equal(downloadName('..\\..\\evil.exe'), '_.._evil.exe.csv');
  assert.equal(downloadName(''), 'mansu-pos-export.csv');
  assert.equal(downloadName('report.json'), 'report.json');
});

test('POS must answer directly over HTTPS as healthy live JSON before the till opens', async () => {
  let called;
  assert.deepEqual(await verifyPos(async (url, options) => { called = { url, options }; return healthResponse(); }),
    { readOnly: false, version: '1.2.3' });
  assert.equal(called.url, `${POS_ORIGIN}/api/health`);
  assert.equal(called.options.redirect, 'error');
  assert.equal(called.options.method, 'GET');
  assert.deepEqual(await verifyPos(async () => healthResponse({ liveReadOnly: true })), { readOnly: true, version: '1.2.3' });
  // Electron net.fetch reports no final URL; redirects are refused by redirect: 'error'.
  assert.deepEqual(await verifyPos(async () => healthResponse({ url: '' })), { readOnly: false, version: '1.2.3' });
  for (const response of [
    { status: 503 }, { url: 'https://other.test/api/health' }, { redirected: true },
    { contentType: 'text/html' }, { mode: 'demo' }, { mode: 'staging' }, { ok: false },
  ]) await assert.rejects(() => verifyPos(async () => healthResponse(response)), /could not be reached securely/);
  await assert.rejects(() => verifyPos(async () => { throw new Error('certificate rejected'); }), /could not be reached securely/);
});
