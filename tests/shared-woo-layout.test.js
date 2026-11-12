import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';
import { proposeProductLayout, renderLayoutDetail, renderLayoutPreview, writePrivateLayoutReports } from '../scripts/preview-shared-woo-layout.mjs';

const row = (name, sku, group = 'Dresses', status = 'available') => ({ name, sku, group, status,
  reviewReasons: status === 'review' ? ['Needs <owner> review.'] : [], priceCents: 999987, reportedQuantity: -123456 });
const fixture = { manifestHash: 'a'.repeat(64), items: [
  row('STYLE BLUE S', '1'), row('STYLE BLUE M', '2'),
  row('STYLE RED S', '3'), row('STYLE RED M', '4'),
  row('PLAIN BLACK M', '5'), row('PLAIN BLACK M', '6'),
  row('STYLE WHITE S', '7', 'Dresses', 'review'), row('STYLE WHITE M', '8'),
  row('YELLOW S', '9'), row('YELLOW M', '10'),
  row('CROSS STYLE S', '11'), row('CROSS STYLE M', '12'), row('CROSS STYLE L', '13', 'Tops'),
  row('PARENT STYLE S', '14'), row('PARENT STYLE M', '15'), row('PARENT STYLE', '16'),
  row('SOLO STYLE L', '17'), row('NO SIZE', '18'),
  row('ANOTHER HELD', '', 'Dresses', 'review'),
  row('ALIAS STYLE 2XL', '20'), row('ALIAS STYLE XXL', '21'),
] };

test('exact style/group/size grouping remains a question, never silently merges colours or ambiguous records', () => {
  const result = proposeProductLayout(fixture);
  assert.deepEqual(result.summary, {
    sourceRows: 21, eligibleRows: 19, heldRows: 2, candidateGroups: 2, candidateRows: 4,
    reviewGroups: 6, reviewEligibleRows: 11, reviewHeldRows: 1, standaloneRows: 4, heldStandaloneRows: 1,
  });
  assert.deepEqual(result.candidates.map(group => group.stem), ['STYLE BLUE', 'STYLE RED'], 'Colours stay separate.');
  assert.match(result.needsReview.find(group => group.stem === 'PLAIN BLACK').issues.join(' '), /Repeated or equivalent/);
  assert.match(result.needsReview.find(group => group.stem === 'STYLE WHITE').issues.join(' '), /held/);
  assert.match(result.needsReview.find(group => group.stem === 'YELLOW').issues.join(' '), /too generic/);
  assert.match(result.needsReview.find(group => group.stem === 'CROSS STYLE').issues.join(' '), /another source group/);
  assert.match(result.needsReview.find(group => group.stem === 'PARENT STYLE').issues.join(' '), /un-sized record/);
  assert.match(result.needsReview.find(group => group.stem === 'ALIAS STYLE').issues.join(' '), /equivalent size/);
  assert.deepEqual(result.standalone.map(item => item.sku), ['13', '16', '17', '18']);
  assert.equal(result.heldStandalone[0].sku, '');
  const included = [
    ...result.candidates.flatMap(group => group.members.map(member => member.sourceRow)),
    ...result.needsReview.flatMap(group => group.members.map(member => member.sourceRow)),
    ...result.standalone.map(item => item.sourceRow), ...result.heldStandalone.map(item => item.sourceRow),
  ];
  assert.deepEqual([...included].sort((a, b) => a - b), Array.from({ length: 21 }, (_, i) => i + 1));
});

test('untrusted names and held reasons cannot inject Markdown/HTML or reveal prices, counts or costs', () => {
  const sample = { manifestHash: 'b'.repeat(64), items: [
    row('TOP <script>| BLUE S', '991', 'Group <svg>|'),
    row('TOP <script>| BLUE M', '992', 'Group <svg>|'),
    row('A [link](evil) *ITEM*', '993', 'Group <svg>|', 'review'),
  ] };
  const result = proposeProductLayout(sample);
  const rendered = renderLayoutPreview(result) + renderLayoutDetail(result);
  assert.match(rendered, /TOP &lt;SCRIPT&gt;\\\| BLUE/);
  assert.match(rendered, /Group &lt;svg&gt;\\\|/);
  assert.match(rendered, /Needs &lt;owner&gt; review/);
  assert.doesNotMatch(rendered, /<script>|<svg>|<owner>|\[link\]\(evil\)/);
  assert.doesNotMatch(rendered, /999987|-123456|priceCents|reportedQuantity|Woo consumer|\bCost\b|Markup/);
  assert.match(rendered, /No product was created or published/);
  assert.match(rendered, /not a Woo category/);
  assert.match(rendered, /shared-woo-layout-detail-v1-b{12}\.md/);
});

