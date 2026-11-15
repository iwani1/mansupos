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
