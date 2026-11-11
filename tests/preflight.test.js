import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server/app.js';

test('staging preflight requires a valid first owner, then accepts a recorded owner without retaining the bootstrap secret', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env, NODE_ENV: 'test', POS_MODE: 'staging', POS_DATA_DIR: dir,
    WOO_BASE_URL: 'https://staging.example.com', WOO_CONSUMER_KEY: 'ck_test', WOO_CONSUMER_SECRET: 'cs_test',
    POS_STAGING_APPROVED: 'false', POS_STAGING_WHOLESALE_APPROVED: 'false',
    POS_OWNER_USERNAME: '', POS_OWNER_PASSWORD: '',
  };
  const preflight = overrides => spawnSync(process.execPath, ['server/preflight.js'], {
    cwd: path.resolve('.'), env: { ...env, ...overrides }, encoding: 'utf8',
  });
  const missing = preflight();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /FAIL {2}Owner sign-in available/);
  assert.equal(fs.existsSync(path.join(dir, 'pos-staging.db')), false, 'preflight must not create a ledger');
  const bootstrap = { POS_OWNER_USERNAME: 'owner', POS_OWNER_PASSWORD: 'test-strong-passphrase-125' };
  const placeholder = preflight({ ...bootstrap, WOO_BASE_URL: 'https://staging.your-domain.example', POS_PUBLIC_ORIGIN: 'https://pos-staging.your-domain.example' });
  assert.notEqual(placeholder.status, 0);
  assert.match(placeholder.stdout, /FAIL {2}Example hostnames replaced/);
  assert.equal(preflight(bootstrap).status, 0);
  const instance = createApp({ env: { ...env, ...bootstrap }, api: {}, logger: { info() {}, warn() {}, error() {} } });
  instance.db.close();
  const existing = preflight();
  assert.equal(existing.status, 0, existing.stdout + existing.stderr);
  assert.match(existing.stdout, /PASS {2}Owner sign-in available — active owner in ledger/);
  const weak = preflight({ POS_OWNER_PASSWORD: 'weak' });
  assert.notEqual(weak.status, 0);
  assert.match(weak.stdout, /FAIL {2}Owner bootstrap secret policy/);
});
