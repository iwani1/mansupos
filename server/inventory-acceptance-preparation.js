import { createHash } from 'node:crypto';
import { AppError } from './errors.js';
import { buildInventoryDossier } from './inventory-evidence-dossier.js';

// A non-executing evidence PREPARATION checklist. No "pass" or "approved"
// state exists for physical witnessing, identity signoff, Woo reservations,
// payments or trading. Historical SKU/employee claims are only observations.
const GATES=[
  'identity_resolution','owner_option_proposal','two_count_claims',
  'independent_physical_witness','formal_mapping_signoff',
  'live_woo_stock_and_payment_safety',
];
const hash=data=>createHash('sha256').update(JSON.stringify(data)).digest('hex');
const normalize=s=>typeof s==='string'?s.trim().toUpperCase():'';

function assess(row,dossierVerified){
  const held=['held','missing_physical_sku','duplicate_physical_sku',
    'ambiguous_website_identity'].includes(row.mappingClassification);
  const proposed=row.ownerMappingDecision==='propose_option'&&
    Number.isSafeInteger(row.proposedWooProductId)&&row.proposedWooProductId>0;
  const count=row.countStage;
  const checks=[
    {gate:GATES[0],state:held?'investigate':'provisional',
      detail:held?'Quarantined, missing or ambiguous source identity':
        'Historical SKU classification only; verify garment/variant in person'},
    {gate:GATES[1],state:proposed?'recorded_unverified':'missing',
      detail:proposed?'Owner proposed a Woo option; not an approved crosswalk':
        'No current owner Woo product/variation proposal'},
    {gate:GATES[2],state:count==='matching_claims_unverified'?
      'matching_unwitnessed':count==='discrepant_claims'?'discrepant':'incomplete',
      detail:count==='matching_claims_unverified'?
        'Two staff declarations match, but people/physical count are not independently witnessed':
        count==='discrepant_claims'?'Staff declarations disagree: investigate':
        'Two matching distinct-account count claims are not recorded'},
    {gate:GATES[3],state:'not_verified',
      detail:'No independently witnessed current physical count is verified'},
    {gate:GATES[4],state:'not_authorized',
      detail:'No separately authenticated owner identity/crosswalk approval exists'},
    {gate:GATES[5],state:'not_verified',
      detail:'No installed-site Woo reservation, gateway callback and concurrency signoff exists'},
  ];
  if(!dossierVerified)checks.unshift({
    gate:'historical_source_integrity',state:'not_verified',
    detail:'Signed historical source or Woo catalogue snapshot is incomplete/stale',
  });
  return {
    reportRow:row.reportRow,sku:row.sku,
    nextReview:row.nextReview,checks,
    proposalRecorded:proposed,
    staffClaimsAgree:count==='matching_claims_unverified',
    identityHeld:held,
    readyForInventoryImport:false,readyForCheckout:false,approved:false,
  };
}
export function prepareInventoryAcceptance(
  physical,website,mappingEvidence,countClaims,options={},clock=Date.now()
){
  const {page=1,pageSize=25,gate='all',search=''}=options;
  if(!Number.isSafeInteger(page)||page<1||page>10000||
      !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||
      !['all',...GATES,'historical_source_integrity'].includes(gate)||
      typeof search!=='string'||search.length>64){
    throw new AppError('Invalid acceptance preparation filters.',400,
      'INVALID_ACCEPTANCE_PREPARATION_FILTER');
  }
  const dossierRows=[];
  const dossier=buildInventoryDossier(physical,website,mappingEvidence,countClaims,
    {page:1,pageSize:1},clock,dossierRows);
  if(dossierRows.length!==dossier.totalPhysical){
    throw new AppError('Inventory evidence rows cannot be fully reconciled.',409,
      'ACCEPTANCE_PREPARATION_SOURCE_MISMATCH');
  }
  const all=dossierRows.map(row=>assess(row,dossier.evidenceVerified));
  const observations={
    totalHistoricalRows:all.length,
    identityHolds:all.filter(r=>r.identityHeld).length,
    provisionalOwnerProposals:all.filter(r=>r.proposalRecorded).length,
    matchingStaffDeclarations:all.filter(r=>r.staffClaimsAgree).length,
    independentWitnessedRows:0,
    formallyApprovedCrosswalkRows:0,
    stockImportAuthorizedRows:0,
  };
  const ref=hash({dossierRef:dossier.dossierRef,
    evidenceVerified:dossier.evidenceVerified,checks:all.map(r=>({
      row:r.reportRow,sku:r.sku,checks:r.checks.map(c=>[c.gate,c.state]),
    }))});
  const query=normalize(search);
  const selected=all.filter(row=>
    (gate==='all'||row.checks.some(c=>c.gate===gate&&
      !['recorded_unverified','matching_unwitnessed'].includes(c.state)))&&
    (!query||normalize(row.sku).includes(query)||String(row.reportRow).includes(query))
  );
  const total=selected.length;
  const pages=Math.max(1,Math.ceil(total/pageSize));
  return {
    kind:'read-only-inventory-acceptance-preparation',auditOnly:true,
    historicalSourceVerified:dossier.evidenceVerified,
    independentWitnessVerified:false,ownerApproved:false,
    mappingApproved:false,stockImportAuthorized:false,
    sharedStockVerified:false,checkoutAuthorized:false,
    acceptanceCertificateIssued:false,
    preparationRef:ref,dossierRef:dossier.dossierRef,
    sourceHash:dossier.sourceHash,observations,
    mandatoryGlobalEvidence:[
      'independent_witness_identity_and_signed_current_counts',
      'owner_approved_style_colour_size_variation_crosswalk',
      'verified_woo_stock_owner_and_last_unit_reservations',
      'verified_pending_payment_retries_refunds_and_late_callbacks',
      'off_host_recovery_and_supervised_trading_acceptance',
    ],
    page,pageSize,pages,total,hasMore:page<pages,
    filter:{gate,search},items:selected.slice((page-1)*pageSize,page*pageSize),
    notice:'Evidence-preparation checklist only. Entries may be observed or proposed, never approved. This report cannot release stock, change Woo quantities, issue certificates or authorize POS checkout.',
  };
}
