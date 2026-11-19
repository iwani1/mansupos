import assert from 'node:assert/strict';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

// Isolated demo only: exercises Stock control receive / count / history
// against local sample stock. No WooCommerce request is possible in demo.
const { browser, page, pageErrors } = await openBrowser();
async function navigate(id) {
  if ((await page.viewportSize()).width <= 1080) await page.getByLabel('Open navigation').click();
  await page.locator(`[data-nav="${id}"]`).click();
  await page.locator('main h1:visible').waitFor();
}
try {
  const health = await (await page.request.get(`${base}/api/health`)).json();
  assert.equal(health.mode, 'demo', 'Stock control browser test must use isolated demo only.');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();
  await navigate('stockControl');
  assert.equal(await page.locator('main h1:visible').innerText(), 'Stock control');
  const firstRow = page.locator('.stock-table tbody tr.stock-line').first();
  await firstRow.waitFor();
  const name = await firstRow.locator('.table-primary').innerText();

  await firstRow.getByRole('button', { name: 'Receive' }).click();
  const dialog = page.getByRole('dialog', { name: 'Receive stock' });
  await dialog.getByLabel('Units to add').fill('4');
  await dialog.getByLabel(/Note/).fill('Delivery note 17');
  await dialog.getByRole('button', { name: 'Add 4' }).click();
  await dialog.waitFor({ state: 'detached' });
  // The confirmation states the quantity the server wrote; the table must then show it.
  const toast = await page.locator('.toast').filter({ hasText: `${name}: stock` }).innerText();
  const [, was, now] = toast.match(/stock (\d+) → (\d+)/);
  assert.equal(Number(now), Number(was) + 4, toast);
  const showsNew = () => page.waitForFunction(([n, expected]) => [...document.querySelectorAll('.stock-table tbody tr.stock-line')].some(row =>
    row.querySelector('.table-primary')?.textContent === n && row.querySelector('.stock-qty')?.textContent === String(expected)), [name, Number(now)], { timeout: 10000 });
  try { await showsNew(); }
  catch { await page.getByRole('button', { name: 'Refresh', exact: true }).first().click(); await showsNew(); }
  const before4 = Number(was);
  await page.screenshot({ path: 'test-results/stock-control-levels.png' });

  await page.getByRole('tab', { name: 'Stock count' }).click();
  const countInput = page.getByLabel(new RegExp(`Counted quantity for ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).first();
  await countInput.fill(String(before4 + 1));
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: /Save count \(1\)/ }).click();
  await page.getByText('Stock count saved for 1 line.').waitFor();

  await page.getByRole('tab', { name: 'Movement history' }).click();
  await page.locator('.movement-table').getByText('Delivery note 17').first().waitFor();
  await page.locator('.movement-table').getByText('Stock count').first().waitFor();
  await page.screenshot({ path: 'test-results/stock-control-history.png' });

  // Duplicate SKU filter and Edit product shortcut (demo samples have unique SKUs).
  await page.getByRole('tab', { name: 'Stock levels' }).click();
  await page.getByLabel('Filter by stock status').selectOption('dupsku');
  await page.getByText('No matching stock').waitFor();
  await page.getByLabel('Filter by stock status').selectOption('all');
  await page.getByRole('button', { name: /^Edit product / }).first().click();
  await page.getByRole('dialog', { name: 'Edit product' }).getByText('Demo sample products are fixed').waitFor();
  await page.getByRole('dialog', { name: 'Edit product' }).getByRole('button', { name: 'Close dialog' }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Stock levels' }).click();
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(sizes.document <= sizes.viewport, `phone layout overflows: ${JSON.stringify(sizes)}`);
  await page.screenshot({ path: 'test-results/stock-control-phone.png' });
  assert.deepEqual(pageErrors, []);
  console.log('Stock control browser test passed.');
} catch (error) {
  await recordFailure(page, error, 'stock-control', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
