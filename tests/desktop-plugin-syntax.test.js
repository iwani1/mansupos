import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import PhpParser from 'php-parser';

const plugin = new URL('../woocommerce/mansu-offline-reservations/mansu-offline-reservations.php', import.meta.url);

test('the uninstalled Woo reservation plugin parses as PHP; use php -l if the runtime exists', () => {
  const source = fs.readFileSync(plugin, 'utf8');
  const parser = new PhpParser({ parser: { extractDoc: true, php7: true, suppressErrors: false } });
  assert.doesNotThrow(() => parser.parseCode(source, plugin.pathname));
  const php = spawnSync('php', ['-l', plugin.pathname], { encoding: 'utf8' });
  if (php.error?.code === 'ENOENT') return; // Parser check still runs on minimal build hosts.
  if (php.error) throw php.error;
  assert.equal(php.status, 0, `${php.stdout}\n${php.stderr}`);
});
