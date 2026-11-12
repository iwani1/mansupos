import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(fs.readFileSync('public/manifest.webmanifest', 'utf8'));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('install manifest remains same-origin and includes real standard and maskable icons', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.match(fs.readFileSync('index.html', 'utf8'), /<link rel="manifest" href="\/manifest\.webmanifest"\s*\/>/);
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^\/icons\/[\w-]+\.png$/);
    assert.equal(icon.type, 'image/png');
    const png = fs.readFileSync(path.join('public', icon.src));
    assert.ok(png.subarray(0, 8).equals(pngSignature), `${icon.src} is not PNG`);
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
  }
  const apple = fs.readFileSync('public/icons/mansu-apple-180.png');
  assert.ok(apple.subarray(0, 8).equals(pngSignature));
  assert.equal(apple.readUInt32BE(16), 180);
  assert.equal(apple.readUInt32BE(20), 180);
});

test('offline shell is a public no-sales notice, not a cached POS application', () => {
  const offline = fs.readFileSync('public/offline.html', 'utf8');
  assert.match(offline, /No offline sales/);
  assert.match(offline, /noindex, nofollow/);
  assert.doesNotMatch(offline, /<script\b/i);
  const worker = fs.readFileSync('public/sw.js', 'utf8');
  assert.match(worker, /request\.method !== 'GET'/);
  assert.match(worker, /request\.mode !== 'navigate'/);
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
});
