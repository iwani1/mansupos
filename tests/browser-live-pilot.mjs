import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

// Reuse only the isolated demo server and substitute a pilot session in the
// browser; this test NEVER connects to or stores data from the live website.
const { browser, page, pageErrors } = await openBrowser();
try {
  await page.route('**/api/auth/demo', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.config = {
      ...data.config, mode: 'live', liveReadOnly: true, configured: true,
      writesEnabled: false, wholesaleWritesEnabled: false, requireShift: false,
      paymentMethods: ['cash'], storeUrl: 'https://mansutrendzgh.com',
    };
    await route.fulfill({ response, json: data });
  });
  const auditCalls = [];
  await page.route('**/api/stock-safety/audit', async route => {
    auditCalls.push(route.request().method());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      kind: 'read-only-shared-woo-stock-audit', auditOnly: true, checkoutAuthorized: false,
      sharedLastUnitGuardVerified: false, requiresOwnerOrManagerReview: true,
      catalogue: { source: 'woocommerce', fetchedAt: '2026-11-14T20:00:00.000Z',
        complete: true, stale: false, products: 1, selectableOptions: 3,
        unavailableOptions: 0, managedStockPools: 1, sharedParentOrVariationPools: 1 },
      issueCounts: { backorders_enabled: 1 },
      examples: [{ code: 'backorders_enabled', productId: 73, variationId: 74 }],
      limitations: ['This audit cannot authorize checkout.'],
    }) });
  });
  // Synthetic SKU mapping audit: the browser never contacts production WooCommerce.
  const skuReviewCalls = [];
  await page.route('**/api/stock-safety/source-match', async route => {
    skuReviewCalls.push({kind:'summary',method:route.request().method()});
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      kind:'read-only-cross-channel-sku-audit',
      auditOnly:true,checkoutAuthorized:false,sharedStockVerified:false,evidenceVerified:true,
      physical:{total:1571,quarantined:41,manifestSha256:'a'.repeat(64)},
      website:{distinctOptionSkus:27,fetchedAt:'2026-11-15T12:00:00.000Z'},
      matchedPhysical:0,
      issueCounts:{physical_not_in_published_woo:27},
      examples:[{code:'physical_not_in_published_woo',sku:'TEST001',productId:null,variationId:null}],
    })});
  });
  await page.route('**/api/stock-safety/source-review*', async route => {
    const url = new URL(route.request().url());
    const requestedPage = Number(url.searchParams.get('page') || 1);
    skuReviewCalls.push({kind:'queue',method:route.request().method(),page:requestedPage,
      expectedRef:url.searchParams.get('expectedRef')||''});
    const all = Array.from({length:27},(_,i)=>({
      code:'physical_not_in_published_woo',sku:'TEST'+String(i+1).padStart(3,'0'),
      productId:null,variationId:null,reportRow:i+1,
    }));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      kind:'read-only-cross-channel-sku-review',
      auditOnly:true,checkoutAuthorized:false,sharedStockVerified:false,evidenceVerified:true,
      snapshotRef:'f'.repeat(64),
      page:requestedPage,pageSize:25,pages:2,total:27,hasMore:requestedPage===1,
      issueCounts:{physical_not_in_published_woo:27},
      websiteFetchedAt:'2026-11-15T12:00:00.000Z',
      findings:all.slice((requestedPage-1)*25,requestedPage*25),
    })});
  });
  // Synthetic physical-to-Woo mapping workbench: read-only, all source rows.
  const mappingCalls = [];
  await page.route('**/api/stock-safety/physical-mapping*',async route=>{
    const url=new URL(route.request().url());
    const pageNumber=Number(url.searchParams.get('page')||1);
    const status=url.searchParams.get('status')||'all';
    const lookup=url.searchParams.get('search')||'';
    mappingCalls.push({
      method:route.request().method(),page:pageNumber,status,
      expectedRef:url.searchParams.get('expectedRef')||'',
    });
    const sourceRows=Array.from({length:27},(_,i)=>({
      reportRow:i+1,sku:'MAP'+String(i+1).padStart(3,'0'),
      status:i<2?'provisional_match':i===2?'held':'missing_on_website',
      productId:i<2?90+i:null,variationId:null,websiteCandidates:i<2?1:0,
    }));
    const selected=sourceRows.filter(item=>(status==='all'||item.status===status)&&
      (!lookup||item.sku.includes(lookup.toUpperCase())));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      kind:'read-only-physical-mapping-coverage',
      auditOnly:true,checkoutAuthorized:false,sharedStockVerified:false,
      mappingApproved:false,evidenceVerified:true,
      snapshotRef:'e'.repeat(64),
      page:pageNumber,pageSize:25,pages:Math.max(1,Math.ceil(selected.length/25)),
      total:selected.length,totalPhysical:27,
      hasMore:pageNumber<Math.ceil(selected.length/25),
      counts:{provisional_match:2,held:1,missing_on_website:24,
        missing_physical_sku:0,duplicate_physical_sku:0,parent_sku_only:0,
        ambiguous_website_identity:0},
      websiteFetchedAt:'2026-11-15T12:00:00.000Z',
      rows:selected.slice((pageNumber-1)*25,pageNumber*25),
    })});
  });
  // Synthetic owner mapping proposals. Never contacts production Woo.
  const ownerMappingCalls=[];
  let ownerMappingLatest=null;
  await page.route('**/api/stock-safety/owner-mapping-evidence*',async route=>{
    const request=route.request();
    if(request.method()==='POST'){
      const body=request.postDataJSON();
      ownerMappingCalls.push({method:'POST',body});
      ownerMappingLatest={
        id:601,decision:body.decision,note:body.note,
        proposedProductId:body.proposedProductId,
        proposedVariationId:body.proposedVariationId,
        proposedSku:'OWNER001',exactSkuMatch:true,
        actor:'synthetic-owner',
        mappingApproved:false,recordedAt:'2026-11-15T12:00:00.000Z',
      };
      await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({
        kind:'local-unverified-owner-mapping-proposal',
        recorded:true,replayed:false,reviewId:601,auditOnly:true,
        mappingApproved:false,checkoutAuthorized:false,stockImportAuthorized:false,
      })});
      return;
    }
    const url=new URL(request.url());
    const requestedPage=Number(url.searchParams.get('page')||1);
    ownerMappingCalls.push({method:'GET',page:requestedPage,
      expectedRef:url.searchParams.get('expectedRef')||''});
    const entries=[
      {reportRow:1,sku:'OWNER001',classification:'provisional_match',
       initialProductId:101,initialVariationId:null,latestReview:ownerMappingLatest,
       mappingApproved:false,stockImportAuthorized:false},
      {reportRow:2,sku:'OWNER002',classification:'missing_on_website',
       initialProductId:null,initialVariationId:null,latestReview:null,
       mappingApproved:false,stockImportAuthorized:false},
    ];
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      kind:'local-owner-mapping-evidence-review',auditOnly:true,
      checkoutAuthorized:false,stockImportAuthorized:false,
      sharedStockVerified:false,mappingApproved:false,evidenceVerified:true,
      sourceHash:'a'.repeat(64),identityRef:'b'.repeat(64),
      page:requestedPage,pageSize:25,pages:1,total:2,hasMore:false,
      counts:{notReviewed:ownerMappingLatest?1:2,proposed:ownerMappingLatest?1:0,
        investigation:0,hold:0},
      items:entries,
    })});
  });
  // Synthetic owner dossier is read-only and never reaches production Woo.
  const dossierCalls=[];
  await page.route('**/api/stock-safety/inventory-dossier*',async route=>{
    const url=new URL(route.request().url());
    const pageNumber=Number(url.searchParams.get('page')||1);
    const focus=url.searchParams.get('focus')||'all';
    dossierCalls.push({method:route.request().method(),page:pageNumber,focus,
      expectedRef:url.searchParams.get('expectedRef')||''});
    const rows=Array.from({length:27},(_,i)=>({
      reportRow:i+1,sku:'DOSSIER'+String(i+1).padStart(3,'0'),
      mappingClassification:i===2?'held':'provisional_match',
      ownerMappingDecision:i===0?'propose_option':null,
      proposedWooProductId:i===0?101:null,proposedWooVariationId:null,
      proposedSkuMatch:i===0,countStage:'first_needed',
      nextReview:i===2?'identity_hold':i===0?'first_count_missing':'mapping_not_proposed',
      blockers:i===2?['unresolved_physical_identity','owner_mapping_proposal_missing',
        'independent_physical_witness_unverified','woo_stock_reservation_unverified']:
        ['first_count_missing','independent_physical_witness_unverified',
        'woo_stock_reservation_unverified'],
      stockImportAuthorized:false,mappingApproved:false,
    }));
    const selected=rows.filter(row=>focus==='all'||row.nextReview===focus);
    const pages=Math.max(1,Math.ceil(selected.length/25));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      kind:'read-only-inventory-evidence-dossier',auditOnly:true,
      evidenceVerified:true,ownerApproved:false,
      independentWitnessVerified:false,sharedStockVerified:false,
      mappingApproved:false,stockImportAuthorized:false,checkoutAuthorized:false,
      dossierRef:'c'.repeat(64),sourceHash:'a'.repeat(64),
      mappingRef:'b'.repeat(64),countRef:'d'.repeat(64),
      totalPhysical:27,historicalCountClaims:0,
      focusCounts:{identity_hold:1,mapping_not_proposed:25,first_count_missing:1,
        mapping_investigation:0,sku_difference:0,second_count_missing:0,
        count_discrepancy:0,matching_count_unverified:0,source_mismatch:0},
      globalBlockers:['no_independently_witnessed_current_physical_stock',
        'no_approved_trading_rollout'],
      page:pageNumber,pageSize:25,pages,total:selected.length,
      hasMore:pageNumber<pages,
      items:selected.slice((pageNumber-1)*25,pageNumber*25),
    })});
  });
  // Synthetic GET-only owner acceptance-preparation checklist.
  const acceptanceCalls=[];
  await page.route('**/api/stock-safety/acceptance-preparation*',async route=>{
    const url=new URL(route.request().url());
    const pageNo=Number(url.searchParams.get('page')||1);
    const gate=url.searchParams.get('gate')||'all';
    acceptanceCalls.push({method:route.request().method(),pageNo,gate,
      expectedRef:url.searchParams.get('expectedRef')||''});
    const gateCheck=(name,state,detail)=>({gate:name,state,detail});
    const rows=Array.from({length:27},(_,i)=>({
      reportRow:i+1,sku:'ACCEPT'+String(i+1).padStart(3,'0'),
      nextReview:i===0?'identity_hold':'mapping_not_proposed',
      identityHeld:i===0,proposalRecorded:false,staffClaimsAgree:false,
      approved:false,readyForInventoryImport:false,readyForCheckout:false,
      checks:[
        gateCheck('identity_resolution',i===0?'investigate':'provisional','Historical source only'),
        gateCheck('owner_option_proposal','missing','No proposal'),
        gateCheck('two_count_claims','incomplete','Missing count claims'),
        gateCheck('independent_physical_witness','not_verified','Witness not verified'),
        gateCheck('formal_mapping_signoff','not_authorized','No approved identity crosswalk'),
        gateCheck('live_woo_stock_and_payment_safety','not_verified','Woo safety unverified'),
      ],
    }));
    const selected=gate==='historical_source_integrity'?[]:rows;
    const pages=Math.max(1,Math.ceil(selected.length/25));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      kind:'read-only-inventory-acceptance-preparation',
      auditOnly:true,historicalSourceVerified:true,
      independentWitnessVerified:false,ownerApproved:false,
      mappingApproved:false,stockImportAuthorized:false,
      sharedStockVerified:false,checkoutAuthorized:false,
      acceptanceCertificateIssued:false,
      preparationRef:'f'.repeat(64),dossierRef:'c'.repeat(64),
      sourceHash:'a'.repeat(64),
      observations:{totalHistoricalRows:27,identityHolds:1,
        provisionalOwnerProposals:0,matchingStaffDeclarations:0,
        independentWitnessedRows:0,formallyApprovedCrosswalkRows:0,
        stockImportAuthorizedRows:0},
      mandatoryGlobalEvidence:['independent_witness_identity_and_signed_current_counts',
        'owner_approved_style_colour_size_variation_crosswalk',
        'verified_woo_stock_owner_and_last_unit_reservations'],
      page:pageNo,pageSize:25,pages,total:selected.length,
      hasMore:pageNo<pages,
      items:selected.slice((pageNo-1)*25,pageNo*25),
    })});
  });
  // Synthetic physical recount planning: ALL count fields remain blank.
  const recountCalls=[];
  await page.route('**/api/stock-safety/recount-plan*',async route=>{
    const url=new URL(route.request().url());
    const requestedPage=Number(url.searchParams.get('page')||1);
    const priority=url.searchParams.get('priority')||'all';
    recountCalls.push({
      method:route.request().method(),page:requestedPage,priority,
      expectedRef:url.searchParams.get('expectedRef')||'',
    });
    const all=Array.from({length:27},(_,i)=>({
      reportRow:i+1,sku:'RECOUNT'+String(i+1).padStart(3,'0'),
      mappingStatus:i===2?'held':i<2?'provisional_match':'missing_on_website',
      priority:i===2?'P0':i<2?'P2':'P1',
      nextAction:i===2?'investigate_quarantined_item':
        i<2?'verify_candidate_style_size_and_stock_owner':'review_missing_website_product',
      candidateWooProductId:i<2?201+i:null,candidateWooVariationId:null,
      physicalCountEvidenceRecorded:false,independentRecountEvidenceRecorded:false,
      ownerVerificationRecorded:false,stockImportAuthorized:false,
    }));
    const selected=all.filter(item=>priority==='all'||item.priority===priority);
    const total=selected.length;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      kind:'read-only-physical-recount-plan',
      auditOnly:true,checkoutAuthorized:false,sharedStockVerified:false,
      mappingApproved:false,stockImportAuthorized:false,
      freshPhysicalCountVerified:false,independentWitnessVerified:false,
      evidenceVerified:true,physicalManifestSha256:'a'.repeat(64),
      websiteFetchedAt:'2026-11-15T12:00:00.000Z',
      snapshotRef:'d'.repeat(64),totalPhysical:27,
      priorityCounts:{P0:1,P1:24,P2:2},
      actionCounts:{investigate_quarantined_item:1,review_missing_website_product:24,
        verify_candidate_style_size_and_stock_owner:2},
      page:requestedPage,pageSize:25,
      pages:Math.max(1,Math.ceil(total/25)),total,
      hasMore:requestedPage<Math.ceil(total/25),
      tasks:selected.slice((requestedPage-1)*25,requestedPage*25),
    })});
  });
  // Count review fixture intentionally has no approval or Woo stock writes.
  const countReviewCalls=[];
  const ownerTriageCalls=[];
  let mockTriage=null;
  await page.route('**/api/stock-safety/count-owner-triage',async route=>{
    const body=route.request().postDataJSON();
    ownerTriageCalls.push({method:route.request().method(),body});
    mockTriage={
      id:501,decision:body.decision,note:body.note,
      needsRecheck:false,recordedAt:'2026-11-15T12:00:00.000Z',
      recordedBy:'synthetic-owner',
    };
    await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({
      kind:'local-unverified-count-owner-triage',recorded:true,replayed:false,
      triageId:501,auditOnly:true,ownerApproved:false,
      stockImportAuthorized:false,checkoutAuthorized:false,
      independentWitnessVerified:false,
    })});
  });
  await page.route('**/api/stock-safety/count-claims-review*',async route=>{
    countReviewCalls.push(route.request().method());
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      kind:'local-unverified-physical-count-owner-review',
      auditOnly:true,checkoutAuthorized:false,stockImportAuthorized:false,
      ownerApproved:false,independentWitnessVerified:false,evidenceVerified:true,
      snapshotRef:'a'.repeat(64),staleClaimEvents:0,
      page:1,pageSize:25,pages:1,total:2,hasMore:false,
      totals:{identityHolds:0,firstNeeded:0,secondNeeded:1,
        matchingUnverified:0,discrepancies:1},
      items:[
        {reportRow:1,sku:'CLAIM001',stage:'discrepant_claims',
          firstUnits:3,secondUnits:4,firstClaimId:100,secondClaimId:101,
          triage:mockTriage,ownerApproved:false},
        {reportRow:2,sku:'CLAIM002',stage:'second_needed',
          firstUnits:5,secondUnits:null,firstClaimId:102,secondClaimId:null,
          triage:null,ownerApproved:false},
      ],
    })});
  });
  // Phase 5.0: owner supervision claims, never verified independent witnesses.
  const supervisionCalls=[];
  let recordedSupervision=null;
  await page.route('**/api/stock-safety/count-supervision*',async route=>{
    const request=route.request();
    if(request.method()==='POST'){
      const body=request.postDataJSON();
      supervisionCalls.push({method:'POST',body});
      recordedSupervision={
        id:707,action:body.action,note:body.note,
        documentCode:body.documentCode,actor:'synthetic-owner',
        recordedAt:'2026-11-15T12:00:00.000Z',requiresRecheck:false,
      };
      await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({
        kind:'unverified-count-supervision-note',recorded:true,
        replayed:false,noteId:707,auditOnly:true,
        independentWitnessVerified:false,ownerApproved:false,
        stockImportAuthorized:false,checkoutAuthorized:false,
      })});
      return;
    }
    const u=new URL(request.url());
    supervisionCalls.push({method:'GET',page:u.searchParams.get('page')||'1'});
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      kind:'local-count-supervision-evidence',
      auditOnly:true,evidenceVerified:true,sourceHash:'a'.repeat(64),
      snapshotRef:(recordedSupervision?'8':'9').repeat(64),
      physicallyWitnessed:false,independentWitnessVerified:false,
      ownerApproved:false,mappingApproved:false,sharedStockVerified:false,
      stockImportAuthorized:false,checkoutAuthorized:false,
      page:1,pageSize:25,pages:1,total:2,hasMore:false,
      totals:{awaitingTwoCounts:1,openDiscrepancies:1,
        unverifiedNotes:recordedSupervision?1:0,physicalWitnessesVerified:0},
      items:[
        {reportRow:1,sku:'CLAIM001',countStage:'discrepant_claims',
          firstClaimId:100,secondClaimId:101,
          firstCounterAccountId:'rep-1',secondCounterAccountId:'packer-2',
          status:'count_discrepancy_open',latestNote:recordedSupervision,
          physicallyWitnessed:false,acceptedInventory:false},
        {reportRow:2,sku:'CLAIM002',countStage:'second_needed',
          firstClaimId:102,secondClaimId:null,
          firstCounterAccountId:'rep-1',secondCounterAccountId:null,
          status:'waiting_for_two_counts',latestNote:null,
          physicallyWitnessed:false,acceptedInventory:false},
      ],
    })});
  });
  // Phase 5.1: local-only file SHA256 metadata, never document bytes.
  const manifestCalls=[];
  let mockManifest=null;
  await page.route('**/api/stock-safety/count-file-manifests*',async route=>{
    const req=route.request();
    if(req.method()==='POST'){
      const body=req.postDataJSON();
      manifestCalls.push({method:'POST',body});
      mockManifest={
        id:809,documentCode:body.documentCode,documentType:body.documentType,
        mime:body.mime,fileBytes:body.fileBytes,fileSha256:body.fileSha256,
        submittedByAccount:'synthetic-owner',
        recordedAt:'2026-11-15T12:00:00.000Z',
        requiresRecheck:false,documentContentUploaded:false,
        signatureVerified:false,independentWitnessVerified:false,
        sameBytesReferencedElsewhere:false,
      };
      await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({
        kind:'unverified-local-count-file-manifest',recorded:true,replayed:false,
        manifestId:809,auditOnly:true,documentContentUploaded:false,
        independentWitnessVerified:false,ownerApproved:false,
        stockImportAuthorized:false,checkoutAuthorized:false,
      })});
      return;
    }
    const url=new URL(req.url());
    manifestCalls.push({method:'GET',expectedRef:url.searchParams.get('expectedRef')||''});
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      kind:'owner-private-count-file-manifest-review',auditOnly:true,
      snapshotRef:(mockManifest?'e':'d').repeat(64),
      supervisionRef:'8'.repeat(64),evidenceVerified:true,
      sourceHash:'a'.repeat(64),
      totalRecordedUnverified:mockManifest?1:0,
      documentContentUploaded:false,fileSignatureVerified:false,
      independentWitnessVerified:false,ownerApproved:false,mappingApproved:false,
      sharedStockVerified:false,stockImportAuthorized:false,checkoutAuthorized:false,
      page:1,pageSize:25,pages:1,total:2,hasMore:false,
      items:[
        {reportRow:1,sku:'CLAIM001',countStage:'discrepant_claims',
          firstClaimId:100,secondClaimId:101,status:'count_discrepancy_open',
          latestManifest:mockManifest,mayRecord:true,
          approved:false,stockImportAuthorized:false},
        {reportRow:2,sku:'CLAIM002',countStage:'second_needed',
          firstClaimId:102,secondClaimId:null,status:'waiting_for_counts',
          latestManifest:null,mayRecord:false,
          approved:false,stockImportAuthorized:false},
      ],
    })});
  });
  // Owner custody assertions and review-handoff PREPARATION, no file delivery.
  const custodyCalls=[];
  const custodyEvents=[];
  await page.route('**/api/stock-safety/evidence-custody*',async route=>{
    const req=route.request();
    if(req.method()==='POST'){
      const body=req.postDataJSON();
      custodyCalls.push({method:'POST',body});
      custodyEvents.push({
        id:900+custodyEvents.length,action:body.action,
        locationCode:body.locationCode,reviewChannel:body.reviewChannel,
        note:body.note,recordedByAccount:'synthetic-owner',
        recordedAt:'2026-11-15T12:00:00.000Z',
        needsRecheck:false,independentReviewConfirmed:false,
      });
      await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({
        kind:'unverified-owner-custody-event',recorded:true,
        replayed:false,eventId:custodyEvents.at(-1).id,
        auditOnly:true,documentBytesStored:false,
        independentReviewConfirmed:false,independentWitnessVerified:false,
        ownerApproved:false,stockImportAuthorized:false,checkoutAuthorized:false,
      })});
      return;
    }
    const latest=custodyEvents.at(-1)||null;
    custodyCalls.push({method:'GET'});
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      kind:'owner-unverified-evidence-custody',auditOnly:true,
      evidenceVerified:true,snapshotRef:(latest?'c':'b').repeat(64),
      manifestRef:'e'.repeat(64),sourceHash:'a'.repeat(64),
      documentBytesStored:false,documentSignatureVerified:false,
      independentWitnessVerified:false,independentReviewConfirmed:false,
      ownerApproved:false,mappingApproved:false,sharedStockVerified:false,
      stockImportAuthorized:false,checkoutAuthorized:false,
      tally:{manifestMissing:1,custodyNotesCurrent:latest?1:0,
        reviewsRequestedUnconfirmed:latest?.action==='independent_review_requested'?1:0,
        countDiscrepanciesOpen:1,independentlyVerifiedOriginals:0},
      page:1,pageSize:25,pages:1,total:2,hasMore:false,
      items:[
        {reportRow:1,sku:'CLAIM001',
          firstClaimId:100,secondClaimId:101,
          manifest:{
            id:809,documentCode:'PRIVATE_COUNT_0001',
            documentType:'count_sheet',fileSha256:mockManifest?.fileSha256||'f'.repeat(64),
            fileBytes:mockManifest?.fileBytes||31,requiresRecheck:false,
            signatureVerified:false,
          },
          status:'count_discrepancy_open',countDiscrepancyOpen:true,
          latestCustodyEvent:latest,mayRecord:true,
          independentReviewConfirmed:false,originalAuthenticityVerified:false,
          inventoryAccepted:false,stockImportAuthorized:false},
        {reportRow:2,sku:'CLAIM002',firstClaimId:102,secondClaimId:null,
          manifest:null,status:'waiting_for_counts',
          countDiscrepancyOpen:false,latestCustodyEvent:null,mayRecord:false,
          independentReviewConfirmed:false,originalAuthenticityVerified:false,
          inventoryAccepted:false,stockImportAuthorized:false},
      ],
    })});
  });
  const paymentReviewCalls = [];
  await page.route('**/api/payments/reconciliation*', async route => {
    paymentReviewCalls.push(route.request().method());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      kind: 'read-only-pos-payment-reconciliation', auditOnly: true,
      checkoutAuthorized: false, mutationsAllowed: false, source: 'local-pos-ledger',
      websiteOrdersIncluded: false, gatewaySettlementVerified: false,
      refundPayoutVerified: false, fullCaseCount: 1,
      pageSummary: { cases: 1, urgentCases: 1,
        unconfirmedCashCustodyCents: 12000, unverifiedCashRefundCents: 0 },
      cases: [{ id: '00000000-0000-4000-8000-000000000001',
        number: 'POS-SYNTHETIC', status: 'needs_reconciliation',
        wooOrderId: 123, originalShiftId: 'synthetic-shift',
        originalShiftStatus: 'closed', totalCents: 12000, refundedCents: 0,
        updatedAt: '2026-11-15T12:00:00.000Z', issueCodes: ['cash_custody_unconfirmed'],
        priority: 'urgent', evidence: {
          posCashCustodyRecorded: true, posWooPaymentVerifiedEvent: false,
        } }],
      hasMore: false, nextCursor: null,
      notice: 'Local POS-only evidence; external settlements are excluded.',
    }) });
  });
  const financialHistoryCalls = [];
  // Specific route is registered LAST so it takes precedence over the
  // reconciliation list route; no real POS/Woo/Paystack request is sent.
  await page.route('**/api/payments/reconciliation/*/review', async route => {
    financialHistoryCalls.push(route.request().method());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      kind: 'non-executing-finance-review', source: 'local-pos-ledger',
      actionsAvailable: false, refundAuthorized: false, refundExecuted: false,
      cashPaidOut: false, stockRestored: false, gatewaySettlementVerified: false,
      saleId: '00000000-0000-4000-8000-000000000001',
      saleStatus: 'needs_reconciliation', saleUpdatedAt: '2026-11-15T12:00:00.000Z',
      wooOrderId: 123, issueCodes: ['cash_custody_unconfirmed'],
      availableSteps: ['reconcile_pos_cash_custody'], entries: [], truncated: false,
      notice: 'No refund or cash action authorized.',
    }) });
  });
  const refundPolicyCalls = [];
  await page.route('**/api/payments/reconciliation/*/refund-evidence*', async route => {
    refundPolicyCalls.push(route.request().method());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      kind: 'read-only-refund-evidence-policy', source: 'local-pos-ledger',
      auditOnly: true, mutationsAllowed: false, checkoutAuthorized: false,
      websiteOrdersIncluded: false, refundAuthorized: false, refundExecuted: false,
      cashPayoutVerified: false, gatewaySettlementVerified: false,
      stockRestored: false, returnInspected: false, fulfilmentAuthorized: false,
      saleId: '00000000-0000-4000-8000-000000000001',
      saleNumber: 'POS-SYNTHETIC', wooOrderId: 123, saleStatus: 'needs_reconciliation',
      paymentMethod: 'cash', originalShiftId: 'synthetic-shift',
      originalTotalCents: 12000, observedWooRefundCents: 2000,
      observedRemainingCents: 10000, recordedRefundKind: 'partial',
      hypotheticalNewRefundCents: null, proposalWithinObservedRemaining: false,
      hypotheticalBalanceAfterCents: null, decision: 'manual_review_only',
      checks: [
        { code: 'external_settlement_and_prior_payout', observed: false,
          requirement: 'Verify original settlement and prior refund independently' },
        { code: 'goods_return_and_inspection', observed: false,
          requirement: 'Physically inspect any garment before restoring stock' },
      ],
      warnings: ['recorded_woo_cash_refund_does_not_prove_physical_payout'],
      notice: 'Woo refund not proof of physical cash payout.',
    }) });
  });
  const resolutionCalls = [];
  await page.route('**/api/payments/reconciliation/*/resolution', async route => {
    resolutionCalls.push(route.request().method());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      kind: 'non-executing-refund-resolution-dossier',
      originalSaleId: '00000000-0000-4000-8000-000000000001',
      originalOrderNumber: 'POS-SYNTHETIC', wooOrderId: 123,
      saleStatus: 'needs_reconciliation', originalUpdatedAt: '2026-11-15T12:00:00.000Z',
      recordedRefundedCents: 2000, originalTotalCents: 12000,
      source: 'local-pos-ledger', websiteOrdersIncluded: false,
      actionsAvailable: false, recordProposalAllowed: false,
      recordOwnerReviewAllowed: false,
      historicalProposal: null, historicalOwnerReview: null, truncatedHistory: false,
      warnings: ['local_payment_evidence_incomplete'],
      requiredChecks: [
        { code: 'external_settlement_and_all_prior_payouts', source: 'independent_bank_or_gateway',
          observed: false, required: 'Independently verify external settlement and prior payouts' },
        { code: 'physically_received_and_inspected_return', source: 'manual_item_inspection',
          observed: false, required: 'Physically inspect returned garment before restoring stock' },
      ],
      conflictingLocalEvidence: ['local_payment_evidence_incomplete'],
      settlementVerified: false, payoutVerified: false, returnPhysicallyInspected: false,
      ownerRefundApprovalIssued: false, cashPayoutAuthorized: false, refundExecuted: false,
      wooStockRestorationAuthorized: false, stockRestored: false,
      goodsReleaseAuthorized: false, checkoutAuthorized: false, mutationsAllowed: false,
      decision: 'external_evidence_and_authorization_required',
      notice: 'Drafts cannot authorize money or inventory.',
    }) });
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  await page.getByRole('region', { name: 'Live catalogue read-only notice' }).getByText('Live catalogue · no checkout').waitFor();
  await page.getByText(/Live WooCommerce catalogue\. Cart amounts/).waitFor();
  if (!(await page.locator('.charge-button').isDisabled())) throw new Error('Pilot must not allow retail order preparation.');
  await page.locator('[data-nav="wholesale"]').click();
  await page.getByRole('heading', { name: 'Wholesale', exact: true }).waitFor();
  await page.getByText(/no quote can be approved, no order can be created/).waitFor();
  await page.locator('[data-nav="stockSafety"]').click();
  await page.getByRole('heading', { name: 'Stock safety review' }).waitFor();
  await page.getByText('Checkout remains locked.').waitFor();
  await page.getByText('Backorders are allowed and need a separate stock policy.').first().waitFor();
  await page.getByText(/Product #73 \/ Variation #74/).waitFor();
  if (auditCalls.join(',') !== 'GET') throw new Error('Stock safety screen must read only once and never write.');
  await page.getByRole('button',{name:'Compare product codes'}).click();
  await page.getByRole('heading',{name:'Investigate all product-code discrepancies'}).waitFor();
  await page.getByRole('button',{name:'Review findings'}).click();
  const skuSection=page.getByRole('region',{name:'Full SKU reconciliation review'});
  const skuTable=skuSection.getByRole('region',{name:'Paginated SKU reconciliation findings'}).locator('table');
  await skuTable.locator('tbody tr').first().waitFor();
  if(await skuTable.locator('tbody tr').count()!==25)throw Error('SKU review page one must contain 25 records');
  await skuSection.getByRole('button',{name:/Next/}).click();
  await skuSection.getByText(/Page 2 of 2/).waitFor();
  if(await skuTable.locator('tbody tr').count()!==2)throw Error('SKU review page two must contain two remaining records');
  if(skuReviewCalls.some(call=>call.method!=='GET')||skuReviewCalls.length!==3 ||
     skuReviewCalls[2].expectedRef!=='f'.repeat(64)) {
    throw Error('SKU review must use GET-only, snapshot-bound pagination.');
  }
  const mappingArea=page.getByRole('region',{name:'Physical product mapping workbench'});
  await mappingArea.getByRole('button',{name:'Open mapping review'}).click();
  const mappingTable=mappingArea.getByRole('region',{name:'Historical product mapping candidates'}).locator('table');
  await mappingTable.locator('tbody tr').first().waitFor();
  if(await mappingTable.locator('tbody tr').count()!==25){
    throw Error('Mapping workbench should page all historical rows.');
  }
  await mappingArea.getByRole('button',{name:/Next/}).click();
  await mappingArea.getByText(/Page 2 of 2/).waitFor();
  if(await mappingTable.locator('tbody tr').count()!==2){
    throw Error('Mapping workbench page two should contain two rows.');
  }
  await mappingArea.getByRole('combobox',{name:'Filter physical mapping status'})
    .selectOption('provisional_match');
  await mappingArea.getByRole('button',{name:'Open mapping review'}).click();
  await mappingArea.getByText(/2 records for the selected filter/).waitFor();
  if(await mappingTable.locator('tbody tr').count()!==2){
    throw Error('Mapping status filter should show only provisional candidates.');
  }
  if(mappingCalls.some(call=>call.method!=='GET')||mappingCalls.length!==3 ||
     mappingCalls[1].expectedRef!=='e'.repeat(64) ||
     mappingCalls[2].status!=='provisional_match'){
    throw Error('Mapping workbench must use GET-only, safe snapshot-bound pagination and filters.');
  }
  const ownerMapping=page.getByRole('region',{name:'Owner product mapping evidence'});
  await ownerMapping.getByRole('button',{name:'Open owner mapping review'}).click();
  const ownerMappingTable=ownerMapping.getByRole('region',{name:'Owner product identity proposals'}).locator('table');
  await ownerMappingTable.locator('tbody tr').first().waitFor();
  if(await ownerMappingTable.locator('tbody tr').count()!==2)
    throw Error('Owner mapping workbench should display both synthetic identities.');
  await ownerMapping.getByRole('button',{name:'Review identity'}).first().click();
  await ownerMapping.getByRole('heading',{name:/Record owner mapping evidence/}).waitFor();
  await ownerMapping.getByRole('combobox',{name:'Choose mapping review action'}).selectOption('propose_option');
  await ownerMapping.getByRole('spinbutton',{name:'Published WooCommerce product ID'}).fill('101');
  await ownerMapping.getByRole('textbox',{name:'Owner mapping investigation note'})
    .fill('Check actual blue dress and size before agreeing on this SKU.');
  await ownerMapping.getByRole('button',{name:'Save proposal / investigation only'}).click();
  await ownerMapping.getByText(/Owner mapping evidence saved locally/).waitFor();
  await ownerMapping.getByText(/Check actual blue dress and size before agreeing/).waitFor();
  if(ownerMappingCalls.filter(x=>x.method==='POST').length!==1||
     ownerMappingCalls.find(x=>x.method==='POST').body.expectedRef!=='b'.repeat(64)||
     ownerMappingCalls.find(x=>x.method==='POST').body.proposedProductId!==101||
     ownerMappingCalls.find(x=>x.method==='POST').body.decision!=='propose_option'||
     ownerMappingCalls.find(x=>x.method==='POST').body.expectedLatestReviewId!==null){
    throw Error('Owner SKU proposal must be source-bound and unapproved.');
  }
  if(await ownerMapping.getByRole('button',{name:/approve stock|import stock|start checkout/i}).count())
    throw Error('Mapping review must not allow inventory imports or checkout.');

  const dossierArea=page.getByRole('region',{name:'Prelaunch inventory evidence dossier'});
  await dossierArea.getByRole('button',{name:'Build investigation dossier'}).click();
  const dossierTable=dossierArea.getByRole('region',{name:'Prelaunch inventory investigation rows'}).locator('table');
  await dossierTable.locator('tbody tr').first().waitFor();
  if(await dossierTable.locator('tbody tr').count()!==25)
    throw Error('Inventory dossier should show 25 source-bound issue rows on first page.');
  const [dossierFile]=await Promise.all([
    page.waitForEvent('download'),
    dossierArea.getByRole('button',{name:'Download private investigation CSV (this page)'}).click(),
  ]);
  if(!dossierFile.suggestedFilename().includes('NOT-APPROVED.csv'))
    throw Error('Inventory dossier CSV must be labeled NOT APPROVED.');
  await dossierArea.getByRole('button',{name:'Next'}).click();
  await dossierArea.getByText(/Page 2 of 2/).waitFor();
  if(await dossierTable.locator('tbody tr').count()!==2)
    throw Error('Inventory dossier should show two source rows on last page.');
  await dossierArea.getByRole('combobox',{name:'Filter inventory dossier'}).selectOption('identity_hold');
  await dossierArea.getByRole('button',{name:'Build investigation dossier'}).click();
  await dossierArea.getByText(/1 product rows for this filter/).waitFor();
  if(await dossierTable.locator('tbody tr').count()!==1)
    throw Error('Owner dossier identity hold filter should return one quarantined row.');
  if(dossierCalls.some(call=>call.method!=='GET')||dossierCalls.length!==3||
     dossierCalls[1].expectedRef!=='c'.repeat(64)||
     dossierCalls[2].focus!=='identity_hold')
    throw Error('Owner dossier must use only GET with snapshot-bound pagination.');
  if(await dossierArea.getByRole('button',{name:/approve stock|release stock|start checkout/i}).count())
    throw Error('Investigation dossier cannot authorize inventory or checkout.');

  const prepArea=page.getByRole('region',{name:'Inventory acceptance preparation checklist'});
  await prepArea.getByRole('button',{name:'Prepare evidence checklist'}).click();
  const prepTable=prepArea.getByRole('region',{name:'Unverified inventory acceptance checklist'}).locator('table');
  await prepTable.locator('tbody tr').first().waitFor();
  if(await prepTable.locator('tbody tr').count()!==25)
    throw Error('Owner acceptance checklist must display 25 source rows.');
  await prepArea.getByRole('button',{name:'Next'}).click();
  await prepArea.getByText(/Page 2 of 2/).waitFor();
  if(await prepTable.locator('tbody tr').count()!==2)
    throw Error('Owner acceptance checklist must page without mixing snapshots.');
  await prepArea.getByRole('combobox',{name:'Filter acceptance evidence gate'})
    .selectOption('historical_source_integrity');
  await prepArea.getByRole('button',{name:'Prepare evidence checklist'}).click();
  await prepArea.getByText(/No source rows match this requirement/).waitFor();
  if(acceptanceCalls.some(x=>x.method!=='GET')||acceptanceCalls.length!==3||
     acceptanceCalls[1].expectedRef!=='f'.repeat(64)||
     acceptanceCalls[2].gate!=='historical_source_integrity')
    throw Error('Acceptance preparation must use GET-only snapshot-bound filters.');
  if(await prepArea.getByRole('button',{name:/approve|authorize|import stock|checkout/i}).count())
    throw Error('Acceptance checklist must not expose a stock approval action.');

  const recountArea=page.getByRole('region',{name:'Physical stock recount preparation'});
  await recountArea.getByRole('button',{name:'Build recount task list'}).click();
  const recountTable=recountArea.getByRole('region',{name:'Physical recount review tasks'}).locator('table');
  await recountTable.locator('tbody tr').first().waitFor();
  if(await recountTable.locator('tbody tr').count()!==25){
    throw Error('Recount plan must display 25 historical tasks per page.');
  }
  const [recountDownload]=await Promise.all([
    page.waitForEvent('download'),
    recountArea.getByRole('button',{name:'Download blank worksheet (this page)'}).click(),
  ]);
  if(!recountDownload.suggestedFilename().includes('NOT-APPROVED.csv')){
    throw Error('Count-sheet download must be labelled NOT APPROVED.');
  }
  await recountArea.getByRole('button',{name:/Next/}).click();
  await recountArea.getByText(/Page 2 of 2/).waitFor();
  if(await recountTable.locator('tbody tr').count()!==2){
    throw Error('Recount planner page two should contain two remaining tasks.');
  }
  await recountArea.getByRole('combobox',{name:'Filter recount priority'}).selectOption('P0');
  await recountArea.getByRole('button',{name:'Build recount task list'}).click();
  await recountArea.getByText(/1 tasks for this filter/).waitFor();
  if(await recountTable.locator('tbody tr').count()!==1){
    throw Error('The P0 physical recount filter should show one quarantined task.');
  }
  if(recountCalls.some(call=>call.method!=='GET')||recountCalls.length!==3||
      recountCalls[1].expectedRef!=='d'.repeat(64)||recountCalls[2].priority!=='P0'){
    throw Error('Recount planner must use GET only, stable snapshots and bounded task filters.');
  }
  if (await page.locator('main').getByRole('button', { name: /checkout|sell|pay|approve refund/i }).count()) {
    throw new Error('Stock audit screen must not present checkout or refund approval actions.');
  }
  await page.locator('[data-nav="physicalCounts"]').click();
  await page.getByRole('heading',{name:'Owner physical count review'}).waitFor();
  const ownerReview=page.getByRole('region',{name:'Physical count claims workspace'});
  const ownerTable=ownerReview.getByRole('region',{name:'Source-bound physical count claims'}).locator('table');
  await ownerTable.locator('tbody tr').first().waitFor();
  if(await ownerTable.locator('tbody tr').count()!==2){
    throw Error('Owner must see both recorded and incomplete synthetic count claims.');
  }
  await ownerReview.getByText(/Count claims disagree/).first().waitFor();
  if(countReviewCalls.join(',')!=='GET'){
    throw Error('Owner count review must make GET-only requests.');
  }
  if(await ownerReview.getByRole('button',{name:/approve|release|import|checkout/i}).count()){
    throw Error('Owner count review must not expose inventory approval or checkout actions.');
  }
  await ownerReview.getByRole('button',{name:'Record follow-up'}).first().click();
  await ownerReview.getByRole('heading',{name:/Record an owner follow-up/}).waitFor();
  await ownerReview.getByRole('combobox',{name:'Required follow-up'}).selectOption('request_recount');
  await ownerReview.getByRole('textbox',{name:/Investigation note/}).fill('Independent second count differs; investigate.');
  await ownerReview.getByRole('button',{name:'Save investigation note only'}).click();
  await ownerReview.getByText(/Owner investigation note recorded/).waitFor();
  await ownerReview.getByText('Independent second count differs; investigate.').waitFor();
  if(ownerTriageCalls.length!==1||ownerTriageCalls[0].method!=='POST'||
     ownerTriageCalls[0].body.expectedRef!=='a'.repeat(64)||
     ownerTriageCalls[0].body.expectedFirstClaimId!==100||
     ownerTriageCalls[0].body.expectedSecondClaimId!==101||
     ownerTriageCalls[0].body.expectedLatestTriageId!==null||
     ownerTriageCalls[0].body.decision!=='request_recount'){
    throw Error('Owner follow-up must be bound to exact count events, not an approval.');
  }
  if(countReviewCalls.some(method=>method!=='GET')){
    throw Error('Owner investigation history remains GET-only.');
  }
  const supervision=page.getByRole('region',{name:'Supervisor count evidence register'});
  await supervision.getByRole('button',{name:'Open supervisor evidence'}).click();
  const supervisionTable=supervision.getByRole('region',{name:'Supervisor physical count evidence rows'}).locator('table');
  await supervisionTable.locator('tbody tr').first().waitFor();
  if(await supervisionTable.locator('tbody tr').count()!==2)
    throw Error('Supervisor evidence must show discrepancies and missing second counts.');
  const record=supervision.getByRole('button',{name:'Record supervisor note'}).first();
  await record.click();
  await supervision.getByRole('combobox',{name:'Choose supervisor evidence action'})
    .selectOption('flag_discrepancy');
  await supervision.getByRole('textbox',{name:'Private evidence reference code'})
    .fill('SYNTHETIC_COUNT_001');
  await supervision.getByRole('textbox',{name:'Supervisor count observation note'})
    .fill('Recount is required; staff declarations do not agree.');
  await supervision.getByRole('button',{name:'Save unverified supervisor note'}).click();
  await supervision.getByText(/Supervisor note recorded locally/).waitFor();
  await supervision.getByText('SYNTHETIC_COUNT_001').waitFor();
  const submit=supervisionCalls.filter(x=>x.method==='POST');
  if(submit.length!==1||submit[0].body.action!=='flag_discrepancy'||
    submit[0].body.expectedRef!=='9'.repeat(64)||
    submit[0].body.firstClaimId!==100||submit[0].body.secondClaimId!==101||
    submit[0].body.expectedLatestNoteId!==null)
    throw Error('Supervisor observation must link both exact staff claim IDs.');
  if(supervisionCalls.some(x=>!['GET','POST'].includes(x.method)))
    throw Error('Supervision screen made an unexpected request method.');
  if(await supervision.getByRole('button',{name:/approve|certify|import stock|checkout/i}).count())
    throw Error('Supervisor evidence must not expose stock approval controls.');

  const fileRegister=page.getByRole('region',{name:'Private count document integrity register'});
  await fileRegister.getByRole('button',{name:'Open private file register'}).click();
  const manifestTable=fileRegister.getByRole('region',{name:'Count file fingerprint records'}).locator('table');
  await manifestTable.locator('tbody tr').first().waitFor();
  if(await manifestTable.locator('tbody tr').count()!==2)
    throw Error('Private file register must show discrepant and missing-count source rows.');
  await fileRegister.getByRole('button',{name:'Record fingerprint'}).first().click();
  const pdfBuffer=Buffer.from('%PDF-1.4\\nSynthetic private evidence for test');
  await fileRegister.getByRole('textbox',{name:'Count evidence private code'})
    .fill('PRIVATE_COUNT_0001');
  await fileRegister.getByLabel('Choose private evidence file')
    .setInputFiles({name:'synthetic-count.pdf',mimeType:'application/pdf',buffer:pdfBuffer});
  await fileRegister.getByText(/Local SHA-256:/).waitFor();
  await fileRegister.getByRole('button',{name:'Save file fingerprint only'}).click();
  await fileRegister.getByText(/File fingerprint recorded locally/).waitFor();
  await fileRegister.getByText('PRIVATE_COUNT_0001').waitFor();
  const savedManifest=manifestCalls.filter(x=>x.method==='POST');
  if(savedManifest.length!==1||
     savedManifest[0].body.expectedRef!=='d'.repeat(64)||
     savedManifest[0].body.firstClaimId!==100||
     savedManifest[0].body.secondClaimId!==101||
     savedManifest[0].body.documentType!=='count_sheet'||
     !/^[0-9a-f]{64}$/.test(savedManifest[0].body.fileSha256)||
     savedManifest[0].body.fileBytes!==pdfBuffer.length||
     savedManifest[0].body.rawFile||savedManifest[0].body.fileName||
     JSON.stringify(savedManifest[0].body).includes('Synthetic private evidence')){
    throw Error('File contents or unverified approval fields were sent to the backend.');
  }
  await fileRegister.getByRole('button',{name:'Compare local file'}).click();
  await fileRegister.getByLabel('Choose private evidence file')
    .setInputFiles({name:'some-other-name.pdf',mimeType:'application/pdf',buffer:pdfBuffer});
  await fileRegister.getByText(/BYTES MATCH/).waitFor();
  await fileRegister.getByRole('button',{name:'Close'}).click();
  if(await fileRegister.getByRole('button',{name:/approve stock|import stock|start checkout/i}).count())
    throw Error('Private file hashing must not expose inventory approval.');
  const custody=page.getByRole('region',{
    name:'Owner custody and independent review preparation',
  });
  await custody.getByRole('button',{name:'Open custody register'}).click();
  const custodyTable=custody.getByRole('region',{name:'Private evidence custody records'}).locator('table');
  await custodyTable.locator('tbody tr').first().waitFor();
  if(await custodyTable.locator('tbody tr').count()!==2)
    throw Error('Custody register should show both synthetic source rows.');
  await custody.getByRole('button',{name:'Record custody step'}).first().click();
  await custody.getByRole('textbox',{name:'Secure storage reference code'})
    .fill('SEALED_BOX_01');
  await custody.getByRole('textbox',{name:'Owner custody preparation note'})
    .fill('Original reportedly placed in a private sealed cabinet.');
  await custody.getByRole('button',{name:'Save unverified custody entry'}).click();
  await custody.getByText(/Owner custody declaration recorded/).waitFor();
  if(custodyCalls.filter(x=>x.method==='POST').length!==1||
    custodyCalls.find(x=>x.method==='POST').body.action!=='sealed_in_private_custody'||
    custodyCalls.find(x=>x.method==='POST').body.manifestId!==809||
    custodyCalls.find(x=>x.method==='POST').body.firstClaimId!==100||
    custodyCalls.find(x=>x.method==='POST').body.secondClaimId!==101)
    throw Error('Custody entry must be pinned to original file manifest and both counts.');
  await custody.getByRole('button',{name:'Record custody step'}).first().click();
  await custody.getByRole('combobox',{name:'Custody handling action'})
    .selectOption('independent_review_requested');
  await custody.getByRole('textbox',{name:'Owner custody preparation note'})
    .fill('Independent document inspection requested; not delivered or verified.');
  await custody.getByRole('button',{name:'Save unverified custody entry'}).click();
  await custody.getByText(/Owner custody declaration recorded/).waitFor();
  if(custodyCalls.filter(x=>x.method==='POST').length!==2||
    custodyCalls.filter(x=>x.method==='POST')[1].body.action!=='independent_review_requested'||
    custodyCalls.filter(x=>x.method==='POST')[1].body.reviewChannel!=='in_person'||
    custodyCalls.filter(x=>x.method==='POST')[1].body.expectedLatestEventId!==900)
    throw Error('Review request must link the prior owner custody event.');
  if(await custody.getByRole('button',{name:/approve stock|certify witness|release stock|checkout/i}).count())
    throw Error('Custody register must never offer stock approval or acceptance.');

  await page.locator('[data-nav="paymentReconciliation"]').click();
  await page.getByRole('heading', { name: 'Payment reconciliation' }).waitFor();
  await page.getByText(/This screen does not read the WooCommerce website order ledger/).waitFor();
  await page.getByText('Cash custody; payment unconfirmed').waitFor();
  await page.getByText('External settlement: not verified').waitFor();
  if (paymentReviewCalls.join(',') !== 'GET') {
    throw new Error('Reconciliation dashboard must only GET local POS evidence.');
  }
  if (await page.locator('main').getByRole('button', { name: /approve|pay|refund|fulfil|settle/i }).count()) {
    throw new Error('Read-only payment dashboard must not expose payment or refund controls.');
  }
  await page.getByRole('button', { name: 'Review evidence' }).click();
  await page.getByRole('heading', { name: 'Documented investigation requests' }).waitFor();
  await page.getByText('No investigation instructions have been recorded for this original sale.').waitFor();
  await page.getByRole('button', { name: 'Inspect refund evidence (read-only)' }).click();
  await page.getByRole('region', { name: 'Refund policy worksheet results' }).waitFor();
  await page.getByText('Verify original settlement and prior refund independently').waitFor();
  if (refundPolicyCalls.join(',') !== 'GET') {
    throw new Error('Refund evidence worksheet must use local GET only.');
  }
  await page.getByRole('button', { name: 'Inspect resolution dossier (read-only)' }).click();
  await page.getByRole('region', { name: 'Refund resolution dossier' }).waitFor();
  await page.getByText('Independently verify external settlement and prior payouts').waitFor();
  if (resolutionCalls.join(',') !== 'GET') {
    throw new Error('Live resolution dossier must only read local POS evidence.');
  }
  if (await page.locator('main').getByRole('button', {
    name: /record non-executing proposal|mark owner review|execute refund|restore stock/i,
  }).count()) {
    throw new Error('Live pilot must not offer resolution proposal or financial execution controls.');
  }
  if (financialHistoryCalls.join(',') !== 'GET') {
    throw new Error('Financial review history screen must use read-only GET only.');
  }
  if (await page.locator('main').getByRole('button', {
    name: /record investigation|acknowledge review|approve refund|execute refund/i,
  }).count()) {
    throw new Error('Live pilot financial triage must not expose review-write or refund controls.');
  }
  await page.locator('[data-nav="shifts"]').click();
  await page.getByRole('heading', { name: 'Shifts & drawer' }).waitFor();
  await page.getByText(/No shifts or cash movements can be recorded here/).waitFor();
  if (await page.getByRole('button', { name: 'Open shift' }).count()) throw new Error('Pilot must not offer cash tracking.');
  await page.locator('[data-nav="connection"]').click();
  await page.getByRole('heading', { name: 'Store connection' }).waitFor();
  await page.getByText('Live catalogue · no checkout').last().waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Read-only banner or connection page overflows a phone.');
  await page.getByRole('region', { name: 'Live catalogue read-only notice' }).getByText('Live catalogue · no checkout').waitFor();
  if (!(await page.getByRole('region', { name: 'Live catalogue read-only notice' }).getByText(/Do not release goods using this POS/).isVisible())) {
    throw new Error('Phone layout conceals the read-only trading warning.');
  }
  if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join('; ')}`);
  console.log('PASS: live catalogue pilot labels, locked checkout/Wholesale/cash and phone layout (isolated demo fixture).');
} catch (error) {
  await recordFailure(page, error, 'live-pilot-browser-failure', pageErrors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
