import { createHash } from 'node:crypto';
import { listPhysicalMappingCoverage } from './physical-mapping-coverage.js';

// This describes tasks still requiring human evidence. It NEVER records fresh
// physical counts, signs off a Woo mapping, imports inventory or permits sales.
const ACTIONS = Object.freeze({
  held: { priority:'P0', action:'investigate_quarantined_item' },
  missing_physical_sku: { priority:'P0', action:'identify_and_label_physical_item' },
  duplicate_physical_sku: { priority:'P0', action:'resolve_duplicate_physical_skus' },
  ambiguous_website_identity: { priority:'P0', action:'resolve_ambiguous_woo_identity' },
  parent_sku_only: { priority:'P1', action:'verify_exact_size_colour_variation' },
  missing_on_website: { priority:'P1', action:'review_missing_website_product' },
  provisional_match: { priority:'P2', action:'verify_candidate_style_size_and_stock_owner' },
});
const PRIORITIES=new Set(['all','P0','P1','P2']);
const taskTypes=new Set(['all',...Object.values(ACTIONS).map(x=>x.action)]);
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const normalize = x => typeof x==='string' ? x.trim().toUpperCase() : '';

export function planPhysicalRecounts(physical, website, options={}, clock=Date.now(), collectTasks=null){
  const {page=1,pageSize=25,priority='all',action='all',search=''}=options;
  if(!Number.isSafeInteger(page)||page<1||page>10000||
      !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||
      !PRIORITIES.has(priority)||!taskTypes.has(action)||
      typeof search!=='string'||search.length>64){
    throw new RangeError('Invalid stock-count planning filter or page.');
  }
  const allRows=[];
  const mapping=listPhysicalMappingCoverage(physical,website,
    {page:1,pageSize:1},clock,allRows);
  const priorityCounts={P0:0,P1:0,P2:0};
  const actionCounts={};
  const tasks=allRows.map(row=>{
    const plan=ACTIONS[row.status];
    // Unknown mapping classification must not silently become count-ready.
    if(!plan)throw new RangeError('Unknown physical mapping classification.');
    priorityCounts[plan.priority]++;
    actionCounts[plan.action]=(actionCounts[plan.action]||0)+1;
    return {
      reportRow:row.reportRow,
      sku:row.sku,
      mappingStatus:row.status,
      priority:plan.priority,
      nextAction:plan.action,
      // These are historical or provisional IDs, NOT verified mappings.
      candidateWooProductId:row.productId,
      candidateWooVariationId:row.variationId,
      // No fresh counting data have been loaded, signed or accepted.
      physicalCountEvidenceRecorded:false,
      independentRecountEvidenceRecorded:false,
      ownerVerificationRecorded:false,
      stockImportAuthorized:false,
    };
  });
  if (Array.isArray(collectTasks)) collectTasks.push(...tasks);
  // A stable token binds pages to the exact source/mapping observation and
  // review priority logic. Changing the source or Woo identity invalidates it.
  const snapshotRef=hash({mappingRef:mapping.snapshotRef,version:1,tasks});
  const needle=normalize(search);
  const selected=tasks.filter(item=>
    (priority==='all'||item.priority===priority)&&
    (action==='all'||item.nextAction===action)&&
    (!needle||normalize(item.sku).includes(needle)||
      String(item.reportRow).includes(needle)||
      String(item.candidateWooProductId??'').includes(needle)||
      String(item.candidateWooVariationId??'').includes(needle))
  );
  const total=selected.length;
  const pages=Math.max(1,Math.ceil(total/pageSize));
  return {
    kind:'read-only-physical-recount-plan',
    auditOnly:true, checkoutAuthorized:false, sharedStockVerified:false,
    mappingApproved:false, stockImportAuthorized:false,
    freshPhysicalCountVerified:false, independentWitnessVerified:false,
    evidenceVerified:mapping.evidenceVerified,
    physicalManifestSha256:mapping.physicalManifestSha256,
    websiteFetchedAt:mapping.websiteFetchedAt,
    snapshotRef, totalPhysical:allRows.length,
    priorityCounts, actionCounts,
    page,pageSize,pages,total,hasMore:page<pages,
    filter:{priority,action,search},
    tasks:selected.slice((page-1)*pageSize,page*pageSize),
    notice:'Task plan only. Historical quantities are never current stock. Counts and independent witness/owner approvals have not been recorded by this feature. Nothing was imported or sold.',
  };
}
