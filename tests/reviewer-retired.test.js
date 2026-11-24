import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/db.js';

// Reviewer accounts belonged to the removed stock-evidence workflow. Rows may
// remain in an existing ledger; they must never sign in or reach staff routes.
test('retired reviewer accounts cannot sign in or use an existing session', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-reviewer-retired-'));
  const { app, db } = createApp({ env: { POS_MODE: 'demo', NODE_ENV: 'test', POS_DATA_DIR: dir },
    api: {}, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close();
    fs.rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/api`;

  const id = randomUUID();
  const password = 'Reviewer-password-2026';
  db.prepare('INSERT INTO users(id,username,name,role,password_hash,created_at,must_change_password) VALUES (?,?,?,?,?,?,0)')
    .run(id, 'old-reviewer', 'Old reviewer', 'reviewer', hashPassword(password), new Date().toISOString());

  const login = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'old-reviewer', password }) });
  assert.equal(login.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(id).n, 0);

  // A session issued before the upgrade reads as signed out and is deleted.
  const issue = () => {
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,last_seen) VALUES (?,?,?,?)')
      .run(createHash('sha256').update(token).digest('hex'), id, Date.now() + 3600000, Date.now());
    return { Authorization: `Bearer ${token}` };
  };
  const session = await fetch(`${url}/session`, { headers: issue() });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user, null);
  for (const route of ['/catalog', '/sales', '/shifts/current', '/staff']) {
    const response = await fetch(url + route, { headers: issue() });
    assert.equal(response.status, 401, route);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(id).n, 0);
});
