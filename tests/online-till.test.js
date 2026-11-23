import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { kickBytes, openDrawer, WINDOWS_SCRIPT } = require('../desktop/online/drawer.cjs');
const { POS_ORIGIN, posRoot, requestAllowed, downloadAllowed, downloadName, verifyPos, parseSettings, printRequestAllowed, validSaleId } = require('../desktop/online/policy.cjs');
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
  assert.deepEqual([...config.files].sort(), ['main.cjs', 'policy.cjs', 'preload.cjs', 'drawer.cjs', 'package.json'].sort());
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
  const main = read('main.cjs'), policy = read('policy.cjs'), preload = read('preload.cjs');
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
  // The only bridge: print the receipt on screen. Nothing else reaches the page.
  assert.match(main, /preload: path\.join\(__dirname, 'preload\.cjs'\)/);
  assert.match(preload, /exposeInMainWorld\('mansuTill', Object\.freeze\(\{\n {2}printReceipt: \(\) => ipcRenderer\.invoke\('mansu-till:print-receipt'\),\n {2}receiptReady: \(saleId, paymentMethod\) => ipcRenderer\.invoke\('mansu-till:receipt-ready', String\(saleId\)\.slice\(0, 100\), paymentMethod === 'cash'\),\n\}\)\)/);
  assert.equal((preload.match(/exposeInMainWorld/g) || []).length, 1);
  assert.equal((preload.match(/ipcRenderer\./g) || []).length, 2);
  assert.doesNotMatch(preload, /\bfs\b|child_process|shell|net\.|send\(|sendSync|webFrame/);
  assert.equal((main.match(/ipcMain\.(handle|on)\(/g) || []).length, 2);
  assert.match(main, /event\.sender === window\.webContents &&\n\s+event\.senderFrame === window\.webContents\.mainFrame && printRequestAllowed\(event\.senderFrame\.url\)/);
  assert.equal((main.match(/fromPos\(event\) \?/g) || []).length, 2); // both bridge calls checked
  assert.doesNotMatch(main + policy + preload, /\bnode:sqlite\b|\bsafeStorage\b|\belectron-updater\b|\bDesktopStore\b|\bDesktopRemote\b|\bmansuDesktop\s*=|\brequire\(['"]\.\.\/store/);
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

test('receipt printer setting and print requests are validated', () => {
  const off = { autoPrint: false, drawerOnCash: false, drawerPin: 2 };
  assert.deepEqual(parseSettings('{"receiptPrinter":"EPSON TM-T20III Receipt"}'), { receiptPrinter: 'EPSON TM-T20III Receipt', ...off });
  assert.deepEqual(parseSettings('{"receiptPrinter":"  XP-80C  ","autoPrint":true}'), { ...off, receiptPrinter: 'XP-80C', autoPrint: true });
  assert.deepEqual(parseSettings('{"receiptPrinter":"XP-80C","autoPrint":"yes","drawerOnCash":1,"drawerPin":9}'), { receiptPrinter: 'XP-80C', ...off });
  assert.deepEqual(parseSettings('{"receiptPrinter":"XP-80T","drawerOnCash":true,"drawerPin":5}'), { ...off, receiptPrinter: 'XP-80T', drawerOnCash: true, drawerPin: 5 });
  assert.deepEqual(parseSettings('garbage'), { receiptPrinter: null, ...off });
  for (const text of ['', 'not json', 'null', '{"receiptPrinter":5}', '{"receiptPrinter":""}',
    JSON.stringify({ receiptPrinter: 'x'.repeat(257) }), JSON.stringify({ receiptPrinter: 'bad\nname' })]) {
    assert.equal(parseSettings(text).receiptPrinter, null, text);
  }
  assert.equal(printRequestAllowed(`${POS_ORIGIN}/`), true);
  for (const url of ['about:blank', 'https://example.com/', `${POS_ORIGIN}/other`, 'http://pos.mansutrendzgh.com/', 'not a url', undefined]) {
    assert.equal(printRequestAllowed(url), false, String(url));
  }
});

test('web receipt buttons print through the till bridge, falling back to the browser dialog', () => {
  const helper = fs.readFileSync('src/print-receipt.js', 'utf8');
  assert.match(helper, /window\.mansuTill/);
  assert.match(helper, /window\.print\(\)/);
  for (const file of ['src/Checkout.jsx', 'src/InStore.jsx']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /onClick=\{printReceipt\}/, file);
    assert.doesNotMatch(source, /window\.print\(\)/, file);
  }
});

test('auto-print: only a just-paid sale, once, and only when switched on with a printer chosen', () => {
  for (const id of ['2b8f1c3e-0000-4000-8000-000000000000', 'DEMO-2BFCEBFE', '1234']) assert.equal(validSaleId(id), true, id);
  for (const id of ['', 'x'.repeat(101), 'a b', '<script>', 5, null, undefined]) assert.equal(validSaleId(id), false, String(id));
  const main = read('main.cjs');
  assert.match(main, /if \(!settings\.receiptPrinter \|\| !validSaleId\(saleId\)\) return \{ printed: false \};/);
  assert.match(main, /if \(handledSales\.includes\(saleId\)\) return/);
  assert.match(main, /return settings\.autoPrint \? printReceipt\(contents\) : \{ printed: false \};/);
  const app = fs.readFileSync('src/App.jsx', 'utf8'), checkout = fs.readFileSync('src/Checkout.jsx', 'utf8');
  // Only the payment path marks a receipt fresh; reopening from Sales history does not.
  assert.equal((app.match(/setFreshSaleId\(sale\?\.id\?\?null\)/g) || []).length, 1);
  assert.match(app, /function paid\(sale\)\{setPending\(null\);setFreshSaleId\(sale\?\.id\?\?null\);setReceipt\(sale\);/);
  assert.match(app, /fresh=\{receipt\.id!=null&&receipt\.id===freshSaleId\}/);
  assert.match(app, /onReceipt=\{setReceipt\}/);
  assert.match(checkout, /if \(!fresh \|\| locked\) return undefined;/);
});

test('cash drawer: exact ESC/POS pulse, cash sales only, fixed Windows spooler script with no injected input', async () => {
  assert.equal(kickBytes(2).toString('hex'), '1b700019fa');
  assert.equal(kickBytes(5).toString('hex'), '1b700119fa');
  assert.equal(kickBytes().toString('hex'), '1b700019fa');
  await assert.rejects(() => openDrawer('', 2), /No receipt printer/);
  await assert.rejects(() => openDrawer(null, 2), /No receipt printer/);
  // The printer name and bytes reach the script only through the environment.
  assert.match(WINDOWS_SCRIPT, /\$env:MANSU_DRAWER_PRINTER/);
  assert.match(WINDOWS_SCRIPT, /\$env:MANSU_DRAWER_BYTES/);
  assert.match(WINDOWS_SCRIPT, /pDataType = "RAW"/);
  const drawer = read('drawer.cjs'), main = read('main.cjs'), preload = read('preload.cjs');
  assert.doesNotMatch(drawer, /shell:\s*true|exec\(|execSync|\$\{printer\}/);
  assert.match(drawer, /System32', 'WindowsPowerShell', 'v1\.0', 'powershell\.exe'/);
  assert.match(preload, /paymentMethod === 'cash'\)/);
  assert.match(main, /if \(cash === true && settings\.drawerOnCash\) openCashDrawer\(/);
  assert.match(main, /receiptReady\(window\.webContents, saleId, cash === true\)/);
  assert.match(main, /logDrawer\(reason, 'opened'\)/);
  assert.match(main, /logDrawer\(reason, `FAILED: /);
  assert.match(fs.readFileSync('src/Checkout.jsx', 'utf8'), /autoPrintReceipt\(sale\.id, sale\.paymentMethod\)/);
});
