import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

// UI fixture ONLY: a local demo server, re-labelled in Chromium as a read-only
// pilot, with demo-only barcodes. No live pilot, Woo write or physical device.
// Native HTTPS allowlist/health verification are tested in online-pilot.test.js.
const { browser, page, pageErrors } = await openBrowser();
let attempts = 0;
try {
  await page.route('**/api/auth/demo', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.config = { ...data.config, mode: 'live', liveReadOnly: true, configured: true,
      writesEnabled: false, wholesaleWritesEnabled: false, requireShift: false,
      paymentMethods: ['cash'], storeUrl: 'https://mansutrendzgh.com' };
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/catalog*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.products = data.products.map(product => ({ ...product, stockSource: 'product',
      variations: product.variations.map(variant => ({ ...variant, stockSource: 'variation' })) }));
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/sales/prepare', route => { attempts++; return route.abort(); });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  await page.getByRole('region', { name: 'Live catalogue read-only notice' }).waitFor();
  await page.keyboard.press('F2');
  await page.getByRole('dialog', { name: 'Scan a product' }).getByLabel('Barcode or SKU').fill('DEMO-1001');
  await page.getByRole('dialog', { name: 'Scan a product' }).getByRole('button', { name: 'Find product' }).click();
  await page.getByRole('region', { name: 'Items in current sale' }).getByText('NEW ADVANCED HANDHELD AC FAN').waitFor();
  if (!(await page.locator('.charge-button').isDisabled())) throw new Error('Read-only pilot allowed checkout of a scanned item.');
  await page.context().setOffline(true);
  await page.getByRole('alert').getByText('Device offline.').waitFor();
  if (!(await page.locator('.charge-button').isDisabled()) || attempts) throw new Error('Offline checkout reached a sale endpoint.');
  await page.context().setOffline(false);
  if (!(await page.locator('.charge-button').isDisabled()) || attempts || pageErrors.length) {
    throw new Error(`Unexpected checkout attempt or page error: ${pageErrors.join('; ')}`);
  }
  console.log('PASS: isolated online pilot UI keyboard-scans a sample item, blocks checkout online/offline and sends no sale request.');
} catch (error) {
  await recordFailure(page, error, 'online-pilot-browser-failure', pageErrors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
