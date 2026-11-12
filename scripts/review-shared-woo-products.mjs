#!/usr/bin/env node
// Offline, private identity worksheet. NOT a WooCommerce import file: it omits
// prices, quantities, tax, publication fields, category mapping and metadata.
// Never use a historical PDF balance to seed Woo stock or create an order.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';
import { analyzeSharedStock, parseWooExport } from './plan-shared-woo-catalog.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const skuKey = value => String(value || '').trim().toLocaleUpperCase('en');
// Product names come from a CSV and must never inject HTML or Markdown links
// into a review report that might later be opened in a browser.
const cell = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replace(/\r|\n|\t/g, ' ').replaceAll('\\', '\\\\')
  .replaceAll('|', '\\|').replaceAll('`', '\\`').replaceAll('[', '\\[')
  .replaceAll(']', '\\]').replaceAll('*', '\\*').replaceAll('_', '\\_').trim();

export function buildIdentityReview(physical, woo, { wooHash = '' } = {}) {
  const analysis = analyzeSharedStock(physical, woo);
  if (analysis.source.duplicateSkus || analysis.woo.invalidIds || analysis.woo.duplicateIds || analysis.woo.duplicateSkus) {
    throw new Error('An input contains duplicate source/Woo SKUs or invalid/duplicate Woo IDs. Resolve identity conflicts before producing an item worksheet.');
  }
  const wooSkuIds = new Map(woo.rows.filter(row => skuKey(row.SKU)).map(row => [skuKey(row.SKU), row.ID]));
  const rows = physical.items.map((item, index) => {
    const collision = wooSkuIds.get(skuKey(item.sku));
    const state = item.status === 'review' ? 'Held source record'
      : collision ? 'Woo SKU collision — hold' : 'Unlinked candidate — identity review';
    return {
      sourceRow: index + 1, reportRow: item.reportRow, sku: item.sku,
      name: item.name, group: item.group, state,
      wooId: collision || '',
      // Do not output the source quantity, CSV price or Woo metadata. A held
      // reason is actionable without treating the historical count as stock.
      reason: item.status === 'review' ? item.reviewReasons.join(' ') : '',
    };
  });
  return { rows, analysis, wooHash, sourceHash: physical.manifestHash || '' };
}

export function renderIdentityReview(review) {
  const held = review.rows.filter(row => row.state === 'Held source record');
  const collisions = review.rows.filter(row => row.state === 'Woo SKU collision — hold');
  const proposed = review.rows.filter(row => row.state === 'Unlinked candidate — identity review');
  const table = rows => rows.map(row => `| ${row.sourceRow} | ${row.reportRow || 'unknown'} | ${cell(row.sku) || 'MISSING'} | ${cell(row.name)} | ${cell(row.group)} | ${cell(row.state)} | ${cell(row.wooId) || '—'} | ${cell(row.reason) || '—'} |`).join('\n');
  const header = '| CSV row | PDF row | Source SKU | Source name | Source group | Review state | Existing Woo ID if SKU collision | Reason to resolve |\n| ---: | ---: | --- | --- | --- | --- | ---: | --- |';
  return `# PRIVATE product identity worksheet — NOT an import

**No WooCommerce calls or writes.** This is an offline identity *review*, not a Woo CSV, crosswalk, approval, price list or stock count. Do not import it, publish products, change retail prices or set stock from it. The PDF and the Woo CSV export are historical. The POS-only In-store cash gate remains locked; actual shop checkout must use a separately accepted Woo-backed order.

Physical snapshot manifest SHA-256: \`${cell(review.sourceHash) || 'not supplied'}\`. Woo CSV SHA-256: \`${cell(review.wooHash) || 'not supplied'}\`. Re-run with a fresh export before identity approval; compare against Woo again before import. The owner confirms the **115 existing exported parents are different** from the physical goods, but any SKU collision still needs manual resolution.

- Source records: ${review.rows.length}; unlinked identity candidates: ${proposed.length}; held source records: ${held.length}; Woo SKU collisions: ${collisions.length}.
- **Never create directly from these rows.** Review identities (including variations and new products), titles, photos/descriptions, categories/shipping, tax and retail amounts separately. Obtain a *fresh* physical count and reconcile online orders before setting Woo stock. If a Woo listing changes, refresh this worksheet; it is not a live stock display.
- This file intentionally has **no per-item prices or stock quantities**, publish flags, tax settings or import-ready columns. Keep it private; the raw Woo export remains excluded from branch head, builds and runtime images. The earlier public Git commit containing that export remains in history pending separate review.

## Unlinked source goods — identities need review

${header}
${table(proposed)}

## Held source records and SKU collisions — do not stage

${header}
${table([...held, ...collisions].sort((a, b) => a.sourceRow - b.sourceRow))}
`;
}

function main() {
  if (process.argv.length !== 3 || !process.argv[2] || process.argv[2].startsWith('-')) {
    console.error('Usage: node scripts/review-shared-woo-products.mjs path/to/private/woo-products-export.csv');
    process.exitCode = 2;
    return;
  }
  try {
    const filename = path.resolve(process.argv[2]);
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Woo export must be a local file under 64 MiB.');
    const bytes = fs.readFileSync(filename);
    const review = buildIdentityReview(loadInStoreSnapshot(), parseWooExport(bytes), { wooHash: sha256(bytes) });
    const outputDir = path.join(projectRoot, 'test-results'); // excluded by .gitignore and .dockerignore
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(outputDir).isDirectory()) throw new Error('Review output directory must not be a symlink.');
    const name = `shared-stock-item-review-${review.wooHash.slice(0, 12)}.md`;
    const output = path.join(outputDir, name);
    // A fresh export gets a fresh worksheet. Never overwrite a review that
    // might contain an owner's manual decisions, or follow an existing link.
    if (fs.existsSync(output)) {
      if (!fs.lstatSync(output).isFile()) throw new Error('Review output is not a regular file.');
      console.log(`Private review already exists: test-results/${name}. It was not overwritten.`);
      return;
    }
    fs.writeFileSync(output, renderIdentityReview(review), { mode: 0o600, flag: 'wx' });
    console.log(`Offline review written to test-results/${name}; no Woo request, import, stock or price change was made.`);
  } catch (error) {
    console.error(`Unable to make a private identity worksheet: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
