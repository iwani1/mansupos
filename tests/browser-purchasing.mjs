import assert from 'node:assert/strict';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

// Isolated demo only: supplier -> purchase order -> approve -> receive a
// partial delivery -> stock and cost update. No WooCommerce request in demo.
const { browser, page, pageErrors } = await openBrowser();
async function navigate(id) {
  if ((await page.viewportSize()).width <= 1080) await page.getByLabel('Open navigation').click();
  await page.locator(`[data-nav="${id}"]`).click();
  await page.locator('main h1:visible').waitFor();
}
try {
  const health = await (await page.request.get(`${base}/api/health`)).json();
  assert.equal(health.mode, 'demo', 'Purchasing browser test must use isolated demo only.');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();
  await navigate('purchasing');
  assert.equal(await page.locator('main h1:visible').innerText(), 'Purchasing');

  await page.getByRole('tab', { name: 'Suppliers' }).click();
  await page.getByRole('button', { name: 'Add supplier' }).click();
  const sup = page.getByRole('dialog', { name: 'Add supplier' });
  await sup.getByLabel('Name').fill('Browser Test Supplier');
  await sup.getByLabel('Phone').fill('024 000 0000');
  await sup.getByRole('button', { name: 'Save supplier' }).click();
  await sup.waitFor({ state: 'detached' });
  await page.locator('.po-table').getByText('Browser Test Supplier').waitFor();

  await page.getByRole('button', { name: 'New purchase order' }).click();
  const form = page.getByRole('dialog', { name: 'New purchase order' });
  await form.getByLabel('Supplier').selectOption({ label: 'Browser Test Supplier' });
  await form.getByLabel('Add an item').fill('PEARL');
  await form.getByRole('listbox', { name: 'Matching items' }).getByRole('option').first().click();
  const qty = form.getByLabel(/^Quantity for PEARL SHIRT/);
  await qty.fill('6');
  await form.getByLabel(/^Unit cost for PEARL SHIRT/).fill('120');
  await form.getByText('GH₵720.00').first().waitFor();
  await form.getByRole('button', { name: 'Save draft' }).click();

  const detail = page.getByRole('dialog', { name: /^PO-\d{5}$/ });
  await detail.getByRole('button', { name: 'Approve' }).click();
  await detail.getByText('Approved', { exact: true }).first().waitFor();
  await detail.getByRole('button', { name: 'Receive delivery' }).click();
  const good = detail.getByLabel(/^Good units for PEARL SHIRT/);
  await good.fill('4');
  await detail.getByLabel(/^Damaged units for PEARL SHIRT/).fill('1');
  await detail.getByLabel(/Supplier invoice/).fill('INV-BROWSER');
  await page.screenshot({ path: 'test-results/purchasing-receive.png' });
  await detail.getByRole('button', { name: 'Post delivery' }).click();
  await detail.getByText('Partly received').first().waitFor();
  await detail.getByText(/GRN-\d{5}/).waitFor();
  await detail.getByText('2 to come').waitFor();
  await detail.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('tab', { name: 'Stock value' }).click();
  await page.getByLabel('Search stock value').fill('PEARL');
  await page.locator('.po-table').getByText('GH₵120.00').first().waitFor();

  await navigate('stockControl');
  await page.getByRole('tab', { name: 'Movement history' }).click();
  await page.locator('.movement-table').getByText(/PO-\d{5} · GRN-\d{5} · inv INV-BROWSER/).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await navigate('purchasing');
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(sizes.document <= sizes.viewport, `phone layout overflows: ${JSON.stringify(sizes)}`);
  assert.deepEqual(pageErrors, []);
  console.log('Purchasing browser test passed.');
} catch (error) {
  await recordFailure(page, error, 'purchasing', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
