#!/usr/bin/env node
// OFFLINE aggregate-only inventory cutover readiness, no HTTP or writes.
// Raw product names/SKUs, item counts/prices and evidence IDs are never printed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';
import { parseWooExport } from './plan-shared-woo-catalog.mjs';
import { assessSharedWooInventoryCutover } from '../server/shared-woo-cutover-readiness.js';

const maxExportBytes=64*1024*1024;
const maxEvidenceBytes=1024*1024;
const hash=b=>createHash('sha256').update(b).digest('hex');
function readLocalFile(input,maxBytes,privateOnly=false) {
  const name=path.resolve(input);
  const stat=fs.lstatSync(name);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size<1 || stat.size>maxBytes ||
      (privateOnly && (stat.mode&0o077)!==0)) throw Error('unsafe private file');
  return fs.readFileSync(name);
}
export function renderSharedWooCutoverReadiness(result) {
  if (result?.kind!=='read-only-shared-woo-cutover-readiness' ||
      result.checkoutAuthorized!==false || result.wooStockMutationsAllowed!==false ||
      result.productCreationAllowed!==false || result.uploadOrImportReady!==false ||
      result.auditOnly!==true) throw Error('unsafe report');
  const n=result.counts;
  const issueRows=Object.entries(result.issueCounts).sort(([a],[b])=>a.localeCompare(b))
    .map(([code,count])=>'| '+code+' | '+count+' |');
  const examples=result.examples.map(x=>'| '+(x.sourceRow||'global')+' | '+x.code+' |');
  return [
    '# Shared WooCommerce inventory cutover — OFFLINE READINESS REVIEW',
    '',
    '**NO WOO IMPORT, PRODUCT CREATION, STOCK ADJUSTMENT, REFUND OR CHECKOUT AUTHORIZATION.**',
    'Historical PDF counts and an offline Woo export are never live stock balances.',
    'Draft links and witnessed counts are untrusted claims, NOT Owner sign-off.',
    '',
    'Physical manifest SHA-256: '+result.physicalManifestSha256,
    'Woo export SHA-256: '+result.wooExportSha256,
    '',
    '| Indicator | Records |',
    '| --- | ---: |',
    '| Historical physical source rows | '+n.historicalSourceRows+' |',
    '| Quarantined / held source rows | '+n.sourceQuarantined+' |',
    '| Positive historical PDF balances | '+n.eligiblePositiveHistorically+' |',
    '| Zero historical PDF balances | '+n.eligibleZeroHistorically+' |',
    '| Woo offline export rows | '+n.wooExportRows+' |',
    '| Woo parents / variation rows | '+n.wooParents+' / '+n.wooVariations+' |',
    '| Proposed existing-Woo identity links (NOT approved) | '+n.proposedExistingLinks+' |',
    '| Proposed new-Woo identity assignments (NOT created) | '+n.proposedNewIdentities+' |',
    '| Claimed recent two-person count records | '+n.claimedRecentTwoPersonCounts+' |',
    '| Stale or future dated count claims | '+n.claimedStaleTwoPersonCounts+' |',
    '| Historical-count discrepancies (NOT adjustments) | '+n.countVsHistoricalDiscrepancies+' |',
    '',
    '## Outstanding conditions',
    '',
    '| Condition code | Count |','| --- | ---: |',
    ...(issueRows.length?issueRows:['| none seen in supplied claims (still NOT verified) | 0 |']),
    '',
    '## Bounded review examples (source row indices only)',
    '',
    '| Physical source row | Condition code |','| ---: | --- |',
    ...(examples.length?examples:['| — | No examples |']),
    '',
    '**BLOCKED: MANUAL PRODUCT IDENTITY, LIVE STOCK, COUNT AND SECURITY REVIEW REQUIRED.**',
    'Reconcile all historical holds. Independently confirm real Woo parent/variation stock owner,',
    'pending web orders, physically counted inventory, GHS retail pricing/tax and',
    'Owner approvals. Never seed stock from the historical PDF, enable POS-only',
    'local-stock cash sales, or use this report as an import-ready file.',
    '',
  ].join('\n');
}
function main() {
  if (![3,4].includes(process.argv.length) || !process.argv[2] ||
      process.argv.slice(2).some(a=>a.startsWith('-'))) {
    console.error('Usage: node scripts/assess-shared-woo-cutover.mjs /private/woo-products.csv [/private/cutover-evidence.json]');
    process.exitCode=2;
    return;
  }
  try {
    const bytes=readLocalFile(process.argv[2],maxExportBytes);
    const wooExport=parseWooExport(bytes);
    const source=loadInStoreSnapshot();
    const evidence=process.argv[3]
      ? JSON.parse(readLocalFile(process.argv[3],maxEvidenceBytes,true).toString('utf8'))
      : null;
    const result=assessSharedWooInventoryCutover({
      physical:source,wooExport,wooExportSha256:hash(bytes),evidence,
    });
    process.stdout.write(renderSharedWooCutoverReadiness(result));
  } catch {
    // Woo CSV parser errors can include raw private product records.
    console.error('Private cutover evidence could not be verified. No report, live Woo request or inventory change occurred.');
    process.exitCode=1;
  }
}
if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))main();
