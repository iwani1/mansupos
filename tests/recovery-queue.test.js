import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { saleEvent } from '../server/sale-events.js';

test('owner recovery queue reports cash custody separately from Woo refund and denies cashier', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-queue-'));
  const { app, db } = createApp({ env: { POS_MODE: 'demo', NODE_ENV: 'test', POS_DATA_DIR: dir },
    api: {}, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await fetch(`${base}/auth/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const get = route => fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}` } });
  const time = new Date().toISOString();
  const insert = (number, status, method, total, refunded) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO sales(id,idempotency_key,fingerprint,number,status,payment_method,total,refunded,currency,
      cashier_id,cashier_name,note,items_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, randomUUID(), randomUUID(), number, status, method,
      total, refunded, 'GHS', 'demo-owner', 'Demo Owner', '', '[]', time, time);
    return id;
  };
  const id = insert('AUDIT-HELD', 'needs_reconciliation', 'cash', 9000, 0);
  saleEvent(db, id, 'online.cash_accepted', 'demo-owner', { amountCents: 9000 });
  insert('AUDIT-REFUND', 'partially_refunded', 'cash', 10000, 1000);
  insert('AUDIT-UNPAID', 'awaiting_payment', null, 2000, 0);
  insert('AUDIT-PAID', 'paid', 'cash', 2000, 0);
  const before = db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n;
  const result = await get('/recovery/queue?limit=100');
  assert.equal(result.status, 200);
  const { sales } = await result.json();
  const held = sales.find(item => item.number === 'AUDIT-HELD');
  const refund = sales.find(item => item.number === 'AUDIT-REFUND');
  assert.equal(held.cashCustodyUnresolved, true);
  assert.equal(held.cashHeldCents, 9000);
  assert.equal(held.cashPayoutUnverified, false);
  assert.equal(refund.cashCustodyUnresolved, false);
  assert.equal(refund.cashPayoutUnverified, true);
  assert.equal(refund.refundedCents, 1000);
  assert.equal(sales.find(item => item.number === 'AUDIT-UNPAID').cashCustodyUnresolved, false);
  assert.equal(sales.some(item => item.number === 'AUDIT-PAID'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_events').get().n, before);
  assert.equal((await get('/recovery/queue?cursor=not-valid')).status, 400);
  assert.equal((await fetch(`${base}/recovery/queue`)).status, 401);
  db.prepare("UPDATE users SET role='cashier' WHERE id='demo-owner'").run();
  assert.equal((await get('/recovery/queue')).status, 403);
});
