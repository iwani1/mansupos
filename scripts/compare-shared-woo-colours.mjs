#!/usr/bin/env node
// Two private, offline WooCommerce product-layout alternatives. These Markdown
// reports NEVER create product drafts, set prices/stock, contact Woo or alter POS.
// All family links are review candidates, not verified product identities.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';
import { proposeProductLayout } from './preview-shared-woo-layout.mjs';
import { chooseColourExample, renderColourVisualPreview } from './render-shared-woo-colour-html.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const COLOUR_RULE_VERSION = 'v2';
// Exact, single-word labels only. Combined/hyphenated colours, misspellings,
// synonyms and colour-in-group guesses are deliberately NOT auto-linked.
const colours = new Set('RED PINK BLUE GREEN YELLOW WHITE BLACK BROWN WINE PURPLE ORANGE CREAM BEIGE GREY GRAY NAVY NUDE PEACH OLIVE KHAKI MAROON GOLD SILVER LILAC'.split(' '));
const garmentWords = new Set('DRESS DRESSES TOP TOPS SHIRT SHIRTS SET SETS PANT PANTS SHORT SHORTS SKIRT SKIRTS BODYSUIT BODYSUITS BLAZER JACKET JUMPSUIT JUMPSUITS TROUSER TROUSERS JEANS KAFTAN KAFTANS ROMPER ROMPERS BLOUSE BLOUSES LEGGINGS CARDIGAN POLO COAT GOWN KIMONO'.split(' '));
const sizeSuffix = /^(.*?)\s+(XS|S|M|L|XL|XXL|XXXL|[2-6]XL)$/u;
const canonicalColour = colour => colour === 'GRAY' ? 'GREY' : colour;
const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim().toLocaleUpperCase('en');
const cell = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replace(/\r|\n|\t/g, ' ').replaceAll('\\', '\\\\')
  .replaceAll('|', '\\|').replaceAll('`', '\\`').replaceAll('[', '\\[')
  .replaceAll(']', '\\]').replaceAll('*', '\\*').replaceAll('_', '\\_').trim();

export function colourIdentity(stem, sourceGroup) {
  const words = normalize(stem).split(' ').filter(Boolean);
  const matches = words.flatMap((word, index) => colours.has(word) ? [index] : []);
  if (matches.length !== 1) return null;
  const position = matches[0];
  const baseWords = words.filter((_, index) => index !== position);
  if (!baseWords.length || !normalize(sourceGroup)) return null;
  const base = baseWords.join(' ');
  return { base, colour: words[position], position, sourceGroup,
    key: JSON.stringify([normalize(sourceGroup), base, position]),
    baseKey: JSON.stringify([base, position]),
    descriptive: baseWords.length >= 2 && baseWords.some(word => garmentWords.has(word)) };
}

// If removing a possible colour phrase leaves the *entire* same style name,
// an uncoloured, hyphenated, multiword or reordered source record may belong
// to the family. Do not present the partial family as a complete colour choice.
function possiblyRelatedStem(stem, base) {
  const words = normalize(stem).split(' ');
  const baseWords = normalize(base).split(' ');
  if (words.length === baseWords.length) return words.every((word, index) => word === baseWords[index]);
  if (words.length < baseWords.length) return false;
  for (let position = 0; position <= baseWords.length; position++) {
    const afterColour = words.length - (baseWords.length - position);
    if (!baseWords.slice(0, position).every((word, index) => words[index] === word) ||
        !baseWords.slice(position).every((word, index) => words[afterColour + index] === word)) continue;
    if (words.slice(position, afterColour).some(word => word.split(/[^A-Z]+/u).some(part => colours.has(part)))) return true;
  }
  return false;
}

