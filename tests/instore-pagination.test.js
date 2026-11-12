import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createApp } from '../server/app.js';

const sourceHash = createHash('sha256').update(fs.readFileSync('data/instore-stock-snapshot.json')).digest('hex');

test('separate paid-cash history, reporting and CSV never silently truncate at 100 or 10,000 rows', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-instore-pages-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const instance = createApp({ env: {
    NODE_ENV: 'test', POS_MODE: 'live', POS_LIVE_READ_ONLY: 'false', POS_ALLOW_LIVE_WRITES: 'false',
    POS_INSTORE_CASH_APPROVED: 'true', POS_INSTORE_ACCEPTANCE_REFERENCE: 'reviewed-physical-goods-fixture',
    POS_INSTORE_SOURCE_SHA256: sourceHash, POS_REQUIRE_SHIFT: 'true', POS_DATA_DIR: dir,
    WOO_BASE_URL: 'https://mansutrendzgh.com', WOO_CONSUMER_KEY: 'ck_readonly_fixture', WOO_CONSUMER_SECRET: 'cs_readonly_fixture',
    POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'private-initial-passphrase-123',
  }, api: { request() { throw Error('Unexpected WooCommerce call'); } }, logger: { info() {}, error() {}, warn() {} } });
  instance.db.prepare("UPDATE users SET must_change_password=0 WHERE username='owner'").run();
  const owner = instance.db.prepare("SELECT id,name FROM users WHERE username='owner'").get();
  const shiftId = randomUUID();
  instance.db.prepare('INSERT INTO shifts(id,user_id,user_name,opening_float,note,opened_at) VALUES (?,?,?,?,?,?)')
    .run(shiftId, owner.id, owner.name, 0, '', new Date().toISOString());
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); instance.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await (await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'private-initial-passphrase-123' }) })).json();
  const headers = { Authorization: `Bearer ${login.token}` };

  // Fixture-only direct inserts exercise pagination boundaries without selling
  // actual goods or repeatedly changing balances. Do not import this data.
  const insert = instance.db.prepare(`INSERT INTO instore_sales(id,idempotency_key,fingerprint,number,total,tendered,change_due,cashier_id,cashier_name,shift_id,items_json,note,source_hash,paid_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const item = { sku: '1434', name: ' \t=HYPERLINK("https://unsafe.invalid")', quantity: 1, price: 100, total: 100 };
  instance.db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 1; index <= 10005; index++) {
      insert.run(randomUUID(), randomUUID(), 'fixture-fingerprint', `IS-FIXTURE-${String(index).padStart(6, '0')}`,
        100, 100, 0, owner.id, owner.name, shiftId, JSON.stringify([item]), '', sourceHash, new Date().toISOString());
    }
    instance.db.exec('COMMIT');
  } catch (error) { instance.db.exec('ROLLBACK'); throw error; }
  const seen = new Set();
  let before = null;
  do {
    const response = await fetch(base + `/instore/sales?limit=100${before ? `&before=${before}` : ''}`, { headers });
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.ok(page.sales.length <= 100);
    for (const sale of page.sales) { assert.equal(seen.has(sale.id), false); seen.add(sale.id); }
    before = page.nextCursor;
  } while (before);
  assert.equal(seen.size, 10005);
  const report = await (await fetch(base + '/instore/reports?days=1', { headers })).json();
  assert.equal(report.orders, 10005);
  assert.equal(report.total, 1000500);
  assert.equal(report.units, 10005);
  const csvResponse = await fetch(base + '/instore/reports/export?days=1', { headers });
  assert.equal(csvResponse.status, 200);
  const csv = await csvResponse.text();
  assert.equal(csv.split('\r\n').length, 10006);
  assert.match(csv, /"' \t=HYPERLINK\(""https:\/\/unsafe\.invalid""\)"/);
  assert.doesNotMatch(csv, /WooCommerce order|\bCost\b|Markup|Tax/);
  assert.equal(instance.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0);
});
