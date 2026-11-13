import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'dotenv';
import { readConfig } from '../server/config.js';

const service = fs.readFileSync('deploy/mansu-pos-live-trading.service', 'utf8');
const backup = fs.readFileSync('deploy/mansu-pos-live-trading-backup.service', 'utf8');
const template = fs.readFileSync('.env.live-trading.example', 'utf8');

test('separate live service pins its identity, listener, ledger path and write locks against a copied env file', () => {
  assert.match(service, /^User=mansu-pos-trading$/m);
  assert.match(service, /^WorkingDirectory=\/opt\/mansu-pos-live-trading$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/mansu-pos-live-trading\/pos\.env$/m);
  assert.match(service, /^ReadWritePaths=\/var\/lib\/mansu-pos-live-trading$/m);
  const startLines = service.split('\n').filter(line => /^ExecStart(Pre)?=/.test(line));
  assert.equal(startLines.length, 2);
  const unsafe = {
    ...parse(template), NODE_ENV: 'test', WOO_CONSUMER_KEY: 'ck_mock', WOO_CONSUMER_SECRET: 'cs_mock',
    POS_MODE: 'demo', POS_LIVE_READ_ONLY: 'true', PORT: '3000', POS_BIND_HOST: '0.0.0.0',
    POS_TRUST_PROXY: '1', POS_REQUIRE_SHIFT: 'false', POS_DATA_DIR: '/var/lib/mansu-pos-live-pilot',
    POS_PUBLIC_ORIGIN: 'https://mansutrendzgh.com', POS_STAGING_APPROVED: 'true',
    POS_STAGING_WHOLESALE_APPROVED: 'true', POS_ALLOW_LIVE_WRITES: 'true',
    POS_OWNER_APPROVAL_REFERENCE: 'copied-owner-approval', POS_LIVE_WHOLESALE_APPROVED: 'true',
    POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE: 'copied-wholesale-approval',
    POS_INSTORE_CASH_APPROVED: 'true', POS_INSTORE_ACCEPTANCE_REFERENCE: 'copied-instore-approval',
    POS_INSTORE_SOURCE_SHA256: 'a'.repeat(64),
    POS_DESKTOP_SETUP_APPROVED: 'true', POS_DESKTOP_RESERVATION_APPROVED: 'true',
    POS_DESKTOP_SETUP_REFERENCE: 'copied-offline-setup', POS_DESKTOP_ACCEPTANCE_REFERENCE: 'copied-offline-sale',
    POS_DESKTOP_WP_APP_USER: 'copied-app-user', POS_DESKTOP_WP_APP_PASSWORD: 'copied-app-pass',
    POS_DESKTOP_DEVICE_MASTER_SECRET: 'test-only-secret-not-for-a-real-deployment-123',
  };
  for (const line of startLines) {
    assert.match(line, /\/usr\/bin\/env .* \/usr\/bin\/node server\/(preflight|index)\.js$/);
    const assignments = line.slice(line.indexOf('/usr/bin/env ') + 13, line.indexOf(' /usr/bin/node'));
    const effective = { ...unsafe };
    for (const part of assignments.split(' ')) {
      const equals = part.indexOf('=');
      assert.notEqual(equals, -1);
      effective[part.slice(0, equals)] = part.slice(equals + 1);
    }
    const config = readConfig(effective);
    assert.equal(config.mode, 'live');
    assert.equal(config.liveReadOnly, false);
    assert.equal(config.writesEnabled, false, 'Locked template cannot create any real orders');
    assert.equal(config.wholesaleWritesEnabled, false);
    assert.equal(config.inStoreCashEnabled, false, 'Trading template must not import or sell the physical collection');
    assert.equal(config.desktopSetupEnabled, false, 'A copied env file cannot enroll an offline device.');
    assert.equal(config.desktopEnabled, false, 'A copied env file cannot authorize offline checkout.');
    assert.deepEqual(config.paymentMethods, ['cash']);
    assert.equal(config.bindHost, '127.0.0.1');
    assert.equal(config.port, 3188);
    assert.equal(config.dataDir, '/var/lib/mansu-pos-live-trading');
    assert.equal(config.publicOrigin, 'https://trading.mansutrendzgh.com');
    assert.equal(config.trustProxy, 'loopback');
    assert.equal(config.requireShift, true);
    assert.equal(effective.POS_STAGING_APPROVED, 'false');
    assert.equal(effective.POS_STAGING_WHOLESALE_APPROVED, 'false');
    assert.equal(effective.POS_ALLOW_LIVE_WRITES, 'false');
    assert.equal(effective.POS_OWNER_APPROVAL_REFERENCE, '');
    assert.equal(effective.POS_LIVE_WHOLESALE_APPROVED, 'false');
    assert.equal(effective.POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE, '');
    assert.equal(effective.POS_INSTORE_CASH_APPROVED, 'false');
    assert.equal(effective.POS_DESKTOP_SETUP_APPROVED, 'false');
    assert.equal(effective.POS_DESKTOP_RESERVATION_APPROVED, 'false');
    assert.equal(effective.POS_INSTORE_ACCEPTANCE_REFERENCE, '');
    assert.equal(effective.POS_INSTORE_SOURCE_SHA256, '');
  }
  const pilot = fs.readFileSync('deploy/mansu-pos-live-pilot.service', 'utf8');
  assert.match(pilot, /POS_LIVE_READ_ONLY=true POS_ALLOW_LIVE_WRITES=false/);
  assert.match(pilot, /POS_DESKTOP_SETUP_APPROVED=false POS_DESKTOP_RESERVATION_APPROVED=false/);
  assert.match(pilot, /PORT=3187 POS_DATA_DIR=\/var\/lib\/mansu-pos-live-pilot/);
});

test('live trading template starts locked, has no secrets and requires a separate backup', () => {
  const env = parse(template);
  assert.equal(env.POS_MODE, 'live');
  assert.equal(env.POS_ALLOW_LIVE_WRITES, 'false');
  assert.equal(env.POS_LIVE_WHOLESALE_APPROVED, 'false');
  assert.equal(env.POS_INSTORE_CASH_APPROVED, 'false');
  assert.equal(env.POS_DESKTOP_SETUP_APPROVED, 'false');
  assert.equal(env.POS_DESKTOP_RESERVATION_APPROVED, 'false');
  assert.equal(env.POS_DESKTOP_DEVICE_MASTER_SECRET, '');
  assert.equal(env.POS_DESKTOP_WP_APP_PASSWORD, '');
  assert.equal(env.POS_INSTORE_ACCEPTANCE_REFERENCE, '');
  assert.equal(env.POS_INSTORE_SOURCE_SHA256, '');
  assert.equal(env.POS_STAGING_APPROVED, 'false');
  assert.equal(env.WOO_CONSUMER_KEY, '');
  assert.equal(env.WOO_CONSUMER_SECRET, '');
  assert.equal(env.POS_OWNER_PASSWORD, '');
  assert.match(backup, /^User=mansu-pos-trading$/m);
  assert.match(backup, /^EnvironmentFile=\/etc\/mansu-pos-live-trading\/pos\.env$/m);
  assert.match(backup, /^ExecStart=.*POS_MODE=live POS_LIVE_READ_ONLY=false POS_DATA_DIR=\/var\/lib\/mansu-pos-live-trading .*server\/backup\.js \/var\/lib\/mansu-pos-live-trading\/backups$/m);
});
