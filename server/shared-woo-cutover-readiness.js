/**
 * Phase 4 — offline, immutable-source-bound shared Woo inventory cutover review.
 *
 * NEVER creates Woo products/orders, imports quantities, changes prices,
 * approves a crosswalk, restores stock, issues refunds, or enables checkout.
 * Physical November PDF counts are historical; Woo remains sole stock authority.
 * Results contain only aggregate issue counts and physical row indexes, never
 * names, SKUs, prices, private notes, count amounts or Woo metadata.
 */
const HEX=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SKU=/^[0-9]{1,8}$/;
const DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const MAX_SOURCE=10000;
const MAX_WOO=50000;
const MAX_EXAMPLES=15;
const MAX_COUNT_AGE_MS=24*60*60*1000; // suggestion only, not production-approved SLA
const linkKeys={new_woo_required:['sourceSku','target'],existing_woo:['sourceSku','target','wooProductId','wooVariationId','reviewEvidenceId']};
const countKeys=['sourceSku','units','countedAt','counterId','witnessId'];
const secondCountKeys=['sourceSku','units','countedAt','counterId'];
const MAX_SECOND_RECOUNT_SPAN_MS=4*60*60*1000; // review heuristic, not an SLA
const MAX_REVIEW_SAMPLES=12;
// Privacy-safe triage view; NOT an approval ledger. A row may appear in many queues.
const REVIEW_CATEGORIES=[
  {task:'quarantine',priority:'P0'},
  {task:'export_integrity',priority:'P0'},
  {task:'identity',priority:'P1'},
  {task:'physical_recount',priority:'P1'},
  {task:'variation_owner',priority:'P1'},
];
const REVIEW_CATEGORY_BY_ISSUE={
  quarantined_source_record:'quarantine',
  quarantined_item_must_not_link:'quarantine',
  quarantined_item_count_not_released:'quarantine',
  invalid_woo_id:'export_integrity',
  duplicate_woo_id:'export_integrity',
  duplicate_woo_sku:'export_integrity',
  unsupported_woo_product_type:'export_integrity',
  orphan_or_invalid_woo_variation_parent:'export_integrity',
  missing_or_invalid_source_sku:'identity',
  duplicate_source_sku:'identity',
  link_for_unknown_source_sku:'identity',
  identity_mapping_missing:'identity',
  no_source_bound_cutover_evidence:'identity',
  new_woo_product_identity_unassigned:'identity',
  existing_woo_parent_variation_mismatch:'identity',
  duplicate_woo_target_mapping:'identity',
  variation_sku_unassigned_for_manual_review:'identity',
  variation_sku_differs_from_source:'identity',
  simple_woo_sku_differs_from_source:'identity',
  count_for_unknown_source_sku:'physical_recount',
  fresh_two_person_count_missing:'physical_recount',
  stale_or_future_physical_count_claim:'physical_recount',
  count_differs_from_historical_pdf:'physical_recount',
  independent_second_recount_missing:'physical_recount',
  second_recount_unknown_source:'physical_recount',
  second_recount_without_first:'physical_recount',
  second_recount_stale_or_future:'physical_recount',
  second_recount_too_far_from_first:'physical_recount',
  independent_recounts_disagree:'physical_recount',
  second_recount_on_quarantined_item:'quarantine',
  variation_stock_owner_requires_live_verification:'variation_owner',
  possible_shared_parent_managed_stock_pool:'variation_owner',
};
const REVIEW_STATES=['open','investigating','recount_requested',
  'owner_decision_required','installed_site_check_required'];

function fail(){throw new Error('Offline shared-stock cutover evidence invalid; no quantity or product change permitted.');}
function exact(row,keys){return !!row && typeof row==='object' && !Array.isArray(row) &&
  Object.keys(row).length===keys.length && keys.every(key=>Object.hasOwn(row,key));}
