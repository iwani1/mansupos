import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listPackage, extractFile } from '@electron/asar';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) throw new Error('Pass the built Windows resources/app.asar for hardware package inspection.');
const actual = listPackage(file).map(name => name.replace(/^\//, '')).sort();
const allowed = ['main.cjs', 'index.html', 'hardware.css', 'hardware.js', 'package.json'].sort();
assert.deepEqual(actual, allowed, `The hardware-only app unexpectedly contains: ${actual.join(', ')}`);
const manifest = JSON.parse(extractFile(file, 'package.json').toString());
assert.equal(manifest.main, 'main.cjs');
assert.deepEqual(manifest.dependencies || {}, {});
assert.deepEqual(manifest.devDependencies || {}, {});
assert.match(extractFile(file, 'index.html').toString(), /NOT VALID FOR GOODS RELEASE/);
console.log('Packaged hardware-check app contains exactly four local files and a dependency-free manifest; no POS, Woo, ledger, or updater code.');
