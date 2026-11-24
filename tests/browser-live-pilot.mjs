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
