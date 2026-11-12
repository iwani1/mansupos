import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildIdentityReview, renderIdentityReview } from '../scripts/review-shared-woo-products.mjs';

const script = fileURLToPath(new URL('../scripts/review-shared-woo-products.mjs', import.meta.url));
const physical = { manifestHash: 'fixture', items: [
  { sku: '11', name: 'Safe <script>| Item', group: 'Group', status: 'available', reportRow: 1, priceCents: 9099, reportedQuantity: 17, reviewReasons: [] },
  { sku: '12', name: 'Needs review', group: 'Group', status: 'review', reportRow: 2, priceCents: 1200, reportedQuantity: -7, reviewReasons: ['<danger> & recount.'] },
  { sku: '13', name: 'Other', group: 'Group', status: 'out_of_stock', reportRow: 3, priceCents: 3010, reportedQuantity: 0, reviewReasons: [] },
] };
const woo = { columns: ['ID', 'Type', 'SKU', 'Name', 'Published', 'Visibility in catalog', 'Regular price', 'Stock', 'Tax status'], rows: [
  { ID: '55', Type: 'simple', SKU: '13', Name: 'Not the same item', Published: '1', 'Visibility in catalog': 'visible', 'Regular price': '200.75', Stock: '6', 'Tax status': 'none' },
] };

test('private identity worksheet holds exceptions and Woo SKU collisions without leaking prices, counts or raw markup', () => {
  const review = buildIdentityReview(physical, woo, { wooHash: 'woo-fixture' });
  assert.deepEqual(review.rows.map(row => row.state), ['Unlinked candidate — identity review', 'Held source record', 'Woo SKU collision — hold']);
  assert.equal(review.rows[2].wooId, '55');
  const output = renderIdentityReview(review);
  assert.match(output, /Safe &lt;script&gt;\\\| Item/);
  assert.match(output, /&lt;danger&gt; &amp; recount/);
  assert.match(output, /\| 3 \| 3 \| 13 \| Other.*Woo SKU collision — hold \| 55 \|/);
  for (const secret of ['9099', '1200', '3010', '200.75', '-7', '17', '<script>', '<danger>']) {
    assert.equal(output.includes(secret), false, `the worksheet cannot disclose item count, price, or raw HTML: ${secret}`);
  }
  assert.doesNotMatch(output, /\| (?:Stock|Price|Tax status|Published|Visibility in catalog) \|/);
});

test('worksheet refuses duplicated Woo identity and source SKU instead of proposing imports', () => {
  assert.throws(() => buildIdentityReview(physical, { ...woo, rows: [...woo.rows, { ...woo.rows[0], ID: '56' }] }), /duplicate/);
  assert.throws(() => buildIdentityReview(physical, { ...woo, rows: [...woo.rows, { ...woo.rows[0], SKU: '999' }] }), /duplicate/);
  assert.throws(() => buildIdentityReview(physical, { ...woo, rows: [{ ...woo.rows[0], ID: 'invalid' }] }), /invalid/);
  assert.throws(() => buildIdentityReview({ ...physical, items: [...physical.items, { ...physical.items[0] }] }, woo), /duplicate/);
});

test('CLI only writes an ignored, private Markdown review from a local export; it never needs Woo credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-woo-item-review-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const exportPath = path.join(root, 'products.csv');
  const bytes = `${woo.columns.join(',')}\n55,simple,not-source,Other-${randomUUID()},1,visible,200.75,6,none\n`;
  fs.writeFileSync(exportPath, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const output = fileURLToPath(new URL(`../test-results/shared-stock-item-review-${hash}.md`, import.meta.url));
  t.after(() => fs.rmSync(output, { force: true }));
  const result = spawnSync(process.execPath, [script, exportPath], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Offline review written/);
  assert.equal(fs.existsSync(path.join(root, 'test-results')), false, 'Output remains anchored to the ignored project directory.');
  const text = fs.readFileSync(output, 'utf8');
  assert.match(text, /Source records: 1571; unlinked identity candidates: 1530; held source records: 41/);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.doesNotMatch(text, /\bCost\b|Markup|Meta:|WooCommerce API key/);
  fs.appendFileSync(output, '\nOwner review notes are not disposable.\n');
  const repeated = spawnSync(process.execPath, [script, exportPath], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /not overwritten/);
  assert.match(fs.readFileSync(output, 'utf8'), /Owner review notes are not disposable/);
});