export function compareColourLayouts(layout) {
  if (!/^[a-f0-9]{64}$/.test(layout?.sourceHash || '') || !Array.isArray(layout.candidates) || !Array.isArray(layout.needsReview)) {
    throw new Error('A verified size-layout proposal with a source hash is required.');
  }
  const byKey = new Map();
  const sourceGroupsByBase = new Map();
  const sizeGroups = [...layout.candidates, ...layout.needsReview];
  const singleRows = [...(layout.standalone || []), ...(layout.heldStandalone || [])];
  const sourceStems = [
    ...sizeGroups.map(group => ({ stem: group.stem, sourceGroup: group.sourceGroup,
      firstRow: group.firstRow, kind: 'size group', held: group.members.some(item => item.held) })),
    ...singleRows.map(item => ({ stem: normalize(item.name).replace(sizeSuffix, '$1'),
      sourceGroup: item.sourceGroup, firstRow: item.sourceRow, kind: 'single row', held: item.held })),
  ];
  for (const group of sizeGroups) {
    const identity = colourIdentity(group.stem, group.sourceGroup);
    if (!identity) continue;
    if (!byKey.has(identity.key)) byKey.set(identity.key, { identity, entries: [], loose: [] });
    byKey.get(identity.key).entries.push({ group, colour: identity.colour });
    if (!sourceGroupsByBase.has(identity.baseKey)) sourceGroupsByBase.set(identity.baseKey, new Set());
    sourceGroupsByBase.get(identity.baseKey).add(normalize(group.sourceGroup));
  }
  // A single size-labelled item or an un-sized parent-like row must not vanish
  // when other colours are merged. It blocks an apparently incomplete family.
  for (const item of singleRows) {
    const name = normalize(item.name);
    const sizeMatch = sizeSuffix.exec(name);
    const identity = colourIdentity(sizeMatch ? sizeMatch[1] : name, item.sourceGroup);
    if (!identity) continue;
    byKey.get(identity.key)?.loose.push({ sourceRow: item.sourceRow, sku: item.sku, name: item.name,
      size: sizeMatch?.[2] || '', held: item.held, reasons: item.reasons });
    if (sourceGroupsByBase.has(identity.baseKey)) sourceGroupsByBase.get(identity.baseKey).add(normalize(item.sourceGroup));
  }
  const candidates = [], needsReview = [];
  for (const { identity, entries, loose } of byKey.values()) {
    const distinctColours = new Set(entries.map(entry => entry.colour));
    if (distinctColours.size < 2) continue;
    entries.sort((a, b) => a.group.firstRow - b.group.firstRow);
    const countedRows = new Set([...entries.map(entry => entry.group.firstRow), ...loose.map(item => item.sourceRow)]);
    const related = sourceStems.filter(item => !countedRows.has(item.firstRow) && possiblyRelatedStem(item.stem, identity.base));
    const issues = [];
    if (entries.some(entry => entry.group.issues.length || entry.group.members.some(member => member.held))) {
      issues.push('At least one colour has an ambiguous/held size group.');
    }
    if (new Set(entries.map(entry => canonicalColour(entry.colour))).size !== entries.length) {
      issues.push('A colour label repeats or is an equivalent spelling; resolve identity before merging.');
    }
    if (!identity.descriptive) issues.push('Removing the colour leaves a generic or unclear style name.');
    if (sourceGroupsByBase.get(identity.baseKey)?.size > 1) issues.push('The colour-free style occurs in another source group.');
    if (loose.length) issues.push('Additional single-size or un-sized records may belong to this style.');
    if (related.length) issues.push('Other uncoloured, multiword, compound or reordered colour names may belong to this style.');
    const family = { base: identity.base, sourceGroup: identity.sourceGroup, position: identity.position,
      firstRow: Math.min(...entries.map(entry => entry.group.firstRow)), issues, related,
      colourPages: entries.map(({ colour, group }) => ({ colour, title: group.stem, issues: group.issues,
        sizes: group.members.map(member => ({ size: member.size, sku: member.sku, sourceRow: member.sourceRow,
          held: member.held, reasons: member.reasons })) })),
      loose: [...loose].sort((a, b) => a.sourceRow - b.sourceRow) };
    (issues.length ? needsReview : candidates).push(family);
  }
  candidates.sort((a, b) => a.firstRow - b.firstRow);
  needsReview.sort((a, b) => a.firstRow - b.firstRow);
  const summary = { possibleFamilies: candidates.length,
    separatePages: candidates.reduce((sum, family) => sum + family.colourPages.length, 0),
    sourceSizeRecords: candidates.reduce((sum, family) => sum + family.colourPages.reduce((n, page) => n + page.sizes.length, 0), 0),
    reviewFamilies: needsReview.length,
    reviewColourGroups: needsReview.reduce((sum, family) => sum + family.colourPages.length, 0),
    reviewHeldRecords: needsReview.reduce((sum, family) => sum + family.colourPages.reduce((n, page) => n + page.sizes.filter(size => size.held).length, 0) + family.loose.filter(item => item.held).length, 0),
    unpairedSizeGroups: layout.candidates.length + layout.needsReview.length -
      [...candidates, ...needsReview].reduce((sum, family) => sum + family.colourPages.length, 0) };
  // A source record can contribute to at most one exact colour family.
  const sourceRows = [...candidates, ...needsReview].flatMap(family => family.colourPages.flatMap(page => page.sizes.map(item => item.sourceRow)));
  if (sourceRows.length !== new Set(sourceRows).size || summary.unpairedSizeGroups < 0) {
    throw new Error('Colour comparison reused a size group. Stop for identity review.');
  }
  return { sourceHash: layout.sourceHash, sizeRuleVersion: layout.ruleVersion,
    colourRuleVersion: COLOUR_RULE_VERSION, sourceSummary: layout.summary, summary,
    candidates, needsReview };
}

