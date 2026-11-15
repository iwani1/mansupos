import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

// Read-only owner dossier: combines three separate observations. It is NEVER
// a stock importer, mapping approval, witnessed count or checkout acceptance.
const FOCUSES=new Set([
  'all','identity_hold','mapping_not_proposed','mapping_investigation',
  'sku_difference','first_count_missing','second_count_missing',
  'count_discrepancy','matching_count_unverified','source_mismatch',
]);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm=value=>typeof value==='string'?value.trim().toUpperCase():'';

function classify(mapping,count,verified){
  const issues=[];
  const held=['held','missing_physical_sku','duplicate_physical_sku',
    'ambiguous_website_identity'].includes(mapping.classification);
  const review=mapping.latestReview;
  if(!verified)issues.push('source_evidence_unverified');
  if(held)issues.push('unresolved_physical_identity');
  if(!review||review.decision!=='propose_option')
    issues.push('owner_mapping_proposal_missing');
  if(review?.decision==='investigate_identity'||review?.decision==='retain_hold')
    issues.push('owner_investigation_open');
  if(review?.decision==='propose_option'&&!review.exactSkuMatch)
    issues.push('proposed_sku_differs');
  const stage=count.stage;
  if(stage==='first_needed')issues.push('first_count_missing');
  if(stage==='second_needed')issues.push('second_count_missing');
  if(stage==='discrepant_claims')issues.push('staff_count_discrepancy');
  if(stage==='matching_claims_unverified')issues.push('matching_counts_not_witnessed');
  if(stage==='identity_hold'&&!held)issues.push('count_identity_hold');
  if(count.triage?.needsRecheck)issues.push('owner_followup_needs_recheck');
  // Every row remains blocked from stock import and checkout. These two
  // requirements cannot be satisfied by the available pilot records.
  issues.push('independent_physical_witness_unverified');
  issues.push('woo_stock_reservation_unverified');

  let focus='matching_count_unverified';
  if(held||stage==='identity_hold')focus='identity_hold';
  else if(!review)focus='mapping_not_proposed';
  else if(review.decision!=='propose_option')focus='mapping_investigation';
  else if(!review.exactSkuMatch)focus='sku_difference';
  else if(stage==='first_needed')focus='first_count_missing';
  else if(stage==='second_needed')focus='second_count_missing';
  else if(stage==='discrepant_claims')focus='count_discrepancy';
  else if(stage!=='matching_claims_unverified')focus='source_mismatch';
  return {focus,issues};
}