function validTime(x){return typeof x==='string' && DATE.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(x).toISOString()===x;}
function validId(x){return Number.isSafeInteger(x)&&x>0;}
function parseWooId(raw) {
  if(typeof raw!=='string' || !/^[1-9][0-9]{0,14}$/.test(raw)) return null;
  const n=Number(raw);
  return validId(n)?n:null;
}
function parentId(row){
  const text=String(row?.Parent??'').trim();
  return parseWooId(text.startsWith('id:')?text.slice(3):text);
}
function normalizeSKU(raw){return String(raw??'').trim().toUpperCase();}
function recordIssues(sourceIndex,issueCounts,examples,code){
  issueCounts[code]=(issueCounts[code]||0)+1;
  if(examples.length<MAX_EXAMPLES)examples.push({sourceRow:sourceIndex,code});
}
/**
 * Evidence schema (optional): {
 *   schemaVersion: 1, physicalManifestSha256, wooExportSha256,
 *   linkDrafts: [{sourceSku,target:'new_woo_required'} |
 *     {sourceSku,target:'existing_woo',wooProductId,wooVariationId:null|int,reviewEvidenceId:UUID}],
 *   cycleCounts: [{sourceSku,units:integer,countedAt:ISO,counterId:UUID,witnessId:UUID}]
 * }
 * Review evidence IDs and distinct counters are untrusted claims, never real
 * owner consent or verification that a physical count actually took place.
 */
