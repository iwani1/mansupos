// Windows CI only: send the cash-drawer pulse through the real Windows print
// spooler (RAW job via winspool) to a test printer whose port is a file, and
// check the exact bytes arrive. No physical printer or drawer is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDrawer, kickBytes } = require('../desktop/online/drawer.cjs');
const [printer, portFile] = process.argv.slice(2);
if (!printer || !portFile) throw new Error('Usage: node scripts/check-drawer-windows.mjs <printer> <port file>');

async function sent() {
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(portFile) && fs.statSync(portFile).size > 0) return fs.readFileSync(portFile);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return Buffer.alloc(0);
}

for (const pin of [2, 5]) {
  fs.rmSync(portFile, { force: true });
  await openDrawer(printer, pin);
  const bytes = await sent();
  assert.equal(bytes.toString('hex'), kickBytes(pin).toString('hex'), `pin ${pin}: spooler output differs`);
  console.log(`Pin ${pin}: Windows spooler delivered ${bytes.toString('hex')} unchanged.`);
}
await assert.rejects(() => openDrawer('Mansu POS no such printer', 2), /Printer not found|not found/i);
console.log('Missing printer is reported, not ignored.');
