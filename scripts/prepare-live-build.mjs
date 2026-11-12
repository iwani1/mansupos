import fs from 'node:fs';
import path from 'node:path';

// vite build copies public/demo for the isolated demo preview. For a live POS
// build remove only those copied sample assets, never a ledger or source file.
const dist = path.resolve('dist');
if (!fs.statSync(path.join(dist, 'index.html'), { throwIfNoEntry: false })?.isFile()) {
  throw new Error('Production build is missing dist/index.html; run vite build first.');
}
const sampleAssets = path.join(dist, 'demo');
fs.rmSync(sampleAssets, { recursive: true, force: true });
console.log('Live POS build ready: demo illustrations are not included.');
