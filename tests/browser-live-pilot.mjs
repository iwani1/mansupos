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
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  await page.getByRole('region', { name: 'Live catalogue read-only notice' }).getByText('Live catalogue · no checkout').waitFor();
  await page.getByText(/Live WooCommerce catalogue\. Cart amounts/).waitFor();
  if (!(await page.locator('.charge-button').isDisabled())) throw new Error('Pilot must not allow retail order preparation.');
  await page.locator('[data-nav="wholesale"]').click();
  await page.getByRole('heading', { name: 'Wholesale', exact: true }).waitFor();
  await page.getByText(/no quote can be approved, no order can be created/).waitFor();
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
