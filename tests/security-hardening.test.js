import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scryptSync, randomBytes } from 'node:crypto';
import { createApp } from '../server/app.js';
import { hashPassword, verifyPassword, verifyPasswordAsync, needsRehash } from '../server/passwords.js';
import { productSchema, productUpdateSchema } from '../server/products.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const OWNER_PASSWORD = 'test-secret-passphrase-123';

async function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-sec-'));
  const env = { POS_MODE: 'staging', POS_DATA_DIR: dir, NODE_ENV: 'test', WOO_BASE_URL: 'https://staging.example.com',
    WOO_CONSUMER_KEY: 'ck_test', WOO_CONSUMER_SECRET: 'cs_test', POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: OWNER_PASSWORD,
    POS_REQUIRE_SHIFT: 'false', POS_STAGING_APPROVED: 'true' };
  const api = { async listProducts() { return []; }, async listVariations() { return []; } };
  const instance = createApp({ env, api, logger: quiet });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}/api${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); instance.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...instance, request };
}

const legacyHash = password => {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
};

test('password hashes use OWASP scrypt parameters; older hashes still verify and are flagged for upgrade', async () => {
  const fresh = hashPassword('correct horse battery');
  assert.match(fresh, /^scrypt2:32768:8:3:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(needsRehash(fresh), false);
  assert.equal(verifyPassword('correct horse battery', fresh), true);
  assert.equal(await verifyPasswordAsync('correct horse battery', fresh), true);
  assert.equal(await verifyPasswordAsync('wrong horse battery', fresh), false);
  const old = legacyHash('correct horse battery');
  assert.equal(needsRehash(old), true);
  assert.equal(await verifyPasswordAsync('correct horse battery', old), true);
  assert.equal(await verifyPasswordAsync('wrong', old), false);
  // Tampered or hostile parameters are refused rather than run.
  for (const bad of ['scrypt2:3:8:3:aa:bb', 'scrypt2:1073741824:8:1:aa:bb', 'scrypt2:32768:8:99:aa:bb', 'scrypt2:32768:8:3:aa', '', null]) {
    assert.equal(await verifyPasswordAsync('x', bad), false, String(bad));
  }
});

test('signing in upgrades an old hash; signed-out session reveals no feature switches', async t => {
  const h = await harness(t);
  h.db.prepare('UPDATE users SET password_hash=? WHERE username=?').run(legacyHash(OWNER_PASSWORD), 'owner');
  const signedOut = await h.request('/session');
  assert.equal(signedOut.data.user, null);
  assert.deepEqual(Object.keys(signedOut.data.config).sort(), ['businessName', 'configured', 'liveReadOnly', 'mode']);
  const login = await h.request('/auth/login', { method: 'POST', body: { username: 'owner', password: OWNER_PASSWORD } });
  assert.equal(login.status, 200);
  assert.ok('writesEnabled' in login.data.config, 'full config is sent after sign-in');
  const stored = h.db.prepare('SELECT password_hash FROM users WHERE username=?').get('owner').password_hash;
  assert.match(stored, /^scrypt2:32768:8:3:/);
  const again = await h.request('/auth/login', { method: 'POST', body: { username: 'owner', password: OWNER_PASSWORD } });
  assert.equal(again.status, 200, 'upgraded hash still signs in');
  const signedIn = await h.request('/session', { token: again.data.token });
  assert.ok('version' in signedIn.data.config);
});

test('simultaneous wrong passwords are all counted and lock the account', async t => {
  const h = await harness(t);
  const attempts = await Promise.all(Array.from({ length: 8 }, () =>
    h.request('/auth/login', { method: 'POST', body: { username: 'owner', password: 'not-the-password-123' } })));
  assert.ok(attempts.every(a => a.status === 401));
  const row = h.db.prepare('SELECT failed_attempts, locked_until FROM users WHERE username=?').get('owner');
  assert.equal(row.failed_attempts, 8);
  assert.ok(row.locked_until > Date.now());
  const locked = await h.request('/auth/login', { method: 'POST', body: { username: 'owner', password: OWNER_PASSWORD } });
  assert.equal(locked.status, 423, 'even the right password waits out the lock');
});

test('responses deny unused browser features', async t => {
  const h = await harness(t);
  const res = await h.request('/health');
  const policy = res.headers.get('permissions-policy');
  for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()']) assert.ok(policy.includes(feature), feature);
});

test('product text sent to the public website cannot carry HTML markup', () => {
  const base = { key: '2b8f1c3e-0000-4000-8000-000000000000', name: 'Pearl shirt', hasOptions: false, regularPrice: '120' };
  assert.equal(productSchema.safeParse(base).success, true);
  for (const change of [{ name: '<img src=x onerror=alert(1)>' }, { name: 'Shirt <script>' }, { sku: 'A<1>' }, { newCategory: '<b>Sale</b>' }]) {
    const result = productSchema.safeParse({ ...base, ...change });
    assert.equal(result.success, false, JSON.stringify(change));
    assert.ok(result.error.issues.some(issue => /Remove < and >/.test(issue.message)), JSON.stringify(change));
  }
  const options = { ...base, hasOptions: true, regularPrice: '', attributes: [{ name: 'Size', options: ['M', '<svg onload=alert(1)>'] }],
    variations: [{ attributes: { Size: 'M' }, regularPrice: '120' }] };
  assert.ok(productSchema.safeParse(options).error?.issues.some(issue => /Remove < and >/.test(issue.message)));
  assert.equal(productUpdateSchema.safeParse({ name: '<x>' }).success, false);
  // Descriptions may contain < and > as text: they are HTML-escaped before publishing.
  assert.equal(productSchema.safeParse({ ...base, description: 'Size 2 < size 3' }).success, true);
});

test('CSV exports neutralise spreadsheet formulas, including ones behind spaces or tabs', () => {
  const sources = ['server/inventory.js', 'src/Purchasing.jsx', 'server/routes/reports.js', 'src/Catalogue.jsx'].map(file => fs.readFileSync(file, 'utf8'));
  for (const source of sources) assert.match(source, /\^\[?\\s\]?\*\[=\+/);
});
