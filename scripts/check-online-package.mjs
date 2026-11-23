import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listPackage, extractFile } from '@electron/asar';

try {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) throw new Error('Pass the Windows till resources/app.asar for inspection.');
  const entries = listPackage(file).map(name => name.replaceAll('\\', '/').replace(/^\/+/, '')).sort();
  const expected = ['main.cjs', 'policy.cjs', 'preload.cjs', 'drawer.cjs', 'package.json'].sort();
  assert.deepEqual(entries, expected, 'Unexpected Windows online package contents (offline ledger, web bundle or secrets?).');
  // Files packed on a Windows checkout have CRLF line endings.
  const content = name => extractFile(file, name.split('/').join(path.sep)).toString().replace(/\r\n/g, '\n');
  const manifest = JSON.parse(content('package.json'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.main, 'main.cjs');
  assert.deepEqual(manifest.dependencies || {}, {});
  assert.deepEqual(manifest.devDependencies || {}, {});
  assert.match(manifest.name, /online-till/);
  const main = content('main.cjs'), policy = content('policy.cjs');
  assert.match(main, /cache: false/);
  assert.match(main, /webRequest\.onBeforeRequest/);
  assert.match(main, /verifyPos\(\)/);
  assert.match(main, /sandbox: true/);
  assert.match(policy, /https:\/\/pos\.mansutrendzgh\.com/);
  assert.match(main, /\/api\/desktop\/sync/); // offline sync explicitly denied in the packaged smoke check
  assert.match(main, /contextIsolation: true/);
  const preload = content('preload.cjs');
  assert.equal((preload.match(/exposeInMainWorld/g) || []).length, 1);
  assert.match(preload, /printReceipt: \(\) => ipcRenderer\.invoke\('mansu-till:print-receipt'\)/);
  assert.match(preload, /receiptReady: \(saleId, paymentMethod\) => ipcRenderer\.invoke\('mansu-till:receipt-ready'/);
  assert.equal((preload.match(/ipcRenderer\./g) || []).length, 2);
  const drawer = content('drawer.cjs');
  assert.match(drawer, /0x1b, 0x70/);
  assert.match(drawer, /\$env:MANSU_DRAWER_PRINTER/);
  assert.doesNotMatch(drawer, /shell:\s*true|execSync/);
  assert.doesNotMatch(preload, /\bfs\b|child_process|shell|sendSync|webFrame/);
  assert.doesNotMatch(main + policy, /\bnode:sqlite\b|\bsafeStorage\b|\belectron-updater\b|\bDesktopStore\b|\bDesktopRemote\b|\bmansuDesktop\s*=/);
  assert.doesNotMatch(policy, /process\.env|trading\.mansutrendzgh\.com|http:\/\//);
  console.log('Packaged Mansu POS till: five files (receipt-print bridge only: print, receipt ready; ESC/POS drawer pulse), pinned HTTPS POS, no offline ledger/queue/renderer, no updater or publisher.');
} catch (error) {
  const brief = String(error.message).replaceAll('%', '%25').replace(/[\r\n]+/g, ' | ').slice(0, 900);
  console.error(`::error title=Windows till package isolation::${brief}`);
  throw error;
}
