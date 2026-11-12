#!/usr/bin/env node
// Offline product-structure review only. No Woo API, Woo import, stock, price,
// publication, or POS checkout changes. Exact name/group/size proposals are NOT
// approved product identities; they are questions for the owner to check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const LAYOUT_RULE_VERSION = 'v1';
const suffix = /^(.*?)\s+(XS|S|M|L|XL|XXL|XXXL|[2-6]XL)$/u;
const sizeRank = new Map(['XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL', 'XXXL', '4XL', '5XL', '6XL'].map((size, index) => [size, index]));
const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim().toLocaleUpperCase('en');
const canonicalSize = size => ({ XXL: '2XL', XXXL: '3XL' })[size] || size;
const cell = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replace(/\r|\n|\t/g, ' ').replaceAll('\\', '\\\\')
  .replaceAll('|', '\\|').replaceAll('`', '\\`').replaceAll('[', '\\[')
  .replaceAll(']', '\\]').replaceAll('*', '\\*').replaceAll('_', '\\_').trim();

export function proposeProductLayout(snapshot) {
  if (!/^[a-f0-9]{64}$/.test(snapshot?.manifestHash || '') || !Array.isArray(snapshot.items)) {
    throw new Error('A SHA-256-verified physical source snapshot is required.');
  }
  const seenSkus = new Set();
  const records = snapshot.items.map((item, index) => {
    if (!['available', 'out_of_stock', 'review'].includes(item.status) ||
        (item.status !== 'review' && !item.sku) || (item.sku && seenSkus.has(item.sku))) {
      throw new Error('Source identity or review status is not safe to group.');
    }
    if (item.sku) seenSkus.add(item.sku);
    const name = normalize(item.name);
    const group = normalize(item.group);
    const match = suffix.exec(name);
    return { sourceRow: index + 1, sku: item.sku, name: item.name, group: item.group,
      keyGroup: group, keyName: name, stem: match?.[1] || '', size: match?.[2] || '',
      held: item.status === 'review', reasons: item.status === 'review' ? [...item.reviewReasons] : [] };
  });
  const buckets = new Map();
  const groupsByStem = new Map();
  const namesByGroup = new Set(records.map(record => JSON.stringify([record.keyGroup, record.keyName])));
  for (const record of records) {
    if (!record.stem) continue;
    const key = JSON.stringify([record.keyGroup, record.stem]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
    if (!groupsByStem.has(record.stem)) groupsByStem.set(record.stem, new Set());
    groupsByStem.get(record.stem).add(record.keyGroup);
  }
  const groupedRows = new Set();
  const candidates = [], needsReview = [];
  for (const [key, members] of buckets) {
    if (members.length < 2) continue;
    const [keyGroup, stem] = JSON.parse(key);
    const issues = [];
    if (members.some(item => item.held)) issues.push('One or more size records are held; do not silently omit them.');
    if (new Set(members.map(item => canonicalSize(item.size))).size !== members.length) {
      issues.push('Repeated or equivalent size labels need an identity check.');
    }
    if (stem.split(' ').length < 2) issues.push('Single-word style name is too generic to group safely.');
    if (groupsByStem.get(stem).size > 1) issues.push('The same style name occurs in another source group; check for duplicates.');
    if (namesByGroup.has(JSON.stringify([keyGroup, stem]))) issues.push('An un-sized record has the same style name in this source group.');
    const ordered = [...members].sort((a, b) => sizeRank.get(a.size) - sizeRank.get(b.size) || a.sourceRow - b.sourceRow);
    const group = { stem, sourceGroup: members[0].group, firstRow: Math.min(...members.map(item => item.sourceRow)),
      members: ordered.map(({ sourceRow, sku, size, held, reasons }) => ({ sourceRow, sku, size, held, reasons })), issues };
    (issues.length ? needsReview : candidates).push(group);
    members.forEach(item => groupedRows.add(item.sourceRow));
  }
  candidates.sort((a, b) => a.firstRow - b.firstRow);
  needsReview.sort((a, b) => a.firstRow - b.firstRow);
  const ungrouped = records.filter(record => !groupedRows.has(record.sourceRow)).map(record => ({
    sourceRow: record.sourceRow, sku: record.sku, name: record.name, sourceGroup: record.group,
    size: record.size, held: record.held, reasons: record.reasons,
    note: record.size ? 'Only one exact size-labelled row in this source group; product structure undecided.'
      : 'No exact trailing size label; product structure undecided.',
  }));
  const standalone = ungrouped.filter(record => !record.held);
  const heldStandalone = ungrouped.filter(record => record.held);
  const summary = { sourceRows: records.length, eligibleRows: records.filter(record => !record.held).length,
    heldRows: records.filter(record => record.held).length, candidateGroups: candidates.length,
    candidateRows: candidates.reduce((sum, group) => sum + group.members.length, 0),
    reviewGroups: needsReview.length,
    reviewEligibleRows: needsReview.reduce((sum, group) => sum + group.members.filter(item => !item.held).length, 0),
    reviewHeldRows: needsReview.reduce((sum, group) => sum + group.members.filter(item => item.held).length, 0),
    standaloneRows: standalone.length, heldStandaloneRows: heldStandalone.length };
  if (summary.candidateRows + summary.reviewEligibleRows + summary.standaloneRows !== summary.eligibleRows ||
      summary.reviewHeldRows + summary.heldStandaloneRows !== summary.heldRows) {
    throw new Error('Layout preview did not account for every source record exactly once.');
  }
  return { sourceHash: snapshot.manifestHash, ruleVersion: LAYOUT_RULE_VERSION, summary,
    candidates, needsReview, standalone, heldStandalone };
}

const options = group => group.members.map(item => `${cell(item.size)} (${item.sku ? `source SKU ${cell(item.sku)}` : `no SKU; source record #${item.sourceRow}`}${item.held ? `, held: ${cell(item.reasons.join(' '))}` : ''})`).join(', ');
const groupRow = group => `| ${cell(group.stem)} | ${cell(group.sourceGroup)} | ${options(group)} | ${group.issues.length ? cell(group.issues.join(' ')) : 'Possible Size options — owner review'} |`;
const groupHeader = '| Possible style name | Original CSV group (not a Woo category) | Source size labels / SKUs | Review note |\n| --- | --- | --- | --- |';
const itemRow = item => `| ${item.sourceRow} | ${cell(item.sku) || 'MISSING'} | ${cell(item.name)} | ${cell(item.sourceGroup)} | ${cell(item.held ? item.reasons.join(' ') : item.note)} |`;
const itemHeader = '| Source record # | Source SKU | Original name | Original CSV group | Review note |\n| ---: | --- | --- | --- | --- |';
const intro = layout => `**OFFLINE STRUCTURE PROPOSAL — NOT A WOO IMPORT OR LISTING APPROVAL.** No product was created or published; no website retail price, stock quantity, tax setting or POS sale changed. No WooCommerce request was made. The source PDF is historical, not the cutover stock count. This report intentionally has no per-item price, stock quantity, Woo ID, import-ready CSV or product metadata.\n\nPinned physical source SHA-256: \`${layout.sourceHash}\`; grouping rule: \`${layout.ruleVersion}\`. This rule only compares an *exact trailing size token*, the remaining name, and the original CSV group (ignoring case and extra spaces). It never merges colours, invents a parent SKU, guesses from a similar name, or declares two items to be the same product. The owner must check every proposed style and size before any draft Woo write.\n\n| Partition of ${layout.summary.sourceRows} source records | Count |\n| --- | ---: |\n| Possible multi-size styles (not approved) | ${layout.summary.candidateGroups} groups / ${layout.summary.candidateRows} eligible records |\n| Groupings that need manual identity review | ${layout.summary.reviewGroups} groups / ${layout.summary.reviewEligibleRows} eligible + ${layout.summary.reviewHeldRows} held records |\n| Individual eligible records, structure undecided | ${layout.summary.standaloneRows} |\n| Other held source records | ${layout.summary.heldStandaloneRows} |\n| Total eligible / held | ${layout.summary.eligibleRows} / ${layout.summary.heldRows} |\n`;

export function renderLayoutPreview(layout) {
  const samples = [];
  const shownGroups = new Set();
  for (const group of layout.candidates) {
    const key = normalize(group.sourceGroup);
    if (!shownGroups.has(key) && samples.length < 12) { shownGroups.add(key); samples.push(group); }
  }
  for (const group of layout.candidates) {
    if (samples.length >= 12) break;
    if (!samples.includes(group)) samples.push(group);
  }
  const issueKinds = ['Repeated or equivalent', 'held', 'another source group', 'too generic', 'un-sized record'];
  const attention = [];
  for (const phrase of issueKinds) {
    const found = layout.needsReview.find(group => !attention.includes(group) && group.issues.some(issue => issue.includes(phrase)));
    if (found) attention.push(found);
  }
  return `# Proposed WooCommerce product layout — short owner preview\n\n${intro(layout)}\n## A small sample: one possible product with selectable sizes\n\n${groupHeader}\n${samples.map(groupRow).join('\n') || '| No safely grouped examples | — | — | Review source names first |'}\n\nThese are **possible** variable products, not approved listings. Different colours stay separate even if their names are similar. Original CSV groups are not automatically website categories. The source SKU beside a size is a *reference*, not an assigned Woo ID or confirmed variation SKU.\n\n## Examples that must stay ungrouped pending a decision\n\n${groupHeader}\n${attention.map(groupRow).join('\n') || '| No examples in this category | — | — | — |'}\n\n## Individual-item examples (not automatically simple products)\n\n${itemHeader}\n${layout.standalone.slice(0, 6).map(itemRow).join('\n') || '| — | — | — | — | — |'}\n\n**One decision for the next step:** Should different colours of the same style remain separate website products, or should Colour and Size both be selectable options under one product? This preview deliberately does neither automatically. Images, descriptions, website categories, tax treatment and reviewed retail prices come before a draft product write. Fresh physical counts and Woo online-order reconciliation come later at cutover. The installed POS pilot stays read-only.\n\nFor the full private list of all possible groups, review groups and individual records, see the matching \`test-results/shared-woo-layout-detail-${layout.ruleVersion}-${layout.sourceHash.slice(0, 12)}.md\` file.\n`;
}

export function renderLayoutDetail(layout) {
  return `# Private Woo layout detail — review only, not an import\n\n${intro(layout)}\nThis is a record-by-record structural proposal. Held entries are **never** approved as sellable options; groups containing them stay in the needs-review section. Different colours and source groups are never automatically merged. No record is authorised for Woo creation by appearing here.\n\n## Possible multi-size styles — owner must verify every size\n\n${groupHeader}\n${layout.candidates.map(groupRow).join('\n') || '| — | — | — | — |'}\n\n## Ambiguous multi-size styles — do not stage\n\n${groupHeader}\n${layout.needsReview.map(groupRow).join('\n') || '| — | — | — | — |'}\n\n## Individual eligible source records — product structure undecided\n\n${itemHeader}\n${layout.standalone.map(itemRow).join('\n') || '| — | — | — | — | — |'}\n\n## Held standalone source records — resolve source exceptions first\n\n${itemHeader}\n${layout.heldStandalone.map(itemRow).join('\n') || '| — | — | — | — | — |'}\n`;
}

export function writePrivateLayoutReports(layout, outputDir = path.join(projectRoot, 'test-results')) {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(outputDir).isDirectory()) throw new Error('Review output directory must not be a symlink.');
  const slug = `${layout.ruleVersion}-${layout.sourceHash.slice(0, 12)}`;
  const files = [
    { name: `shared-woo-layout-preview-${slug}.md`, render: () => renderLayoutPreview(layout) },
    { name: `shared-woo-layout-detail-${slug}.md`, render: () => renderLayoutDetail(layout) },
  ];
  return files.map(({ name, render }) => {
    const filename = path.join(outputDir, name);
    if (fs.existsSync(filename)) {
      if (!fs.lstatSync(filename).isFile()) throw new Error('Review output is not a regular file.');
      return { filename, created: false };
    }
    // 'wx' refuses even a dangling symlink or a file created concurrently.
    // Never overwrite owner annotations in an earlier offline worksheet.
    fs.writeFileSync(filename, render(), { mode: 0o600, flag: 'wx' });
    return { filename, created: true };
  });
}

function main() {
  if (process.argv.length !== 2) {
    console.error('Usage: node scripts/preview-shared-woo-layout.mjs (no arguments; uses the verified local physical source)');
    process.exitCode = 2;
    return;
  }
  try {
    const layout = proposeProductLayout(loadInStoreSnapshot());
    const reports = writePrivateLayoutReports(layout);
    for (const report of reports) console.log(`Private ${report.created ? 'review created' : 'review already exists; not overwritten'}: test-results/${path.basename(report.filename)}`);
    console.log('No WooCommerce request, import, price/stock update or POS sale was made.');
  } catch (error) {
    console.error(`Unable to make an offline layout preview: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
