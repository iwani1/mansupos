import assert from 'node:assert/strict';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

// Isolated demo only: return part of a sample sale, keep one item aside,
// then put it back on sale. No WooCommerce request is possible in demo.
const { browser, page, pageErrors } = await openBrowser();
async function navigate(id) {
  if ((await page.viewportSize()).width <= 1080) await page.getByLabel('Open navigation').click();
  await page.locator(`[data-nav="${id}"]`).click();
  await page.locator('main h1:visible').waitFor();
}
try {
  const health = await (await page.request.get(`${base}/api/health`)).json();
  assert.equal(health.mode, 'demo', 'Returns browser test must use isolated demo only.');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();
  await navigate('returns');
  assert.equal(await page.locator('main h1:visible').innerText(), 'Customer returns');
  await page.getByLabel('Search sales to return').fill('DEMO-1004');
  const row = page.locator('.po-table tbody tr').filter({ hasText: 'DEMO-1004' });
  await row.getByRole('button', { name: 'Return items' }).click();
  await page.getByRole('heading', { name: 'Return from DEMO-1004' }).waitFor();
  const qty = page.getByLabel(/^Quantity to return for /).first();
  await qty.selectOption('1');
  await page.getByLabel(/^What happens to /).first().selectOption('quarantine');
  await page.getByLabel('Reason').selectOption('faulty');
  await page.screenshot({ path: 'test-results/returns-new.png' });
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Complete return' }).click();
  await page.getByText(/RTN-\d{5} done: GH₵/).waitFor();

  await page.getByRole('tab', { name: /Awaiting decision \(1\)/ }).click();
  const waiting = page.locator('.po-table tbody tr').first();
  await waiting.getByText('Check first').waitFor();
  page.once('dialog', d => d.accept());
  await waiting.getByRole('button', { name: 'Back on sale' }).click();
  await page.getByRole('tab', { name: /Awaiting decision \(0\)/ }).waitFor();

  await page.getByRole('tab', { name: 'History' }).click();
  await page.locator('.po-table').getByText(/Check first → Back on sale/).waitFor();

  await page.getByRole('tab', { name: 'New return' }).click();
  await page.getByLabel('Search sales to return').fill('DEMO-1004');
  await page.locator('.po-table tbody tr').filter({ hasText: 'DEMO-1004' }).getByRole('button', { name: 'Return items' }).click();
  const canReturn = await page.locator('.pe-table tbody tr').first().locator('td').nth(2).innerText();
  assert.equal(canReturn.trim(), '1', 'one of two already returned');

  await page.setViewportSize({ width: 390, height: 844 });
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(sizes.document <= sizes.viewport, `phone layout overflows: ${JSON.stringify(sizes)}`);
  assert.deepEqual(pageErrors, []);
  console.log('Returns browser test passed.');
} catch (error) {
  await recordFailure(page, error, 'returns', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