export function assessSharedWooInventoryCutover({physical,wooExport,wooExportSha256,
  evidence=null,reviewDraft=null,secondRecounts=null,
  cutoverEvidenceSha256=null,now=Date.now()}={}) {
  if (!Array.isArray(physical?.items) ||
      !HEX.test(physical?.manifestHash || '') ||
      physical.items.length>MAX_SOURCE ||
      !Array.isArray(wooExport?.rows) ||
      wooExport.rows.length>MAX_WOO ||
      !HEX.test(wooExportSha256||'') ||
      !Number.isFinite(now)) fail();

  const issueCounts={};
  const examples=[];
  const triageCases=new Map(REVIEW_CATEGORIES.map(x=>[x.task,new Set()]));
  const triageEvents=new Map(REVIEW_CATEGORIES.map(x=>[x.task,0]));
  const issue=(i,c)=>{
    const task=REVIEW_CATEGORY_BY_ISSUE[c];
    if(!task) fail(); // never silently omit a future blocker
    recordIssues(i,issueCounts,examples,c);
    triageCases.get(task).add(i);
    triageEvents.set(task,triageEvents.get(task)+1);
  };
  const physicalBySku=new Map(),wooById=new Map(),wooBySku=new Map();
  let held=0,eligiblePositive=0,eligibleZero=0;
  physical.items.forEach((item,index)=>{
    if (!item || !['available','out_of_stock','review'].includes(item.status)) fail();
    if (item.status==='review'){held++;issue(index+1,'quarantined_source_record');}
    else if (item.status==='available')eligiblePositive++;
    else eligibleZero++;
    const sku=normalizeSKU(item.sku);
    if(!SKU.test(sku)) {
      if(item.status!=='review')issue(index+1,'missing_or_invalid_source_sku');
    } else if(physicalBySku.has(sku)){
      issue(index+1,'duplicate_source_sku');
    } else physicalBySku.set(sku,{row:index+1,item});
  });
  let wooParents=0,wooVariations=0;
  wooExport.rows.forEach(row=>{
    if(!row || typeof row!=='object')fail();
    const id=parseWooId(String(row.ID??'').trim());
    if(!id)issue(0,'invalid_woo_id');
    else if(wooById.has(id))issue(0,'duplicate_woo_id');
    else wooById.set(id,row);
    if(['simple','variable'].includes(row.Type))wooParents++;
    else if(row.Type==='variation')wooVariations++;
    else issue(0,'unsupported_woo_product_type');
    const sku=normalizeSKU(row.SKU);
    if(sku){
      if(wooBySku.has(sku))issue(0,'duplicate_woo_sku');
      else wooBySku.set(sku,id);
    }
  });
  // An incomplete Woo export can conceal a missing or wrong variation parent.
  for (const wooRow of wooExport.rows) {
    if (wooRow.Type!=='variation') continue;
    const candidateParentId=parentId(wooRow);
    const candidateParent=wooById.get(candidateParentId);
    if (!candidateParentId || !candidateParent || candidateParent.Type!=='variable')
      issue(0,'orphan_or_invalid_woo_variation_parent');
  }
  const links=new Map(),counts=new Map();
  let proposedExisting=0,proposedNew=0,claimedRecentCounts=0,
    claimedStaleCounts=0,historicalCountDiscrepancies=0;
  if (evidence!==null) {
    if (!exact(evidence,['schemaVersion','physicalManifestSha256',
      'wooExportSha256','linkDrafts','cycleCounts']) ||
      evidence.schemaVersion!==1 ||
      evidence.physicalManifestSha256!==physical.manifestHash ||
      evidence.wooExportSha256!==wooExportSha256 ||
      !Array.isArray(evidence.linkDrafts) || !Array.isArray(evidence.cycleCounts) ||
      evidence.linkDrafts.length>physical.items.length ||
      evidence.cycleCounts.length>physical.items.length) fail();
    for(const link of evidence.linkDrafts){
      const keys=linkKeys[link?.target];
      if(!keys || !exact(link,keys) || !SKU.test(link.sourceSku) ||
          links.has(link.sourceSku)) fail();
      if(link.target==='existing_woo' &&
          (!validId(link.wooProductId) ||
           !(link.wooVariationId===null || validId(link.wooVariationId)) ||
           !UUID.test(link.reviewEvidenceId||''))) fail();
      links.set(link.sourceSku,link);
    }
    for(const entry of evidence.cycleCounts){
      if(!exact(entry,countKeys) || !SKU.test(entry.sourceSku) ||
        counts.has(entry.sourceSku) ||
        !Number.isSafeInteger(entry.units) || entry.units<0 || entry.units>1000000 ||
        !validTime(entry.countedAt) ||
        !UUID.test(entry.counterId||'') || !UUID.test(entry.witnessId||'') ||
        entry.counterId===entry.witnessId) fail();
      counts.set(entry.sourceSku,entry);
    }
  } else {
    issue(0,'no_source_bound_cutover_evidence');
  }
  for(const sku of links.keys()){
    if(!physicalBySku.has(sku))issue(0,'link_for_unknown_source_sku');
  }
  for(const sku of counts.keys()){
    if(!physicalBySku.has(sku))issue(0,'count_for_unknown_source_sku');
  }
  const allocatedTargets=new Set();
  // Different Woo variation IDs can still consume ONE parent-managed pool.
  // CSV snapshots cannot independently prove the live installed stock owner.
  const variationMappingsByParent=new Map();
  for(const [sku,{row,item}] of physicalBySku.entries()){
    const link=links.get(sku);
    const count=counts.get(sku);
    if (item.status==='review'){
      if(link)issue(row,'quarantined_item_must_not_link');
      if(count)issue(row,'quarantined_item_count_not_released');
      continue;
    }
    if(!link)issue(row,'identity_mapping_missing');
    else if(link.target==='new_woo_required') {
      proposedNew++;
      issue(row,'new_woo_product_identity_unassigned');
    } else {
      proposedExisting++;
      const parent=wooById.get(link.wooProductId);
      const variation=link.wooVariationId===null?null:wooById.get(link.wooVariationId);
      if(!parent || (link.wooVariationId===null && parent.Type!=='simple') ||
          (link.wooVariationId!==null &&
            (parent.Type!=='variable' || !variation ||
             variation.Type!=='variation' ||
             parentId(variation)!==link.wooProductId))) {
        issue(row,'existing_woo_parent_variation_mismatch');
      } else {
        // An explicit existing Woo mapping is still a *draft* even if the
        // SKU happens to match. No implicit name or price equality matching.
        if (variation) {
          issue(row,'variation_stock_owner_requires_live_verification');
          const prior=variationMappingsByParent.get(link.wooProductId)||0;
          if (prior>0) issue(row,'possible_shared_parent_managed_stock_pool');
          variationMappingsByParent.set(link.wooProductId,prior+1);
        }
        if (variation && !normalizeSKU(variation.SKU))
          issue(row,'variation_sku_unassigned_for_manual_review');
        if(variation && normalizeSKU(variation.SKU) &&
           normalizeSKU(variation.SKU)!==sku)
          issue(row,'variation_sku_differs_from_source');
        if(!variation && normalizeSKU(parent.SKU)!==sku)
          issue(row,'simple_woo_sku_differs_from_source');
      }
      const key=String(link.wooVariationId??link.wooProductId);
      if(allocatedTargets.has(key))issue(row,'duplicate_woo_target_mapping');
      else allocatedTargets.add(key);
    }
    if(!count)issue(row,'fresh_two_person_count_missing');
    else {
      const age=now-Date.parse(count.countedAt);
      if(age<0 || age>MAX_COUNT_AGE_MS) {
        claimedStaleCounts++;issue(row,'stale_or_future_physical_count_claim');
      } else claimedRecentCounts++;
      // Differences are a priority for manual reconciliation, NEVER a Woo
      // quantity adjustment. Even a match is NOT independently observed.
      if(Number.isInteger(item.reportedQuantity) &&
         item.reportedQuantity!==count.units) {
        historicalCountDiscrepancies++;
        issue(row,'count_differs_from_historical_pdf');
      }
    }
  }
  // Phase 4.3: a SECOND independent recount claim, bound to the original
  // private first-count/crosswalk bytes, physical manifest and Woo CSV bytes.
  // Different UUIDs are user claims, not independently proven staff identity.
  const secondRecountSummary={
    kind:'offline-second-recount-claims',
    supplied:secondRecounts!==null,
    submittedClaims:0,claimedMatchingFirst:0,claimedDisagreements:0,
    missingSecondClaims:0,secondWithoutFirst:0,
    staleOrFutureClaims:0,observationWindowConflicts:0,
    quarantinedSecondClaims:0,
    counterIdentityIndependentlyVerified:false,
    physicalQuantitiesIndependentlyVerified:false,
    websiteReservationsReconciled:false,
    importOrStockWriteAuthorized:false,
  };
  if(secondRecounts!==null){
    if(evidence===null || !HEX.test(cutoverEvidenceSha256||'') ||
      !exact(secondRecounts,['schemaVersion','physicalManifestSha256',
        'wooExportSha256','cutoverEvidenceSha256','recounts']) ||
      secondRecounts.schemaVersion!==1 ||
      secondRecounts.physicalManifestSha256!==physical.manifestHash ||
      secondRecounts.wooExportSha256!==wooExportSha256 ||
      secondRecounts.cutoverEvidenceSha256!==cutoverEvidenceSha256 ||
      !Array.isArray(secondRecounts.recounts) ||
      secondRecounts.recounts.length>physical.items.length) fail();
    const seconds=new Map();
    for(const entry of secondRecounts.recounts){
      if(!exact(entry,secondCountKeys) || !SKU.test(entry.sourceSku) ||
        seconds.has(entry.sourceSku) ||
        !Number.isSafeInteger(entry.units) || entry.units<0 || entry.units>1000000 ||
        !validTime(entry.countedAt) || !UUID.test(entry.counterId||'')) fail();
      seconds.set(entry.sourceSku,entry);
    }
    secondRecountSummary.submittedClaims=seconds.size;
    for(const sku of seconds.keys()){
      if(!physicalBySku.has(sku))issue(0,'second_recount_unknown_source');
    }
    for(const [sku,{row,item}] of physicalBySku){
      const second=seconds.get(sku);
      if(item.status==='review'){
        if(second){
          secondRecountSummary.quarantinedSecondClaims++;
          issue(row,'second_recount_on_quarantined_item');
        }
        continue;
      }
      if(!second){
        secondRecountSummary.missingSecondClaims++;
        issue(row,'independent_second_recount_missing');
        continue;
      }
      const first=counts.get(sku);
      if(!first){
        secondRecountSummary.secondWithoutFirst++;
        issue(row,'second_recount_without_first');
        continue;
      }
      // Distinct synthetic IDs cannot authenticate staff, but the same
      // asserted ID reused from either first-count role is never acceptable.
      if(second.counterId===first.counterId || second.counterId===first.witnessId)fail();
      const secondAge=now-Date.parse(second.countedAt);
      if(secondAge<0 || secondAge>MAX_COUNT_AGE_MS){
        secondRecountSummary.staleOrFutureClaims++;
        issue(row,'second_recount_stale_or_future');
      }
      if(Math.abs(Date.parse(second.countedAt)-Date.parse(first.countedAt))>
        MAX_SECOND_RECOUNT_SPAN_MS){
        secondRecountSummary.observationWindowConflicts++;
        issue(row,'second_recount_too_far_from_first');
      }
      if(second.units!==first.units){
        secondRecountSummary.claimedDisagreements++;
        issue(row,'independent_recounts_disagree');
      } else secondRecountSummary.claimedMatchingFirst++;
    }
  }
  // These are private human-entered WORKFLOW NOTES, never signatures.
  // They bind physical + Woo + exact crosswalk/count bytes (no names/text).
  const annotations=new Map(REVIEW_CATEGORIES.map(x=>[x.task,new Map()]));
  if(reviewDraft!==null){
    if(evidence===null || !HEX.test(cutoverEvidenceSha256||'') ||
      !exact(reviewDraft,['schemaVersion','physicalManifestSha256',
        'wooExportSha256','cutoverEvidenceSha256','actions']) ||
      reviewDraft.schemaVersion!==1 ||
      reviewDraft.physicalManifestSha256!==physical.manifestHash ||
      reviewDraft.wooExportSha256!==wooExportSha256 ||
      reviewDraft.cutoverEvidenceSha256!==cutoverEvidenceSha256 ||
      !Array.isArray(reviewDraft.actions) ||
      reviewDraft.actions.length>MAX_SOURCE*REVIEW_CATEGORIES.length) fail();
    for(const action of reviewDraft.actions){
      if(!exact(action,['sourceRow','task','state']) ||
        !Number.isSafeInteger(action.sourceRow) ||
        action.sourceRow<0 || action.sourceRow>physical.items.length ||
        !annotations.has(action.task) ||
        !REVIEW_STATES.includes(action.state) ||
        !triageCases.get(action.task).has(action.sourceRow) ||
        annotations.get(action.task).has(action.sourceRow)) fail();
      annotations.get(action.task).set(action.sourceRow,action.state);
    }
  }
  const reviewQueues=REVIEW_CATEGORIES.map(({task,priority})=>{
    const cases=triageCases.get(task), claims=annotations.get(task);
    const draftStateCounts={};
    for(const state of REVIEW_STATES)draftStateCounts[state]=0;
    for(const state of claims.values())draftStateCounts[state]++;
    return {
      task,priority,
      affectedSourceRows:[...cases].filter(row=>row!==0).length,
      hasGlobalIssue:cases.has(0),
      issueEvents:triageEvents.get(task),
      sampledSourceRows:[...cases].filter(row=>row!==0).slice(0,MAX_REVIEW_SAMPLES),
      recordedDraftActions:claims.size,
      casesStillWithoutDraftAction:cases.size-claims.size,
      draftStateCounts,
    };
  });
  const reviewWorkflow={
    kind:'offline-owner-review-triage',
    usesPrivateSourceBoundDraft:reviewDraft!==null,
    draftActionsRecorded:reviewQueues.reduce((sum,row)=>sum+row.recordedDraftActions,0),
    // Queue counts overlap where one physical row has more than one issue.
    reviewQueues,
    ownerIdentityIndependentlyVerified:false,
    physicalRecountIndependentlyVerified:false,
    ownerSignOffIssued:false,
    importOrStockWriteAuthorized:false,
    approvalDecision:'manual_review_and_separate_independent_acceptance_required',
  };
  return {
    kind:'read-only-shared-woo-cutover-readiness',
    source:'offline-historical-physical-and-export',
    physicalManifestSha256:physical.manifestHash,
    wooExportSha256,
    counts:{
      historicalSourceRows:physical.items.length,
      sourceQuarantined:held,eligiblePositiveHistorically:eligiblePositive,
      eligibleZeroHistorically:eligibleZero,
      wooExportRows:wooExport.rows.length,wooParents,wooVariations,
      proposedExistingLinks:proposedExisting,proposedNewIdentities:proposedNew,
      claimedRecentTwoPersonCounts:claimedRecentCounts,
      claimedStaleTwoPersonCounts:claimedStaleCounts,
      countVsHistoricalDiscrepancies:historicalCountDiscrepancies,
    },
    issueCounts,examples,reviewWorkflow,secondRecountSummary,
    allPhysicalMappingsIndependentlyVerified:false,
    currentPhysicalCountsIndependentlyVerified:false,
    existingWooIdentitiesOwnerApproved:false,
    inventoryVariationOwnershipVerified:false,
    wooExportCompleteAndCurrentVerified:false,
    websiteAndStoreStockSingleAuthorityTested:false,
    lastUnitConcurrencyVerified:false,
    retailPriceAndTaxApproved:false,
    wholesaleCashCustodyVerified:false,
    lateGatewayGuardVerified:false,
    wooStockMutationsAllowed:false,
    productCreationAllowed:false,
    checkoutAuthorized:false,
    uploadOrImportReady:false,
    sellerOrManagerApprovalIssued:false,
    auditOnly:true,decision:'manual_identity_count_and_live_woo_review_required',
    notice:'Historical PDF values and offline Woo exports are never live shared-stock balances. Draft links and claimed cycle counts are NOT verified Owner decisions or Woo stock adjustments. Reconcile every source row, variation and the actual live Woo stock owner before separately authorizing cutover.',
  };
}
