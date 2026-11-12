#!/usr/bin/env node
// OFFLINE review only. No WooCommerce API calls, import CSV, or product/stock writes.
// Use the authenticated, source-hash-validated physical catalogue and a
// products-only WooCommerce CSV export to measure what an owner must reconcile.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';

const required = ['ID', 'Type', 'SKU', 'Name', 'Published', 'Visibility in catalog', 'Regular price', 'Stock', 'Tax status'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const skuKey = sku => String(sku || '').trim().toLocaleUpperCase('en');
const nameKey = name => String(name || '').trim().toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, ' ').trim();
const isParent = row => row.Type === 'simple' || row.Type === 'variable';

export function parseWooExport(input) {
  let columns;
  let rows;
  try {
    rows = parse(input, {
      bom: true, skip_empty_lines: true, max_record_size: 1024 * 1024,
      // Woo's native exporter omits trailing, empty metadata cells on many rows.
      // Missing *trailing* cells are safe; reject extra cells or duplicate headers.
      relax_column_count_less: true,
      columns(headers) {
        columns = headers;
        if (new Set(headers).size !== headers.length || required.some(column => !headers.includes(column))) {
          throw new Error('Woo export needs unique headers and the standard product ID, type, SKU, name, status, price, stock and tax columns.');
        }
        return headers;
      },
    });
  } catch (error) {
    // CSV parser errors can include a whole raw row, including plugin metadata.
    if (typeof error.code === 'string' && error.code.startsWith('CSV_')) {
      throw new Error(`Woo CSV parsing failed (${error.code}, near line ${Number(error.lines) || '?'}). No raw product data was printed.`);
    }
    throw error;
  }
  if (!columns || !rows.length) throw new Error('Woo product export is empty.');
  return { columns, rows };
}

export function analyzeSharedStock(physical, woo) {
  if (!Array.isArray(physical?.items) || !Array.isArray(woo?.rows)) throw new Error('Expected the verified physical catalogue and a parsed Woo products export.');
  const parents = woo.rows.filter(isParent);
  const variations = woo.rows.filter(row => row.Type === 'variation');
  const wooBySku = new Map();
  const wooIds = new Set();
  let duplicateWooIds = 0;
  let invalidWooIds = 0;
  for (const row of woo.rows) {
    const id = String(row.ID || '').trim();
    if (!/^[1-9]\d*$/.test(id)) invalidWooIds++;
    else if (wooIds.has(id)) duplicateWooIds++;
    else wooIds.add(id);
    const key = skuKey(row.SKU);
    if (!key) continue;
    if (!wooBySku.has(key)) wooBySku.set(key, []);
    wooBySku.get(key).push(row);
  }
  const duplicateWooSkus = [...wooBySku.values()].filter(rows => rows.length > 1).length;
  const sourceKeys = new Set();
  let duplicateSourceSkus = 0;
  let exactSkuCandidates = 0;
  let ambiguousSkuCandidates = 0;
  let eligibleUnmatched = 0;
  let eligiblePositiveUnmatched = 0;
  let eligibleZeroUnmatched = 0;
  let quarantined = 0;
  let eligibleZero = 0;
  let eligiblePositive = 0;
  for (const item of physical.items) {
    const key = skuKey(item.sku);
    if (key && sourceKeys.has(key)) duplicateSourceSkus++;
    else if (key) sourceKeys.add(key);
    if (item.status === 'review') { quarantined++; continue; }
    if (item.status === 'out_of_stock') eligibleZero++;
    else if (item.status === 'available') eligiblePositive++;
    else throw new Error('Unexpected physical item status.');
    // An identical SKU is only a possible identity match, NOT permission to
    // overwrite an existing Woo product. A missing/duplicate SKU stays held.
    if (!key) { ambiguousSkuCandidates++; continue; }
    const matches = wooBySku.get(key) || [];
    if (matches.length === 1) exactSkuCandidates++;
    else if (matches.length > 1) ambiguousSkuCandidates++;
    else {
      eligibleUnmatched++;
      if (item.status === 'out_of_stock') eligibleZeroUnmatched++;
      else eligiblePositiveUnmatched++;
    }
  }
  const wooNames = new Set(parents.map(row => nameKey(row.Name)).filter(Boolean));
  const sourceNames = new Set(physical.items.map(item => nameKey(item.name)).filter(Boolean));
  const parentTaxStatuses = {};
  for (const row of parents) {
    const raw = String(row['Tax status'] || '').trim().toLowerCase();
    // Only render fixed labels: exports can contain untrusted HTML/metadata.
    const key = ['taxable', 'shipping', 'none'].includes(raw) ? raw : '(other/blank)';
    parentTaxStatuses[key] = (parentTaxStatuses[key] || 0) + 1;
  }
  return {
    source: {
      listed: physical.items.length, coded: sourceKeys.size, duplicateSkus: duplicateSourceSkus,
      eligiblePositive, eligibleZero, quarantined,
      eligibleUnmatched, eligiblePositiveUnmatched, eligibleZeroUnmatched,
      exactSkuCandidates, ambiguousSkuCandidates,
    },
    woo: {
      rows: woo.rows.length, parents: parents.length, simple: parents.filter(row => row.Type === 'simple').length,
      variable: parents.filter(row => row.Type === 'variable').length, variations: variations.length,
      skuRows: woo.rows.filter(row => skuKey(row.SKU)).length,
      variationSkus: variations.filter(row => skuKey(row.SKU)).length,
      duplicateSkus: duplicateWooSkus, duplicateIds: duplicateWooIds, invalidIds: invalidWooIds,
      otherTypes: woo.rows.length - parents.length - variations.length,
      parentStockFields: parents.filter(row => String(row.Stock || '').trim()).length,
      blankVariationRegularPrices: variations.filter(row => !String(row['Regular price'] || '').trim()).length,
      publishedParents: parents.filter(row => String(row.Published || '').trim() === '1').length,
      visibleParents: parents.filter(row => String(row['Visibility in catalog'] || '').trim() === 'visible').length,
      taxStatuses: parentTaxStatuses,
      metadataColumns: (woo.columns || []).filter(column => column.startsWith('Meta:')).length,
    },
    exactNormalizedNameCandidates: [...sourceNames].filter(name => wooNames.has(name)).length,
  };
}

