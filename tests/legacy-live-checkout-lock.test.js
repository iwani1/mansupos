import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';

const approvedLive = {
  NODE_ENV: 'production',
  POS_MODE: 'live',
  WOO_BASE_URL: 'https://mansutrendzgh.com',
  WOO_CONSUMER_KEY: 'ck_synthetic',
  WOO_CONSUMER_SECRET: 'cs_synthetic',
  POS_PUBLIC_ORIGIN: 'https://pos.mansutrendzgh.com',
  POS_ALLOW_LIVE_WRITES: 'true',
  POS_OWNER_APPROVAL_REFERENCE: 'synthetic-owner-approval',
  POS_LIVE_WHOLESALE_APPROVED: 'true',
  POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE: 'synthetic-wholesale-approval',
};

test('production live cannot enable the unreserved legacy Woo checkout through copied approvals', () => {
  const config = readConfig(approvedLive);
  assert.equal(config.legacyLiveCheckoutBlocked, true);
  assert.equal(config.writesEnabled, false);
  assert.equal(config.wholesaleWritesEnabled, false);
  assert.deepEqual(config.paymentMethods, ['cash']);
});

test('the existing read-only pilot remains locked', () => {
  const config = readConfig({
    ...approvedLive,
    POS_LIVE_READ_ONLY: 'true',
    POS_ALLOW_LIVE_WRITES: 'false',
    POS_LIVE_WHOLESALE_APPROVED: 'false',
  });
  assert.equal(config.liveReadOnly, true);
  assert.equal(config.writesEnabled, false);
  assert.equal(config.wholesaleWritesEnabled, false);
});

test('legacy live-mode checkout fixtures remain possible only in a non-production test process', () => {
  const config = readConfig({ ...approvedLive, NODE_ENV: 'test' });
  assert.equal(config.legacyLiveCheckoutBlocked, false);
  assert.equal(config.writesEnabled, true);
  assert.equal(config.wholesaleWritesEnabled, true);
});
