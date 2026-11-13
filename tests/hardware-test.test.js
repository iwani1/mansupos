import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'desktop', 'hardware-test');
const read = name => fs.readFileSync(path.join(folder, name), 'utf8');

// Keep the installer independently auditable: no POS app, sync, customer data,
// Woo secrets, native bridge or runtime dependencies may be packaged.
test('the hardware installer is a separate app containing only four local files and its manifest', () => {
  const config = JSON.parse(read('builder.json'));
  const manifest = JSON.parse(read('package.json'));
  const pos = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.notEqual(config.appId, pos.build.appId);
  assert.equal(config.electronVersion, pos.devDependencies.electron);
  assert.equal(manifest.main, 'main.cjs');
  assert.equal(manifest.private, true);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.deepEqual([...config.files].sort(), ['main.cjs', 'index.html', 'hardware.css', 'hardware.js', 'package.json'].sort());
  assert.equal(config.asar, true);
  assert.equal(config.publish, undefined);
  assert.equal(config.extraResources, undefined);
  assert.equal(config.extraFiles, undefined);
  assert.equal(config.nsis.perMachine, false);
  assert.match(config.nsis.artifactName, /Hardware-Check/);
  assert.equal(pos.scripts['dist:hardware:win'].includes('--publish never'), true);
});

test('hardware UI is clearly non-selling and cannot request a remote page', () => {
  const html = read('index.html');
  const main = read('main.cjs');
  const script = read('hardware.js');
  assert.match(html, /HARDWARE TEST ONLY/);
  assert.match(html, /NOT A RECEIPT/);
  assert.match(html, /NOT VALID FOR GOODS RELEASE/);
  assert.match(html, /connect-src 'none'/);
  assert.match(main, /session\.defaultSession\.webRequest\.onBeforeRequest/);
  assert.match(main, /url\.protocol === 'file:' /);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(script, /window\.print\(\)/);
  assert.doesNotMatch(script, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\blocalStorage\b/);
  assert.doesNotMatch(html, /https?:\/\//i);
});
