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
const maxReviewDraftBytes=1024*1024;
const maxSecondRecountBytes=1024*1024;
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
      result.auditOnly!==true ||
      result.reviewWorkflow?.ownerSignOffIssued!==false ||
      result.reviewWorkflow?.importOrStockWriteAuthorized!==false ||
      result.reviewWorkflow?.ownerIdentityIndependentlyVerified!==false ||
      result.secondRecountSummary?.importOrStockWriteAuthorized!==false ||
      result.secondRecountSummary?.physicalQuantitiesIndependentlyVerified!==false ||
      result.secondRecountSummary?.counterIdentityIndependentlyVerified!==false)
    throw Error('unsafe report');
  const n=result.counts;
  const review=result.reviewWorkflow;
  const second=result.secondRecountSummary;
  const reviewRows=review.reviewQueues.map(q=>
    '| '+q.priority+' | '+q.task+' | '+q.affectedSourceRows+
    ' | '+(q.hasGlobalIssue?'yes':'no')+
    ' | '+q.recordedDraftActions+' | '+q.casesStillWithoutDraftAction+' |');
  const stateTotals={};
  for(const queue of review.reviewQueues)
    for(const [state,count] of Object.entries(queue.draftStateCounts))
      stateTotals[state]=(stateTotals[state]||0)+count;
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
    '## Phase 4.3 second recount claim review (read-only)',
    '',
    'Second recount draft supplied: '+(second.supplied?'yes':'no')+'.',
    'Second-counter UUIDs are UNVERIFIED claims, not authenticated staff identities.',
    'Comparing two claimed physical counts cannot certify stock or release a held item.',
    '',
    '| Recount indicator | Number |',
    '| --- | ---: |',
    '| Submitted second count claims | '+second.submittedClaims+' |',
    '| Matching first count claims (NOT verified) | '+second.claimedMatchingFirst+' |',
    '| Disagreements between first and second claims | '+second.claimedDisagreements+' |',
    '| Missing second count claims (only if draft supplied) | '+second.missingSecondClaims+' |',
    '| Second counts lacking a first claim | '+second.secondWithoutFirst+' |',
    '| Stale or future dated second counts | '+second.staleOrFutureClaims+' |',
    '| First/second observation window conflicts | '+second.observationWindowConflicts+' |',
    '| Second counts for held items (NOT released) | '+second.quarantinedSecondClaims+' |',
    '',
    'NO PHYSICAL STOCK OR OWNER AUTHENTICATION; NO IMPORT OR CHECKOUT APPROVAL.',
    '',
    '## Phase 4.2 owner-review triage (read-only)',
    '',
    'Priority P0 = holds/export integrity; P1 = identity, recount and variation ownership.',
    'One physical source row can belong to multiple review queues. All draft actions are untrusted.',
    'Private draft supplied: '+(review.usesPrivateSourceBoundDraft?'yes':'no')+'.',
    '',
    '| Priority | Review task | Source rows | Global issue | Draft actions | Unannotated cases |',
    '| --- | --- | ---: | --- | ---: | ---: |',
    ...reviewRows,
    '',
    'Draft action counts (NOT completed approvals):',
    ...Object.entries(stateTotals).map(([state,count])=>'- '+state+': '+count),
    '',
    'Owner identity, physical recount and final sign-off: NOT INDEPENDENTLY VERIFIED.',
    'Nothing in this workflow authorizes stock writes, import, product creation or checkout.',
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
  if (![3,4,5,6].includes(process.argv.length) || !process.argv[2] ||
      process.argv.slice(2).some(a=>a.startsWith('-'))) {
    console.error('Usage: node scripts/assess-shared-woo-cutover.mjs /private/woo-products.csv [/private/cutover-evidence.json [/private/owner-review-draft.json [/private/second-recounts.json]]]');
    process.exitCode=2;
    return;
  }
  try {
    const bytes=readLocalFile(process.argv[2],maxExportBytes);
    const wooExport=parseWooExport(bytes);
    const source=loadInStoreSnapshot();
    const evidenceBytes=process.argv[3]
      ? readLocalFile(process.argv[3],maxEvidenceBytes,true) : null;
    const evidence=evidenceBytes?JSON.parse(evidenceBytes.toString('utf8')):null;
    const reviewDraft=process.argv[4]
      ? JSON.parse(readLocalFile(process.argv[4],maxReviewDraftBytes,true).toString('utf8'))
      : null;
    const secondRecounts=process.argv[5]
      ? JSON.parse(readLocalFile(process.argv[5],maxSecondRecountBytes,true).toString('utf8'))
      : null;
    const result=assessSharedWooInventoryCutover({
      physical:source,wooExport,wooExportSha256:hash(bytes),evidence,
      cutoverEvidenceSha256:evidenceBytes?hash(evidenceBytes):null,
      reviewDraft,secondRecounts,
    });
    process.stdout.write(renderSharedWooCutoverReadiness(result));
  } catch {
    // Woo CSV parser errors can include raw private product records.
    console.error('Private cutover evidence could not be verified. No report, live Woo request or inventory change occurred.');
    process.exitCode=1;
  }
}
if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))main();
