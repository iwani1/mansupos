// Executes the uninstalled online Woo plugin against synthetic PHP fixtures.
// It cannot access WordPress, WooCommerce, MySQL, customer data or any network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const marker = '/* @INSERT_BRIDGE_PLUGIN@ */';
const fixture = fs.readFileSync('tests/fixtures/phase2-php-flow.php', 'utf8');
const plugin = fs.readFileSync('woocommerce/mansu-online-bridge/mansu-online-bridge.php', 'utf8')
  .replace('<?php', '');
if (fixture.split(marker).length !== 2) throw new Error('The synthetic fixture insertion marker is missing or repeated.');
if (plugin.includes(marker)) throw new Error('Unexpected recursive fixture marker in bridge plugin.');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-online-php-'));
const filename = path.join(directory, 'synthetic-online-bridge.php');
try {
  fs.writeFileSync(filename, fixture.replace(marker, plugin), { mode: 0o600 });
  const result = spawnSync('php', [filename], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const match = /PHP_FLOW_SYNTHETIC_OK ([0-9]+) checks on PHP/.exec(result.stdout || '');
  if (result.status !== 0 || !match || Number(match[1]) < 40) {
    throw new Error('The synthetic PHP bridge callback flow failed or did not complete all required checks.');
  }
  console.log('Synthetic PHP callbacks passed; NOT a real WordPress/MySQL last-unit or Paystack test.');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