export function buildInventoryDossier(
  physical,website,mappingEvidence,countClaims,options={},clock=Date.now()
){
  const {page=1,pageSize=25,focus='all',search=''}=options;
  if(!Number.isSafeInteger(page)||page<1||page>10000||
    !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||
    !FOCUSES.has(focus)||typeof search!=='string'||search.length>64){
    throw new AppError('Invalid dossier filter or page.',400,'INVALID_INVENTORY_DOSSIER_FILTER');
  }
  const mappingRows=[],countRows=[];
  const mappings=mappingEvidence.review(physical,website,
    {page:1,pageSize:1},clock,mappingRows);
  const counts=countClaims.ownerReview(physical,website,
    {page:1,pageSize:1},clock,countRows);
  if(mappingRows.length!==countRows.length||
     mappingRows.length!==physical?.items?.length){
    throw new AppError('Owner mapping and count sources disagree on the source row count.',409,
      'INVENTORY_DOSSIER_SOURCE_MISMATCH');
  }
  const countsByRow=new Map();
  for(const count of countRows){
    if(!Number.isSafeInteger(count.reportRow)||count.reportRow<1||
       countsByRow.has(count.reportRow)){
      throw new AppError('Physical source rows are not uniquely identifiable.',409,
        'INVENTORY_DOSSIER_SOURCE_MISMATCH');
    }
    countsByRow.set(count.reportRow,count);
  }
  const verified=mappings.evidenceVerified&&counts.evidenceVerified &&
    mappings.sourceHash===physical?.manifestHash;
  const rows=[],focusCounts=Object.fromEntries([...FOCUSES].filter(x=>x!=='all').map(x=>[x,0]));
  for(const item of mappingRows){
    const count=countsByRow.get(item.reportRow);
    if(!count||norm(count.sku)!==norm(item.sku)){
      throw new AppError('Physical count and owner mapping identity disagree.',409,
        'INVENTORY_DOSSIER_SOURCE_MISMATCH');
    }
    const {focus:category,issues}=classify(item,count,verified);
    focusCounts[category]++;
    rows.push({
      reportRow:item.reportRow,sku:item.sku,
      mappingClassification:item.classification,
      proposedWooProductId:item.latestReview?.decision==='propose_option'
        ? item.latestReview.proposedProductId:null,
      proposedWooVariationId:item.latestReview?.decision==='propose_option'
        ? item.latestReview.proposedVariationId:null,
      proposedSkuMatch:item.latestReview?.decision==='propose_option'
        ? item.latestReview.exactSkuMatch:false,
      ownerMappingDecision:item.latestReview?.decision||null,
      ownerMappingNoteId:item.latestReview?.id||null,
      countStage:count.stage,
      firstClaimRecorded:count.firstClaimId!=null,
      secondClaimRecorded:count.secondClaimId!=null,
      countFollowupDecision:count.triage?.decision||null,
      countFollowupNoteId:count.triage?.id||null,
      countFollowupNeedsRecheck:count.triage?.needsRecheck===true,
      nextReview:category,blockers:issues,
      // Not one row in this pilot can be automatically approved.
      stockImportAuthorized:false,mappingApproved:false,
    });
  }
  const dossierRef=hash({
    physicalHash:physical?.manifestHash||null,
    mappingRef:mappings.identityRef,
    countsRef:counts.snapshotRef,
    rows:rows.map(row=>({
      row:row.reportRow,sku:row.sku,category:row.nextReview,
      mappingId:row.ownerMappingNoteId,
      first:row.firstClaimRecorded,second:row.secondClaimRecorded,
      countStage:row.countStage,followup:row.countFollowupDecision,followupNoteId:row.countFollowupNoteId,
      followupRecheck:row.countFollowupNeedsRecheck,
    })),
  });
  const query=norm(search);
  const filtered=rows.filter(row=>(focus==='all'||row.nextReview===focus)&&(
    !query||norm(row.sku).includes(query)||
    String(row.reportRow).includes(query)||
    String(row.proposedWooProductId??'').includes(query)||
    String(row.proposedWooVariationId??'').includes(query)
  ));
  const total=filtered.length,pages=Math.max(1,Math.ceil(total/pageSize));
  return {
    kind:'read-only-inventory-evidence-dossier',auditOnly:true,
    evidenceVerified:verified,ownerApproved:false,
    independentWitnessVerified:false,sharedStockVerified:false,
    mappingApproved:false,stockImportAuthorized:false,
    checkoutAuthorized:false,
    dossierRef,sourceHash:mappings.sourceHash,
    mappingRef:mappings.identityRef,countRef:counts.snapshotRef,
    totalPhysical:rows.length,focusCounts,
    historicalCountClaims:counts.staleClaimEvents,
    globalBlockers:[
      'no_independently_witnessed_current_physical_stock',
      'no_owner_approved_identity_crosswalk',
      'no_verified_live_woo_stock_reservation',
      'no_verified_website_payment_concurrency',
      'no_approved_trading_rollout',
    ],
    page,pageSize,pages,total,hasMore:page<pages,
    filter:{focus,search},
    items:filtered.slice((page-1)*pageSize,page*pageSize),
    notice:'Pre-launch investigation dossier ONLY. No row is sellable or approved; no Woo orders, payments, stock allocations or quantities were changed.',
  };
}
