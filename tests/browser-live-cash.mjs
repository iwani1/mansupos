import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

// Browser fixture runs against the isolated demo server. Rewrite only its
// browser responses: no live Woo URL or real POS order/payment is contacted.
const { browser, page, pageErrors } = await openBrowser();
let payRequests = 0;
let taxableFixture = false;
try {
  await page.route('**/api/auth/demo', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.config = {
      ...data.config, mode: 'live', liveReadOnly: false, configured: true,
      writesEnabled: true, wholesaleWritesEnabled: false, requireShift: false,
      paymentMethods: ['cash'], storeUrl: 'https://mansutrendzgh.com',
    };
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/catalog*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.products = data.products.map(p => ({ ...p, stockSource: 'product',
      variations: p.variations.map(v => ({ ...v, stockSource: 'variation' })) }));
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/sales/prepare', route => route.fulfill({ status: 201, json: {
    sale: { id: 'isolated-ui-fixture', number: 'FIXTURE-ONLY', status: 'awaiting_payment',
      saleType: 'retail', items: [{ productId: 7331, variationId: 0, name: 'Fixture item',
        quantity: 1, price: 19900, total: 19900 }], subtotal: taxableFixture ? 19400 : 19900,
      total: 19900, tax: taxableFixture ? 500 : 0 },
  } }));
  await page.route('**/api/sales/*/pay', route => { payRequests++; return route.abort(); });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  await page.locator('.product-card:not([disabled])').first().click();
  await page.getByRole('button', { name: /Prepare order GH/ }).click();
  const modal = page.getByRole('dialog', { name: 'Complete payment' });
  await modal.waitFor();
  if (await modal.getByRole('button', { name: 'Cash', exact: true }).count() !== 1 ||
      await modal.getByRole('button', { name: 'MoMo', exact: true }).count() ||
      await modal.getByRole('button', { name: 'Card', exact: true }).count()) {
    throw new Error('Live payment UI must offer cash only.');
  }
  await modal.getByText(/Live POS sales are cash-only/).waitFor();
  if (await modal.locator('.amount-due small').count()) throw new Error('Zero-tax order displayed a tax claim.');
  await modal.getByRole('button', { name: 'Leave unpaid' }).click();
  taxableFixture = true;
  await page.locator('.product-card:not([disabled])').first().click();
  await page.getByRole('button', { name: /Prepare order GH/ }).click();
  await modal.getByText('Includes GH₵5.00 tax · authoritative store total').waitFor();
  if (payRequests || pageErrors.length) throw new Error(`Unexpected payment request or browser errors: ${pageErrors.join('; ')}`);
  console.log('PASS: isolated live-mode UI offers cash only and displays tax only when returned; no payment request sent.');
} catch (error) {
  await recordFailure(page, error, 'live-cash-browser-failure', pageErrors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
