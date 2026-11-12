import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';
import { proposeProductLayout } from '../scripts/preview-shared-woo-layout.mjs';
import { colourIdentity, compareColourLayouts, renderColourComparison, renderSeparateColourPages,
  renderCombinedColourPage, writePrivateColourReports } from '../scripts/compare-shared-woo-colours.mjs';
import { renderColourVisualPreview } from '../scripts/render-shared-woo-colour-html.mjs';

const item = (name, sku, group = 'Dresses', status = 'available') => ({ name, sku, group, status,
  reviewReasons: status === 'review' ? ['Needs <owner> review.'] : [],
  priceCents: 987654, stock: 765432, reportedQuantity: -654321 });
const source = (items, letter = 'a') => ({ manifestHash: letter.repeat(64), items });
const sizeLayout = items => proposeProductLayout(source(items));

test('both choices use exactly the same recorded colour-size SKUs; no missing combination is invented', () => {
  const layout = sizeLayout([
    item('ZARA KNITTED DRESS WINE S', '11', 'Knitted dresses'),
    item('ZARA KNITTED DRESS WINE M', '12', 'Knitted dresses'),
    item('ZARA KNITTED DRESS WINE L', '13', 'Knitted dresses'),
    item('ZARA KNITTED DRESS BLACK S', '14', 'Knitted dresses'),
    item('ZARA KNITTED DRESS BLACK M', '15', 'Knitted dresses'),
    item('SORA SHIRT RED M', '16', 'Shirts'), item('SORA SHIRT RED L', '17', 'Shirts'),
    item('SORA SHIRT WHITE S', '18', 'Shirts'), item('SORA SHIRT WHITE M', '19', 'Shirts'),
  ]);
  const comparison = compareColourLayouts(layout);
  assert.deepEqual(comparison.summary, {
    possibleFamilies: 2, separatePages: 4, sourceSizeRecords: 9,
    reviewFamilies: 0, reviewColourGroups: 0, reviewHeldRecords: 0, unpairedSizeGroups: 0,
  });
  assert.deepEqual(comparison.candidates[0].colourPages.map(page => [page.colour, page.sizes.map(size => [size.size, size.sku])]), [
    ['WINE', [['S', '11'], ['M', '12'], ['L', '13']]],
    ['BLACK', [['S', '14'], ['M', '15']]],
  ]);
  const separate = renderSeparateColourPages(comparison);
  const combined = renderCombinedColourPage(comparison);
  const compare = renderColourComparison(comparison);
  const visual = renderColourVisualPreview(comparison);
  assert.match(separate, /### ZARA KNITTED DRESS WINE/);
  assert.match(separate, /### ZARA KNITTED DRESS BLACK/);
  assert.match(combined, /### ZARA KNITTED DRESS\n/);
  assert.match(combined, /Colour \*\*BLACK\*\* → Size S \(source SKU 14\), M \(source SKU 15\)/);
  assert.doesNotMatch(combined, /BLACK\*\* → Size[^\n]* L /, 'There is no Black L in the source.');
  assert.match(compare, /4 possible colour-specific pages/);
  assert.match(compare, /2 possible combined pages/);
  assert.match(compare, /no missing pair is invented/);
  assert.match(visual, /Option A · 2 page ideas/);
  assert.match(visual, /Option B · 1 page idea/);
  assert.equal((visual.match(/class="page-index">Product page idea/g) || []).length, 2);
  assert.match(visual, /Recorded sizes for BLACK<\/span><div class="chips"><span class="size-chip">S<\/span><span class="size-chip">M<\/span><\/div>/);
  const blackSizes = visual.match(/Recorded sizes for BLACK[\s\S]*?<\/details>/)?.[0];
  assert.ok(blackSizes);
  assert.doesNotMatch(blackSizes, /class="size-chip">L<\/span>/, 'Black L must not be suggested.');
  assert.match(visual, /No missing Colour \+ Size combination has been added/);
  assert.match(visual, /\b9 eligible source records\b/);
  assert.equal(layout.summary.heldRows, 0);
});

test('ambiguous colours, held sizes, generic names, loose rows, cross-group styles and aliases never auto-merge', () => {
  const rows = [
    item('ZARA DRESS PINK S', '1'), item('ZARA DRESS PINK M', '2'),
    item('ZARA DRESS WHITE S', '3', 'Dresses', 'review'), item('ZARA DRESS WHITE M', '4'),
    item('STRIPES BLUE S', '5', 'Shirts'), item('STRIPES BLUE M', '6', 'Shirts'),
    item('STRIPES GREEN S', '7', 'Shirts'), item('STRIPES GREEN M', '8', 'Shirts'),
    item('MESH DRESS BLUE S', '9', 'Mesh'), item('MESH DRESS BLUE M', '10', 'Mesh'),
    item('MESH DRESS RED S', '11', 'Mesh'), item('MESH DRESS RED M', '12', 'Mesh'),
    item('MESH DRESS YELLOW S', '13', 'Mesh', 'review'),
    item('SILK PANTS GREY S', '14', 'Pants'), item('SILK PANTS GREY M', '15', 'Pants'),
    item('SILK PANTS GRAY S', '16', 'Pants'), item('SILK PANTS GRAY M', '17', 'Pants'),
    item('OTHER SHIRT BLUE S', '18', 'Group A'), item('OTHER SHIRT BLUE M', '19', 'Group A'),
    item('OTHER SHIRT RED S', '20', 'Group A'), item('OTHER SHIRT RED M', '21', 'Group A'),
    item('OTHER SHIRT WHITE S', '22', 'Group B'), item('OTHER SHIRT WHITE M', '23', 'Group B'),
    item('WHITE AND BLACK DRESS S', '24'), item('WHITE AND BLACK DRESS M', '25'),
    item('RED DRESS S', '26'), item('RED DRESS M', '27'),
    item('BLACK SORA SHIRT S', '28'), item('BLACK SORA SHIRT M', '29'),
    item('SORA SHIRT RED S', '30'), item('SORA SHIRT RED M', '31'),
  ];
  const comparison = compareColourLayouts(sizeLayout(rows));
  assert.equal(comparison.candidates.length, 0);
  assert.equal(comparison.needsReview.length, 5);
  const issues = new Map(comparison.needsReview.map(family => [family.base, family.issues.join(' ')]));
  assert.match(issues.get('ZARA DRESS'), /ambiguous\/held/);
  assert.match(issues.get('STRIPES'), /generic/);
  assert.match(issues.get('MESH DRESS'), /single-size or un-sized/);
  assert.match(issues.get('SILK PANTS'), /equivalent spelling/);
  assert.match(issues.get('OTHER SHIRT'), /another source group/);
  assert.equal(colourIdentity('WHITE AND BLACK DRESS', 'Dresses'), null, 'Multiple colour words are not guessed.');
  assert.notEqual(colourIdentity('BLACK SORA SHIRT', 'Dresses').key, colourIdentity('SORA SHIRT RED', 'Dresses').key,
    'Reordered colour positions never make an automatic family.');
  assert.equal(colourIdentity('ZARA DRESS BLUE-BLACK', 'Dresses'), null, 'Compound colours are not guessed.');
  assert.match(renderCombinedColourPage(comparison), /Unpaired source record #13 \(held: Needs &lt;owner&gt; review\.\)/);
  assert.equal(comparison.summary.reviewHeldRecords, 2);
});

test('an uncoloured row, compound colour or reordered multiword colour blocks an incomplete family', () => {
  const comparison = compareColourLayouts(sizeLayout([
    item('ZARA KNITTED DRESS WINE S', '1'), item('ZARA KNITTED DRESS WINE M', '2'),
    item('ZARA KNITTED DRESS BLACK S', '3'), item('ZARA KNITTED DRESS BLACK M', '4'),
    item('ZARA KNITTED DRESS BLUE-BLACK S', '5'), item('ZARA KNITTED DRESS BLUE-BLACK M', '6'),
    item('SORA SHIRT RED S', '7'), item('SORA SHIRT RED M', '8'),
    item('SORA SHIRT WHITE S', '9'), item('SORA SHIRT WHITE M', '10'),
    item('SORA SHIRT', '11'),
    item('MESH TOP BLUE S', '12'), item('MESH TOP BLUE M', '13'),
    item('MESH TOP RED S', '14'), item('MESH TOP RED M', '15'),
    item('ARMY GREEN MESH TOP S', '16'), item('ARMY GREEN MESH TOP M', '17'),
    item('ZARA NECK STONED TOP BLACK M', '18'), item('ZARA NECK STONED TOP BLACK L', '19'),
    item('ZARA NECK STONED TOP WHITE S', '20'), item('ZARA NECK STONED TOP WHITE M', '21'),
  ]));
  assert.equal(comparison.candidates.length, 1);
  assert.equal(comparison.candidates[0].base, 'ZARA NECK STONED TOP');
  assert.equal(comparison.needsReview.length, 3);
  const related = new Map(comparison.needsReview.map(family => [family.base, family.related]));
  assert.deepEqual(related.get('ZARA KNITTED DRESS').map(item => item.stem), ['ZARA KNITTED DRESS BLUE-BLACK']);
  assert.deepEqual(related.get('SORA SHIRT').map(item => item.stem), ['SORA SHIRT']);
  assert.deepEqual(related.get('MESH TOP').map(item => item.stem), ['ARMY GREEN MESH TOP']);
  assert.match(renderCombinedColourPage(comparison), /Related size group starting #5: ZARA KNITTED DRESS BLUE-BLACK/);
  assert.match(renderColourVisualPreview(comparison), /Related single row starting #11: SORA SHIRT/);
});

test('product text and review reasons are escaped; price, stock and raw Woo fields never leak', () => {
  const sourceRows = [
    item('TOP <script>| BLUE S', '991', 'Group <svg>|'), item('TOP <script>| BLUE M', '992', 'Group <svg>|'),
    item('TOP <script>| RED S', '993', 'Group <svg>|'), item('TOP <script>| RED M', '994', 'Group <svg>|'),
  ];
  const report = compareColourLayouts(proposeProductLayout(source(sourceRows, 'b')));
  const text = renderColourComparison(report) + renderSeparateColourPages(report) + renderCombinedColourPage(report);
  const visual = renderColourVisualPreview(report);
  assert.match(text, /TOP &lt;SCRIPT&gt;\\\|/);
  assert.match(text, /Group &lt;svg&gt;\\\|/);
  assert.doesNotMatch(text, /<script>|<svg>|987654|765432|-654321|priceCents|reportedQuantity|\bCost\b|Markup|consumer_secret/);
  assert.match(text, /Neither option calls WooCommerce/);
  assert.match(text, /No webpage or draft product has been created/);
  assert.match(visual, /TOP &lt;SCRIPT&gt;\|/);
  assert.match(visual, /Group &lt;svg&gt;\|/);
  assert.match(visual, /default-src 'none'/);
  assert.doesNotMatch(visual, /<script|<svg|<form|<button|<input|fetch\(|987654|765432|-654321|priceCents|reportedQuantity|consumer_secret/);
});

test('pinned physical source yields a limited, disjoint colour comparison with all 41 held records still held', () => {
  const layout = proposeProductLayout(loadInStoreSnapshot());
  const comparison = compareColourLayouts(layout);
  assert.deepEqual(comparison.summary, {
    possibleFamilies: 20, separatePages: 58, sourceSizeRecords: 180,
    reviewFamilies: 44, reviewColourGroups: 125, reviewHeldRecords: 13, unpairedSizeGroups: 221,
  });
  assert.equal(comparison.sourceSummary.eligibleRows, 1530);
  assert.equal(comparison.sourceSummary.heldRows, 41);
  assert.equal(comparison.candidates.some(family => family.colourPages.some(page => page.sizes.some(size => size.held))), false);
  assert.deepEqual(comparison.needsReview.find(family => family.base === 'ZARA KNITTED DRESS')?.related
    .filter(item => item.sourceGroup === 'ZARA KNITTED DRESSES').map(item => item.stem),
  ['ZARA KNITTED DRESS BLUE-BLACK', 'ZARA KNITTED DRESS COFFE BROWN', 'ZARA KNITTED BUTTER YELLOW DRESS']);
  assert.deepEqual(comparison.candidates.find(family => family.base === 'ZARA NECK STONED TOP')?.colourPages
    .map(page => [page.colour, page.sizes.map(size => size.size)]),
  [['BLACK', ['M', 'L']], ['WHITE', ['S', 'M', 'L']]]);
  assert.match(renderColourComparison(comparison), /20 strict-name-match but \*\*unconfirmed\*\* colour families/);
  assert.match(renderColourVisualPreview(comparison), /41<\/strong><span>held source records/);
  assert.doesNotMatch(renderCombinedColourPage(comparison) + renderColourVisualPreview(comparison), /194\.1177/);
});

test('private alternatives are SHA-named 0600 files; rerun cannot erase an owner decision or follow a symlink', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-colour-preview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const comparison = compareColourLayouts(sizeLayout([
    item('ZARA KNITTED DRESS WINE S', '1'), item('ZARA KNITTED DRESS WINE M', '2'),
    item('ZARA KNITTED DRESS BLACK S', '3'), item('ZARA KNITTED DRESS BLACK M', '4'),
  ]));
  const outputDir = path.join(dir, 'output');
  const files = writePrivateColourReports(comparison, outputDir);
  assert.equal(files.length, 4);
  assert.equal(files.every(file => file.created && (fs.statSync(file.filename).mode & 0o777) === 0o600), true);
  assert.equal(files.slice(0, 3).every(file => file.filename.endsWith(`v2-${'a'.repeat(12)}.md`)), true);
  assert.equal(files[3].filename.endsWith(`v2-${'a'.repeat(12)}.html`), true);
  fs.appendFileSync(files[1].filename, '\nOwner chose separate pages for this example.\n');
  const again = writePrivateColourReports(comparison, outputDir);
  assert.equal(again.every(file => !file.created), true);
  assert.match(fs.readFileSync(files[1].filename, 'utf8'), /Owner chose separate pages/);
  const link = path.join(dir, 'link');
  fs.symlinkSync(outputDir, link);
  assert.throws(() => writePrivateColourReports(comparison, link), /symlink/);
  const script = fileURLToPath(new URL('../scripts/compare-shared-woo-colours.mjs', import.meta.url));
  const invalid = spawnSync(process.execPath, [script, '--publish'], { cwd: dir, encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /no arguments/);
});