const sizeText = page => page.sizes.map(item => `${cell(item.size)} (${item.sku ? `source SKU ${cell(item.sku)}` : `no SKU; source record #${item.sourceRow}`}${item.held ? `, HELD: ${cell(item.reasons.join(' '))}` : ''})`).join(', ');
const familySummary = family => family.colourPages.map(page => `${cell(page.colour)}: ${page.sizes.map(item => cell(item.size)).join('/')}`).join('; ');
const warning = family => [
  ...family.issues, ...family.colourPages.flatMap(page => page.issues),
  ...family.colourPages.flatMap(page => page.sizes.filter(size => size.held)
    .map(size => `${page.colour} ${size.size} held: ${size.reasons.join(' ')}`)),
  ...family.loose.map(item => `Unpaired source record #${item.sourceRow}${item.held ? ` (held: ${(item.reasons || []).join(' ')})` : ''}`),
  ...family.related.map(item => `Related ${item.kind} starting #${item.firstRow}: ${item.stem} [${item.sourceGroup}]${item.held ? ' (held; see earlier size-only review)' : ''}`),
].join(' ');
const fileNames = comparison => {
  const slug = `${comparison.colourRuleVersion}-${comparison.sourceHash.slice(0, 12)}`;
  return { compare: `shared-woo-colour-compare-${slug}.md`,
    separate: `shared-woo-colour-separate-${slug}.md`, combined: `shared-woo-colour-combined-${slug}.md`,
    visual: `shared-woo-colour-visual-${slug}.html` };
};
const commonIntro = comparison => `**OFFLINE CHOICES, NOT APPROVED WOO PRODUCTS.** Neither option calls WooCommerce, creates drafts or orders, changes website retail prices, sets stock, publishes goods, or unlocks the POS. The PDF quantities are historical and intentionally absent. No parent SKU, Woo ID, tax setting, category mapping or photo is supplied. Source SKUs below are references only.\n\nPinned source SHA-256: \`${comparison.sourceHash}\`. Rules: size \`${comparison.sizeRuleVersion}\`, colour \`${comparison.colourRuleVersion}\`. Only an exact **single-word colour in the same position** of otherwise identical style names **within the same source group** is compared. Compound colours, multiple colour words, misspellings, abbreviations, reordered words and single-item records do not become approved links. If another possible colour-worded record may belong to a family, that family is held for manual review rather than presented as a complete colour selector. Every proposed family still needs a person to confirm the physical goods.\n`;

export function renderColourComparison(comparison) {
  const example = chooseColourExample(comparison);
  const files = fileNames(comparison);
  return `# Two website product layouts — compare before deciding\n\n${commonIntro(comparison)}\n| Same proposed goods | Option A: separate colour pages | Option B: one Colour + Size page |\n| --- | --- | --- |\n| For ${comparison.summary.possibleFamilies} strict-name-match but **unconfirmed** colour families | ${comparison.summary.separatePages} possible colour-specific pages | ${comparison.summary.possibleFamilies} possible combined pages |\n| How customers select | Choose a colour page, then choose Size | Choose Colour, then a Size listed **for that colour** |\n| Photo and URL | Each colour needs its own reviewed page/photo | One page; each colour still needs reviewed photos |\n| Editing later | More product pages; Size options on each | Fewer pages; more Colour + Size options to maintain together |\n| Stock identities | Each actual size SKU would need its own reviewed Woo variation/stock identity | **The same** source size SKUs would need reviewed Woo Colour + Size variation identities; no extra combinations |\n| Retail price and stock | Not supplied here; owner will review later | Not supplied here; owner will review later |\n\nThe comparison covers ${comparison.summary.sourceSizeRecords} eligible source size records in those possible families. Another **${comparison.summary.reviewFamilies} family patterns** (${comparison.summary.reviewColourGroups} colour-size groups, including ${comparison.summary.reviewHeldRecords} held records) need manual review before **combining** colours; clean individual colour pages can still be considered separately after owner review. ${comparison.summary.unpairedSizeGroups} other size groups do not form a strict colour pair and remain in the earlier size-only worksheet. **All ${comparison.sourceSummary.heldRows} held source records remain held**; nothing here is an import list or a fresh stock count.\n\n## The same example in both options\n\n${example ? `**Option A — two separate product-page ideas:**\n${example.colourPages.map(page => `- **${cell(page.title)}**: Size ${page.sizes.map(item => cell(item.size)).join(', ')}. Photo, retail price and stock: pending review.`).join('\n')}\n\n**Option B — one product-page idea:** **${cell(example.base)}**, with Colour choices ${example.colourPages.map(page => cell(page.colour)).join(', ')}.\n${example.colourPages.map(page => `- Select **${cell(page.colour)}** → recorded source sizes: ${page.sizes.map(item => cell(item.size)).join(', ')}.`).join('\n')}\nOnly those recorded Colour + Size pairs appear; **no missing pair is invented**.` : 'No strict colour-family example passed the offline checks; do not propose a combined page yet.'}\n\n**Important exception:** A name match can be wrong. For example, groups with duplicated size labels, held SKUs, generic colour-free names, conflicting source groups or lone size records remain blocked from automatic colour merging. Open the two separate, private reports for all proposed families and review cases: [Option A — separate colour pages](./${files.separate}) and [Option B — one Colour + Size page](./${files.combined}).\n\nSee [the offline visual side-by-side example](./${files.visual}) if you prefer a picture of both layouts.\n\n**Your decision can be A, B, or a mix by style.** You do not need to decide retail prices or stock yet. The installed pilot remains read-only.\n`;
}

export function renderSeparateColourPages(comparison) {
  const example = chooseColourExample(comparison);
  return `# Option A — separate website product page for each colour\n\n${commonIntro(comparison)}\n**Page idea:** each colour is its own possible Woo product, and the recorded sizes for that colour are its possible Size options. Colours with only one recorded size are NOT silently added. No webpage or draft product has been created. This option has ${comparison.summary.separatePages} possible colour pages across ${comparison.summary.possibleFamilies} strict comparison families; the earlier size-only worksheet also contains other, unpaired/ambiguous styles.\n\n## Example page outlines (text-only, no real product photos)\n\n${example ? example.colourPages.map(page => `### ${cell(page.title)}\n\nPhoto: owner to supply. Retail price: owner to review later. Stock: fresh count at cutover, not the PDF.\n\nSize choices from source: ${sizeText(page)}.\n`).join('\n') : 'No strict colour comparison is available.'}\n\n## All strictly matched family pairs (still unapproved)\n\n| Original CSV group | Colour-free comparison name | Separate page ideas and actual sizes |\n| --- | --- | --- |\n${comparison.candidates.map(family => `| ${cell(family.sourceGroup)} | ${cell(family.base)} | ${family.colourPages.map(page => `${cell(page.title)} — ${page.sizes.map(item => cell(item.size)).join('/')}`).join('; ')} |`).join('\n') || '| — | — | — |'}\n\n## Patterns needing manual review — do not treat as approved pages\n\n| Original CSV group | Comparison name | Source colours and sizes | Why unresolved |\n| --- | --- | --- | --- |\n${comparison.needsReview.map(family => `| ${cell(family.sourceGroup)} | ${cell(family.base)} | ${familySummary(family)} | ${cell(warning(family))} |`).join('\n') || '| — | — | — | — |'}\n\n**Not covered by these pairs:** all individual source records, unpaired size groups, ambiguous/compound colours and the ${comparison.sourceSummary.heldRows} held records. See the earlier full size-layout detail for their source SKUs. A pattern blocked from *combining* colours may still be reviewed as separate pages if its individual size groups pass review. Before any Woo draft, verify identities, copy, images, taxonomy, tax and final retail prices with the owner.\n`;
}

export function renderCombinedColourPage(comparison) {
  const example = chooseColourExample(comparison);
  return `# Option B — one website product page with Colour and Size choices\n\n${commonIntro(comparison)}\n**Page idea:** one possible Woo variable product per strictly matched style family. A colour is an option, then only its **actually recorded** sizes would be shown. Stock would be managed on each reviewed variation, not a fabricated Colour × Size grid or the old POS ledger. No webpage or draft product has been created. This option proposes ${comparison.summary.possibleFamilies} combined pages for the same ${comparison.summary.sourceSizeRecords} source size records shown in Option A.\n\n## Example page outline (text-only, no real product photos)\n\n${example ? `### ${cell(example.base)}\n\nPhoto: owner to supply per colour. Retail price: owner to review later. Stock: fresh count at cutover, not the PDF.\n\n${example.colourPages.map(page => `- Colour **${cell(page.colour)}** → Size ${sizeText(page)}`).join('\n')}\n\nDo not offer a missing size for a colour merely because it exists in another colour.` : 'No strict colour comparison is available.'}\n\n## All strictly matched families (still unapproved)\n\n| Original CSV group | Possible one-page name | Only recorded Colour → Size options |\n| --- | --- | --- |\n${comparison.candidates.map(family => `| ${cell(family.sourceGroup)} | ${cell(family.base)} | ${familySummary(family)} |`).join('\n') || '| — | — | — |'}\n\n## Patterns that must NOT be combined without an identity decision\n\n| Original CSV group | Comparison name | Source colours and sizes | Why unresolved |\n| --- | --- | --- | --- |\n${comparison.needsReview.map(family => `| ${cell(family.sourceGroup)} | ${cell(family.base)} | ${familySummary(family)} | ${cell(warning(family))} |`).join('\n') || '| — | — | — | — |'}\n\n**Not covered by these pairs:** all individual source records, unpaired size groups, ambiguous/compound colours and the ${comparison.sourceSummary.heldRows} held records. See the earlier full size-layout detail for their source SKUs. Verify each physical item before adding any Woo variation; the POS-only In-store cash path stays locked.\n`;
}

export function writePrivateColourReports(comparison, outputDir = path.join(projectRoot, 'test-results')) {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(outputDir).isDirectory()) throw new Error('Report directory must not be a symlink.');
  const files = fileNames(comparison);
  return [
    { name: files.compare, content: () => renderColourComparison(comparison) },
    { name: files.separate, content: () => renderSeparateColourPages(comparison) },
    { name: files.combined, content: () => renderCombinedColourPage(comparison) },
    { name: files.visual, content: () => renderColourVisualPreview(comparison) },
  ].map(({ name, content }) => {
    const filename = path.join(outputDir, name);
    if (fs.existsSync(filename)) {
      if (!fs.lstatSync(filename).isFile()) throw new Error('Report output must be a regular file.');
      return { filename, created: false };
    }
    fs.writeFileSync(filename, content(), { mode: 0o600, flag: 'wx' });
    return { filename, created: true };
  });
}

function main() {
  if (process.argv.length !== 2) {
    console.error('Usage: node scripts/compare-shared-woo-colours.mjs (no arguments; reads only the verified local physical source)');
    process.exitCode = 2;
    return;
  }
  try {
    const comparison = compareColourLayouts(proposeProductLayout(loadInStoreSnapshot()));
    const reports = writePrivateColourReports(comparison);
    for (const report of reports) console.log(`Private ${report.created ? 'preview created' : 'preview already exists; not overwritten'}: test-results/${path.basename(report.filename)}`);
    console.log('No WooCommerce request, product/order draft, price or stock update, or POS sale was made.');
  } catch (error) {
    console.error(`Unable to compare offline colour layouts: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
