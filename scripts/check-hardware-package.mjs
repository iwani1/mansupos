import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listPackage, extractFile } from '@electron/asar';

try {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) throw new Error('Pass the built Windows resources/app.asar for hardware package inspection.');
  const actual = listPackage(file).map(name => name.replaceAll('\\', '/').replace(/^\/+/, '')).sort();
  const allowed = ['main.cjs', 'index.html', 'hardware.css', 'hardware.js', 'package.json'].sort();
  const unexpected = actual.filter(name => !allowed.includes(name));
  const missing = allowed.filter(name => !actual.includes(name));
  if (unexpected.length || missing.length) {
    throw new Error(`Unexpected hardware package files: [${unexpected.join(', ')}]; missing: [${missing.join(', ')}]`);
  }
  const manifest = JSON.parse(extractFile(file, 'package.json').toString());
  assert.equal(manifest.main, 'main.cjs');
  assert.deepEqual(manifest.dependencies || {}, {});
  assert.deepEqual(manifest.devDependencies || {}, {});
  assert.match(extractFile(file, 'index.html').toString(), /NOT VALID FOR GOODS RELEASE/);
  console.log('Packaged hardware-check app contains exactly four local files and a dependency-free manifest; no POS, Woo, ledger, or updater code.');
} catch (error) {
  const message = String(error.message).replaceAll('%', '%25').replace(/[\r\n]+/g, ' | ').slice(0, 900);
  console.error(`::error title=Hardware QA package inspection::${message}`);
  throw error;
}
