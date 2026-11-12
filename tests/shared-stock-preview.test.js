import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';
import { parseWooExport, analyzeSharedStock, renderSharedStockPreview } from '../scripts/plan-shared-woo-catalog.mjs';

const columns = 'ID,Type,SKU,Name,Published,Visibility in catalog,Regular price,Stock,Tax status,Meta: _elementor_data';
const fixture = `${columns}\n12,simple,1434,Private source name,1,visible,1.00,5,none,secret-field\n13,variable,web-only,Online group,1,visible,,10,taxable\n14,variation,,Option,1,visible,, ,parent\n`;
const physical = loadInStoreSnapshot();

test('Woo CSV with omitted trailing metadata parses but duplicate/missing headers and surplus cells fail closed', () => {
  const exportData = parseWooExport(fixture);
  assert.equal(exportData.rows.length, 3);
  assert.equal(exportData.rows[1].SKU, 'web-only');
  assert.equal(exportData.rows[1]['Meta: _elementor_data'], undefined);
  assert.throws(() => parseWooExport('ID,Type,ID\n1,simple,2\n'), /unique headers/);
  assert.throws(() => parseWooExport(`${columns}\n15,simple,sku,Name,1,visible,1.00,1,none,,EXTRA\n`), /CSV_RECORD_INCONSISTENT_COLUMNS/);
  assert.throws(() => parseWooExport('ID,Type,Name\n1,simple,Name\n'), /standard product/);
  assert.throws(() => parseWooExport(columns + '\n'), /empty/);
});

test('offline planner identifies only exact SKU candidates; never guesses a variation or matches by name', () => {
  const exportData = parseWooExport(fixture);
  const result = analyzeSharedStock(physical, exportData);
  assert.equal(result.source.listed, 1571);
  assert.equal(result.source.eligiblePositive, 1206);
  assert.equal(result.source.eligibleZero, 324);
  assert.equal(result.source.quarantined, 41);
  assert.equal(result.source.exactSkuCandidates, 1);
  assert.equal(result.source.eligibleUnmatched, 1529);
  assert.equal(result.woo.parents, 2);
  assert.equal(result.woo.variations, 1);
  assert.equal(result.woo.variationSkus, 0);
  assert.equal(result.woo.taxStatuses.none, 1);
  assert.equal(result.woo.taxStatuses.taxable, 1);
  const text = renderSharedStockPreview(result, { wooHash: 'test-hash', sourceHash: physical.manifestHash });
  assert.match(text, /OFFLINE matching preview/);
  assert.match(text, /no import-ready CSV/);
  assert.doesNotMatch(text, /secret-field|Private source name|Online group/);
});

test('duplicate Woo SKUs are ambiguous and cannot become confirmed links', () => {
  const data = parseWooExport(`${columns}\n12,simple,1434,Name,1,visible,1.00,5,none\n13,variation,1434,Name,1,visible,1.00,5,none\n`);
  const result = analyzeSharedStock(physical, data);
  assert.equal(result.source.exactSkuCandidates, 0);
  assert.equal(result.source.ambiguousSkuCandidates, 1);
  assert.equal(result.woo.duplicateSkus, 1);
});

test('CLI requires a local export and never calls WooCommerce or writes a live import', () => {
  const missingArgument = spawnSync(process.execPath, ['scripts/plan-shared-woo-catalog.mjs'], { encoding: 'utf8' });
  assert.equal(missingArgument.status, 2);
  assert.match(missingArgument.stderr, /Usage:/);
  const missingFile = spawnSync(process.execPath, ['scripts/plan-shared-woo-catalog.mjs', '/missing-woo-export.csv'], { encoding: 'utf8' });
  assert.equal(missingFile.status, 1);
  assert.match(missingFile.stderr, /read-only plan/);
});