export function renderSharedStockPreview(analysis, { wooHash = '', sourceHash = '' } = {}) {
  const { source, woo } = analysis;
  return `# Shared WooCommerce stock: OFFLINE matching preview

**NO IMPORT / NO LIVE CHANGE.** This report never calls WooCommerce, changes stock, creates products or enables POS sales. The current In-store section reads a historical PDF snapshot, NOT Woo availability. The POS-only in-store cash gate must stay locked. Re-run this preview on a fresh export before any separately approved cutover.

Source SHA-256: \`${sourceHash || 'not supplied'}\`. Woo export SHA-256: \`${wooHash || 'not supplied'}\`. These identify input bytes, not a fresh physical count or a current Woo balance.

| Check | Count |
| --- | ---: |
| In-store source records | ${source.listed} |
| Eligible with positive reported PDF stock | ${source.eligiblePositive} |
| Eligible with zero reported PDF stock (not sellable) | ${source.eligibleZero} |
| Quarantined pending identity/unit/count/price review | ${source.quarantined} |
| Woo product rows | ${woo.rows} |
| Woo parent products (simple / variable) | ${woo.parents} (${woo.simple} / ${woo.variable}) |
| Woo variations with populated SKU | ${woo.variationSkus} / ${woo.variations} |
| Exact SKU matches (identity *candidates*, not approved links) | ${source.exactSkuCandidates} |
| Eligible source items with no exact SKU match | ${source.eligibleUnmatched} (${source.eligiblePositiveUnmatched} positive; ${source.eligibleZeroUnmatched} zero) |
| Eligible source items with missing/ambiguous SKU | ${source.ambiguousSkuCandidates} |
| Duplicate Woo SKUs / IDs / invalid IDs | ${woo.duplicateSkus} / ${woo.duplicateIds} / ${woo.invalidIds} |
| Exact normalized parent-name matches (NOT safe links) | ${analysis.exactNormalizedNameCandidates} |

Woo parent tax-status counts: ${Object.entries(woo.taxStatuses).map(([key, count]) => `\`${key}\`: ${count}`).join('; ') || 'none'}. Parent stock fields: ${woo.parentStockFields} / ${woo.parents}. Blank variation regular prices: ${woo.blankVariationRegularPrices}. The export contains ${woo.metadataColumns} metadata columns; **do not copy raw metadata to a public import or POS API**.

## Why the plan is blocked

- A matching SKU alone is not enough to merge two stock pools; an owner must confirm whether an existing Woo product is the same physical item. Zero matches do not prove there are no duplicates. Never map by name, price or barcode guesswork, or add all unmatched goods automatically.
- CSV prices are proposed **retail** website amounts, but the owner plans to review prices later. The PDF/export counts are historical; obtain a fresh physical count and reconcile pending online orders at cutover. Never seed stock or publish products from this preview.
- Keep the ${source.quarantined} quarantined items held, including the unidentified code, negative counts, malformed units and fractional-cent prices. Eligible zero-stock products cannot be purchased while zero.
- Website-ready listings need reviewed product identity, images/descriptions, categories, shipping and tax settings. Verify that Woo charges the intended final all-in GHS retail price. A POS wholesale quote is a **per-sale** negotiated gross price and must not overwrite Woo's retail product price.
- Use a separately approved Woo-backed wholesale cash order to reduce shared Woo stock once. The legacy local POS-only in-store cash path would cause two competing stock counts. Actual Woo pending/paid hooks, notifications, last-unit concurrency, tax, recovery and backups need review before a real sale.

**Next input:** an owner-approved SKU/variation crosswalk (or explicit confirmation that no existing Woo goods overlap), plus corrected exceptions, reviewed retail prices, website product content/tax rules and cutover counts. This tool deliberately produces no import-ready CSV and makes no remote requests.
`;
}

function main() {
  if (process.argv.length !== 3 || !process.argv[2] || process.argv[2].startsWith('-')) {
    console.error('Usage: node scripts/plan-shared-woo-catalog.mjs path/to/woo-products-export.csv');
    process.exitCode = 2;
    return;
  }
  try {
    const filename = path.resolve(process.argv[2]);
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Woo export must be a local file under 64 MiB.');
    const bytes = fs.readFileSync(filename);
    const woo = parseWooExport(bytes);
    const physical = loadInStoreSnapshot();
    const analysis = analyzeSharedStock(physical, woo);
    process.stdout.write(renderSharedStockPreview(analysis, { wooHash: sha256(bytes), sourceHash: physical.manifestHash }));
  } catch (error) {
    console.error(`Unable to make a read-only plan: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
