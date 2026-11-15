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
  if (await page.locator('main').getByRole('button', { name: /checkout|sell|pay|approve refund/i }).count()) {
    throw new Error('Stock audit screen must not present checkout or refund approval actions.');
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
