import {createHash} from 'node:crypto';
import {AppError} from './errors.js';
import {buildInventoryDossier} from './inventory-evidence-dossier.js';

// Phase 5.7: read-only readiness / evidence-gap analysis. This is NOT an
// acceptance engine. No current POS witness, provenance or trading gate can
// transition to "verified", "passed", "approved" or "ready".
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const filters=['all','count_disputes','identity_holds','document_problems',
  'reviewer_handoff','other_missing'];
const LOCKED=Object.freeze({
  auditOnly:true,independentHumanIdentityVerified:false,
  independentWitnessVerified:false,originalDocumentAuthenticated:false,
  currentPhysicalCountVerified:false,signatureVerified:false,
  mappingApproved:false,ownerApproved:false,
  inventoryAccepted:false,acceptanceCertificateIssued:false,
  sharedStockVerified:false,liveReservationVerified:false,
  paymentConcurrencyVerified:false,backupRestoreVerified:false,
  stockImportAuthorized:false,checkoutAuthorized:false,paymentsAuthorized:false,
  releaseReady:false,
});
const GLOBAL_REQUIREMENTS=Object.freeze([
  {id:'independent_witness_proof',required:'Independently establish reviewer identity, independence and signed physical-count attendance',
    verified:false,source:'external_proof_required'},
  {id:'physical_original_count_reconciliation',required:'Recount the current physical garments and reconcile disputed units against original signed documents',
    verified:false,source:'external_proof_required'},
  {id:'style_colour_size_approved_crosswalk',required:'Inspect every style, colour, size and Woo product/variation identity; obtain separate authenticated Owner mapping approval',
    verified:false,source:'external_proof_required'},
  {id:'woo_stock_authority_and_reservations',required:'Verify one inventory authority, atomic last-unit reservation, order cancellation and concurrent online/in-store demand',
    verified:false,source:'installed_website_test_required'},
  {id:'payment_refund_callback_safety',required:'Verify Paystack callback ordering, retries, duplicate payments, refunds and pending orders on a disposable test site',
    verified:false,source:'installed_website_test_required'},
  {id:'off_host_recovery_and_controlled_launch',required:'Demonstrate an independently checked off-site backup restore, rollback, security review and supervised trading launch',
    verified:false,source:'manual_acceptance_required'},
]);
function ownerOnly(user){
  if(user?.role!=='owner')throw new AppError(
    'Only the Owner may inspect inventory-acceptance readiness.',403,
    'INVENTORY_READINESS_OWNER_ONLY');
}
function check(id,state,evidence,required){
  return {id,state,evidence,required,independentlyVerified:false};
}
function assess(dossier,exception){
  const flags=exception.flags||[];
  const has=flag=>flags.includes(flag);
  const held=['held','missing_physical_sku','duplicate_physical_sku',
    'ambiguous_website_identity'].includes(dossier.mappingClassification)||
    dossier.nextReview==='identity_hold';
  const proposed=dossier.ownerMappingDecision==='propose_option';
  const skuMatched=proposed&&dossier.proposedSkuMatch===true;
  const matching=dossier.countStage==='matching_claims_unverified';
  const disputed=dossier.countStage==='discrepant_claims'||
    exception.countDiscrepancyOpen;
  const documentProblem=has('custody_or_source_not_ready')||
    has('file_not_available_reported')||
    has('fingerprint_mismatch_reported')||
    has('owner_reported_discrepancy_unverified')||
    has('reviewer_account_reported_issue');
  const accounts=exception.reviewerAssignments||[];
  const active=accounts.filter(a=>a.status==='assigned_metadata_only');
  const receipts=active.map(a=>a.receiptObservation);
  const anyHashMismatch=receipts.includes('fingerprint_mismatch_reported');
  const anyHashClaimMatch=receipts.includes('fingerprint_match_reported');
  const anyFileMissing=receipts.includes('file_not_available');
  const completeHandoff=active.some(a=>a.handoffStatus==='account_receipt_recorded');
  const criteria=[
    check('source_sku_identity',held?'held':'observed_unverified',
      held?'Historical source identity is ambiguous or quarantined':
        'Historical SKU classification exists; physical style/size identity not witnessed',
      'Inspect physical product identity against source and published Woo option'),
    check('owner_variation_proposal',proposed?'observed_unverified':'missing',
      skuMatched?'Owner proposes a SKU-matching Woo option, NOT an approved crosswalk':
        proposed?'Owner proposes a differing/ambiguous option; verify variation':
          'Owner has not recorded a current product/variation proposal',
      'Reconcile exact style, colour, size and product/variation mapping'),
    check('two_staff_declarations',disputed?'conflicting':matching?'observed_unverified':'missing',
      disputed?'Staff counts disagree; existing discrepancy remains OPEN':
        matching?'Two staff declaration values match; no independent witnessed count':
          'Two matching, distinct-account staff count claims are not recorded',
      'Obtain independent and supervised current physical count evidence'),
    check('private_original_custody',has('custody_or_source_not_ready')?'missing':'observed_unverified',
      has('custody_or_source_not_ready')?'Manifest/custody/request evidence is incomplete':
        'Owner reports custody or review request; original provenance remains unverified',
      'Examine original signed count sheet and custody trail outside this POS'),
    check('reviewer_handoff_account',!active.length?'missing':
      completeHandoff?'observed_unverified':'missing',
      completeHandoff?'Assigned POS account reports possession of out-of-band challenge':
        active.length?'Reviewer account assigned; handoff not confirmed':
          'No current dedicated reviewer assignment',
      'Independently check reviewer identity and securely deliver original evidence'),
    check('reported_file_fingerprint',anyHashMismatch?'conflicting':
      anyFileMissing?'missing':anyHashClaimMatch?'observed_unverified':'missing',
      anyHashMismatch?'Reviewer account reports differing SHA-256':
        anyFileMissing?'Reviewer account reports missing original file':
          anyHashClaimMatch?'Matching SHA-256 reported; file originality is NOT verified':
            'No matching externally examined file hash is recorded',
      'Compare independently preserved original file against signed manifest'),
    check('independent_witness_identity','not_verified',
      'POS account, Owner identity declaration and secret receipt do not verify a human witness',
      'Obtain independent reviewer identity, independence and signed physical count proof'),
    check('signed_current_count_reconciliation','not_verified',
      disputed?'Unresolved staff count dispute and no independently signed current count':
        'No independently authenticated current physical count reconciliation',
      'Verify every physical quantity and resolve discrepancies outside POS'),
    check('formal_owner_mapping_acceptance','not_authorized',
      'Owner proposal is not formal approval; no final crosswalk authorization exists',
      'Complete independent physical proof and separately authenticated Owner mapping signoff'),
  ];
  const priority=disputed?'count_disputes':held?'identity_holds':
    documentProblem?'document_problems':
    !completeHandoff?'reviewer_handoff':'other_missing';
  return {
    reportRow:dossier.reportRow,sku:dossier.sku,priority,
    dossierFocus:dossier.nextReview,
    exceptionCategory:exception.category,
    exceptionFlags:[...flags],
    ownerProposalRecorded:proposed,
    staffCountsMatchingUnverified:matching,
    staffCountDiscrepancyOpen:Boolean(disputed),
    localHandoffClaimRecorded:completeHandoff,
    reportedFileFingerprintMatch:anyHashClaimMatch,
    criteria,
    readiness:'blocked',
    independentlyVerified:false,approved:false,
    stockImportAuthorized:false,checkoutAuthorized:false,
    evidenceRef:hash({
      dossier:dossier,exceptionRef:exception.caseRef,
      exceptionCategory:exception.category,exceptionFlags:flags,
      reviewerAssignments:accounts,
    }),
  };
}
export function buildInventoryVerificationReadiness(
  physical,website,mappingEvidence,countClaims,exceptions,user,
  options={},clock=Date.now(),collectRows=null
){
  ownerOnly(user);
  const {page=1,pageSize=25,focus='all',search=''}=options;
  if(!Number.isSafeInteger(page)||page<1||page>10000||
    !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||
    !filters.includes(focus)||typeof search!=='string'||search.length>64)
    throw new AppError('Invalid inventory readiness filters.',400,
      'INVENTORY_READINESS_INVALID_FILTER');
  const sourceRows=[],exceptionRows=[];
  const dossier=buildInventoryDossier(
    physical,website,mappingEvidence,countClaims,{page:1,pageSize:1},clock,sourceRows);
  const exceptionReport=exceptions.list(user,physical,website,
    {page:1,pageSize:1},clock,exceptionRows);
  if(!dossier.evidenceVerified||dossier.sourceHash!==physical?.manifestHash||
    !Array.isArray(sourceRows)||!Array.isArray(exceptionRows)||
    sourceRows.length!==dossier.totalPhysical||sourceRows.length!==exceptionReport.summary.totalCases)
    throw new AppError('The physical inventory and exception evidence are not aligned.',
      409,'INVENTORY_READINESS_EVIDENCE_MISMATCH');
  const exceptionMap=new Map();
  for(const row of exceptionRows){
    if(!Number.isSafeInteger(row.reportRow)||row.reportRow<1||
      exceptionMap.has(row.reportRow))
      throw new AppError('Duplicate or invalid source row in exception evidence.',409,
        'INVENTORY_READINESS_DUPLICATE_ROW');
    exceptionMap.set(row.reportRow,row);
  }
  const assessed=sourceRows.map(row=>{
    const exception=exceptionMap.get(row.reportRow);
    if(!exception||row.sku.trim().toUpperCase()!==exception.sku.trim().toUpperCase())
      throw new AppError('Mapping, staff count and reviewer evidence disagree on SKU identity.',
        409,'INVENTORY_READINESS_ROW_MISMATCH');
    return assess(row,exception);
  });
  if(Array.isArray(collectRows))collectRows.push(...assessed);
  const readinessRef=hash({
    version:1,physicalHash:physical.manifestHash,
    dossierRef:dossier.dossierRef,exceptionRef:exceptionReport.snapshotRef,
    items:assessed.map(r=>({row:r.reportRow,evidenceRef:r.evidenceRef})),
    globalRequirements:GLOBAL_REQUIREMENTS.map(x=>x.id),
  });
  const query=search.trim().toUpperCase();
  const selected=assessed.filter(row=>
    (focus==='all'||row.priority===focus)&&
    (!query||row.sku.toUpperCase().includes(query)||
      String(row.reportRow).includes(query)));
  const total=selected.length,pages=Math.max(1,Math.ceil(total/pageSize));
  return {
    kind:'owner-inventory-verification-readiness',
    readinessRef,sourceHash:dossier.sourceHash,
    dossierRef:dossier.dossierRef,exceptionRef:exceptionReport.snapshotRef,
    summary:{
      totalHistoricalRows:assessed.length,
      countDisputes:assessed.filter(x=>x.staffCountDiscrepancyOpen).length,
      identityHolds:assessed.filter(x=>x.priority==='identity_holds').length,
      ownerProposalsRecorded:assessed.filter(x=>x.ownerProposalRecorded).length,
      matchingStaffClaimsUnverified:assessed.filter(x=>x.staffCountsMatchingUnverified).length,
      localHandoffClaimsRecorded:assessed.filter(x=>x.localHandoffClaimRecorded).length,
      reportedHashMatchesUnverified:assessed.filter(x=>x.reportedFileFingerprintMatch).length,
      independentlyVerifiedRows:0,acceptedRows:0,readyForStockImport:0,
    },
    page,pageSize,pages,total,hasMore:page<pages,
    filters,filter:{focus,search},
    globalRequirements:GLOBAL_REQUIREMENTS.map(x=>({...x})),
    items:selected.slice((page-1)*pageSize,page*pageSize),
    ...LOCKED,
    notice:'Read-only acceptance readiness ANALYSIS. Locally recorded counts, Owner proposals and reviewer reports are observations only. Every row and every global requirement remain BLOCKED; no stock import, checkout or payment is authorized.',
  };
}
