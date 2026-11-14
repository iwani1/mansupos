// Executes the PHP bridge callbacks with disposable synthetic WP/Woo stubs.
// No real Woo/HPOS/InnoDB/gateway, network, product, stock or customer data.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve('test-results/phase2-php-runtime/node_modules');
if (!fs.existsSync(root)) {
  console.error('Install the ignored local PHP runtime: npm install --no-save --no-package-lock --ignore-scripts --prefix test-results/phase2-php-runtime @php-wasm/node@3.1.64');
  process.exit(2);
}
const { PHP } = await import(pathToFileURL(`${root}/@php-wasm/universal/index.js`));
const { loadNodeRuntime } = await import(pathToFileURL(`${root}/@php-wasm/node/index.js`));
const fixture = fs.readFileSync('tests/fixtures/phase2-php-flow.php', 'utf8');
const plugin = fs.readFileSync('woocommerce/mansu-online-bridge/mansu-online-bridge.php', 'utf8').replace(/^<\?php/, '');
let exit = 1;
try {
  const php = new PHP(await loadNodeRuntime('8.2', { emscriptenOptions: { processId: 70202 } }));
  const result = await php.runStream({ code: fixture.replace('/* @INSERT_BRIDGE_PLUGIN@ */', plugin) });
  const stdout = await result.stdoutText;
  const stderr = await result.stderrText;
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  exit = stdout.includes('PHP_FLOW_SYNTHETIC_OK') && !stderr ? 0 : 1;
} catch (error) { console.error(error); }
process.exit(exit); // Standalone wasm process: its async workers otherwise outlive the script.