test('a held size without a source SKU stays in review and is traceable by source record', () => {
  const result = proposeProductLayout({ manifestHash: 'c'.repeat(64), items: [
    row('GREY TOP S', '7'), row('GREY TOP M', '', 'Dresses', 'review'),
  ] });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.needsReview.length, 1);
  assert.match(renderLayoutDetail(result), /M \(no SKU; source record #2, held: Needs &lt;owner&gt; review\.\)/);
});

test('invalid source hashes, duplicate SKUs and missing eligible identities fail closed', () => {
  assert.throws(() => proposeProductLayout({ ...fixture, manifestHash: 'bad' }), /SHA-256/);
  assert.throws(() => proposeProductLayout({ ...fixture, items: [...fixture.items, row('EXTRA L', '1')] }), /identity/);
  assert.throws(() => proposeProductLayout({ ...fixture, items: [...fixture.items, row('EXTRA L', '')] }), /identity/);
  assert.throws(() => proposeProductLayout({ ...fixture, items: [...fixture.items, { ...row('BAD L', '22'), status: 'unknown' }] }), /identity/);
});

test('actual pinned physical source partitions into tentative groups without importing or disclosing item stock/prices', () => {
  const layout = proposeProductLayout(loadInStoreSnapshot());
  assert.equal(layout.sourceHash, '6e99296585cfa4c475f9a205ca7830a424439d115e30a387298457f38ea35973');
  assert.deepEqual(layout.summary, {
    sourceRows: 1571, eligibleRows: 1530, heldRows: 41, candidateGroups: 344, candidateRows: 1138,
    reviewGroups: 60, reviewEligibleRows: 178, reviewHeldRows: 34, standaloneRows: 214, heldStandaloneRows: 7,
  });
  assert.equal(layout.candidates.some(group => group.members.some(member => member.held)), false);
  assert.equal(layout.candidates.some(group => group.members.some(member => member.sku === '107')), false, 'Duplicate-size stem is never a candidate.');
  assert.equal(layout.needsReview.some(group => group.stem === 'ZARA BLUE DRESS'), true, 'Cross-group product names are held for manual identity review.');
  const report = renderLayoutDetail(layout);
  assert.doesNotMatch(report, /\| (?:Price|Stock|Cost|Tax status|Published) \|/);
  assert.equal(report.includes('194.1177'), false, 'Fractional source price must not leak into the structural preview.');
});

test('private SHA-named Markdown files are 0600, and reruns never overwrite owner notes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-layout-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const layout = proposeProductLayout(fixture);
  const first = writePrivateLayoutReports(layout, path.join(dir, 'output'));
  assert.equal(first.length, 2);
  assert.equal(first.every(file => file.created), true);
  assert.equal(first.every(file => (fs.statSync(file.filename).mode & 0o777) === 0o600), true);
  assert.match(fs.readFileSync(first[0].filename, 'utf8'), /matching `test-results\/shared-woo-layout-detail-v1-a{12}\.md` file/);
  fs.appendFileSync(first[0].filename, '\nOwner note, do not erase.\n');
  const second = writePrivateLayoutReports(layout, path.join(dir, 'output'));
  assert.equal(second.every(file => !file.created), true);
  assert.match(fs.readFileSync(first[0].filename, 'utf8'), /Owner note, do not erase/);
  const symlink = path.join(dir, 'link');
  fs.symlinkSync(path.join(dir, 'output'), symlink);
  assert.throws(() => writePrivateLayoutReports(layout, symlink), /symlink/);
  const script = fileURLToPath(new URL('../scripts/preview-shared-woo-layout.mjs', import.meta.url));
  const wrongArguments = spawnSync(process.execPath, [script, 'not-an-import'], { cwd: dir, encoding: 'utf8' });
  assert.equal(wrongArguments.status, 2);
  assert.match(wrongArguments.stderr, /no arguments/);
});
