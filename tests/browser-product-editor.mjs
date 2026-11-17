import assert from 'node:assert/strict';
import path from 'node:path';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

// Isolated demo only: add a product with a photo, sizes and colours, see it
// in the register, then edit it. No WooCommerce request is possible in demo.
const { browser, page, pageErrors } = await openBrowser();
async function navigate(id) {
  if ((await page.viewportSize()).width <= 1080) await page.getByLabel('Open navigation').click();
  await page.locator(`[data-nav="${id}"]`).click();
  await page.locator('main h1:visible').waitFor();
}
try {
  const health = await (await page.request.get(`${base}/api/health`)).json();
  assert.equal(health.mode, 'demo', 'Product editor browser test must use isolated demo only.');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();
  await navigate('products');
  await page.getByRole('button', { name: 'Add product' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add product' });
  await dialog.getByLabel('Product name').fill('Browser Test Wrap Dress');
  await dialog.locator('input[type=file][multiple]').setInputFiles(path.resolve('tests/fixtures/product-photo.png'));
  await dialog.getByText('Main photo').waitFor();
  await dialog.getByLabel('Add a category').selectOption({ label: 'Dresses' });
  await dialog.getByLabel('Description').fill('Soft crepe.\n\nHand wash.');
  await dialog.getByLabel('Product SKU').fill('BTWD');
  await dialog.getByRole('button', { name: '+ M', exact: true }).click();
  await dialog.getByRole('button', { name: '+ L', exact: true }).click();
  const colour = dialog.getByLabel('Add Colour value');
  await colour.fill('Black'); await colour.press('Enter');
  await colour.fill('Emerald'); await colour.press('Enter');
  await dialog.locator('.pe-table tbody tr').nth(3).waitFor();
  assert.equal(await dialog.locator('.pe-table tbody tr').count(), 4);
  await dialog.getByLabel('Price for all').fill('450');
  await dialog.getByLabel('Stock for each new').fill('3');
  await dialog.getByRole('button', { name: 'Apply to all' }).click();
  await dialog.getByRole('button', { name: 'Fill SKUs' }).click();
  assert.equal(await dialog.getByLabel('SKU for L / Emerald').inputValue(), 'BTWD-L-EMER');
  await dialog.getByLabel('Sale price for L / Black').fill('399');
  await dialog.getByLabel('Sell M / Emerald').uncheck();
  await dialog.getByRole('heading', { name: 'Sizes and colours' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/product-editor-new.png' });
  await dialog.getByRole('button', { name: 'Add to demo' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByText('Browser Test Wrap Dress added to the demo catalogue.').waitFor();

  await navigate('register');
  const search = page.locator('.register-main input[placeholder="Name or SKU"]').first();
  await search.fill('Browser Test Wrap');
  const card = page.locator('.product-card').filter({ hasText: 'Browser Test Wrap Dress' });
  await card.waitFor();
  await card.click();
  const variant = page.locator('.variant-modal');
  await variant.getByRole('button', { name: /L \/ Black/ }).waitFor();
  assert.equal(await variant.getByRole('button', { name: /M \/ Emerald/ }).count(), 0, 'unticked combination is not offered for sale');
  await variant.getByRole('button', { name: 'Cancel' }).click();

  await navigate('products');
  await page.getByLabel('Search products', { exact: true }).fill('Browser Test Wrap');
  await page.getByRole('button', { name: 'Edit Browser Test Wrap Dress' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit product' });
  await edit.getByLabel('Price for M / Black', { exact: true }).waitFor();
  assert.equal(await edit.getByLabel('Description').inputValue(), 'Soft crepe.\n\nHand wash.');
  await edit.getByLabel('Product name').fill('Browser Test Wrap Dress II');
  await edit.getByLabel('Price for M / Black', { exact: true }).fill('470');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await edit.waitFor({ state: 'detached' });
  await page.getByText('Browser Test Wrap Dress II updated').waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Add product' }).click();
  const phone = page.getByRole('dialog', { name: 'Add product' });
  await phone.getByLabel('Product name').waitFor();
  await page.waitForTimeout(400);
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(sizes.document <= sizes.viewport, `phone layout overflows: ${JSON.stringify(sizes)}`);
  await page.screenshot({ path: 'test-results/product-editor-phone.png' });
  assert.deepEqual(pageErrors, []);
  console.log('Product editor browser test passed.');
} catch (error) {
  await recordFailure(page, error, 'product-editor', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
