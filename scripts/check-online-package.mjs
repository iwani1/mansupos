import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listPackage, extractFile } from '@electron/asar';

try {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) throw new Error('Pass the Windows online pilot resources/app.asar for inspection.');
  const entries = listPackage(file).map(name => name.replaceAll('\\', '/').replace(/^\/+/, '')).sort();
  const expected = ['main.cjs', 'policy.cjs', 'package.json'].sort();
  assert.deepEqual(entries, expected, 'Unexpected Windows online package contents (offline ledger, web bundle or secrets?).');
  const content = name => extractFile(file, name.split('/').join(path.sep)).toString();
  const manifest = JSON.parse(content('package.json'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.main, 'main.cjs');
  assert.deepEqual(manifest.dependencies || {}, {});
  assert.deepEqual(manifest.devDependencies || {}, {});
  assert.match(manifest.name, /online-read-only-pilot/);
  const main = content('main.cjs'), policy = content('policy.cjs');
  assert.match(main, /cache: false/);
  assert.match(main, /webRequest\.onBeforeRequest/);
  assert.match(main, /verifyPilot\(\)/);
  assert.match(main, /sandbox: true/);
  assert.match(policy, /https:\/\/pos\.mansutrendzgh\.com/);
  assert.match(main, /\/api\/sales\/prepare/); // explicitly denied in the packaged smoke check
  assert.doesNotMatch(main + policy, /\bnode:sqlite\b|\bsafeStorage\b|\belectron-updater\b|\bDesktopStore\b|\bDesktopRemote\b|\bmansuDesktop\s*=/);
  assert.doesNotMatch(policy, /process\.env|trading\.mansutrendzgh\.com|http:\/\//);
  console.log('Packaged online read-only pilot: three files, pinned HTTPS service, no offline ledger/queue/renderer, no updater or publisher.');
} catch (error) {
  const brief = String(error.message).replaceAll('%', '%25').replace(/[\r\n]+/g, ' | ').slice(0, 900);
  console.error(`::error title=Online pilot package isolation::${brief}`);
  throw error;
}
