import assert from 'node:assert/strict';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

// iPhone held upright (390x844, touch). Isolated demo only.
const { browser, page, pageErrors } = await openBrowser({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const noOverflow = async name => {
  const s = await page.evaluate(() => ({ v: innerWidth, d: document.documentElement.scrollWidth }));
  assert.ok(s.d <= s.v, `${name} overflows sideways: ${JSON.stringify(s)}`);
};
try {
  const health = await (await page.request.get(`${base}/api/health`)).json();
  assert.equal(health.mode, 'demo', 'Mobile browser test must use isolated demo only.');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();

  // 4. Bottom bar with the main pages, above the register's sale bar.
  const bar = page.getByRole('navigation', { name: 'Main pages' });
  for (const name of ['Sell', 'Sales', 'Stock', 'Returns', 'More pages']) await bar.getByRole('button', { name }).waitFor();
  const barBox = await bar.boundingBox();
  const cartBox = await page.locator('.mobile-cart-bar').boundingBox();
  assert.ok(cartBox.y + cartBox.height <= barBox.y, 'sale bar sits above the tab bar');
  const grid = await page.locator('.product-grid').boundingBox();
  assert.ok(grid.width > 300, `register products visible on a phone (width ${grid.width})`);

  await bar.getByRole('button', { name: 'Stock' }).click();
  await page.getByRole('heading', { name: 'Stock control' }).waitFor();
  await page.locator('.stock-mobile-row').first().waitFor();
  // 3. The explanatory diagram is hidden and stats are compact.
  assert.equal(await page.locator('.stock-sync-strip').isVisible(), false);
  // 2. Every section tab is fully on screen (no cut-off labels).
  for (const tab of await page.getByRole('tab').all()) {
    const b = await tab.boundingBox();
    assert.ok(b.x >= 0 && b.x + b.width <= 390, `tab cut off: ${await tab.innerText()}`);
  }
  // 1. One short row per item; a tap opens the actions.
  const row = await page.locator('.stock-mobile-row').first().boundingBox();
  assert.ok(row.height < 90, `compact stock row (${row.height}px)`);
  assert.equal(await page.locator('.stock-table').count(), 0, 'no wide table on phones');
  await page.locator('.stock-mobile-row').first().click();
  const sheet = page.locator('.action-sheet');
  await sheet.getByRole('button', { name: 'Receive stock' }).click();
  await page.getByRole('dialog', { name: 'Receive stock' }).waitFor();
  await page.getByRole('dialog', { name: 'Receive stock' }).getByRole('button', { name: 'Cancel' }).click();
  await noOverflow('stock control');
  await page.screenshot({ path: 'test-results/mobile-stock.png' });

  await bar.getByRole('button', { name: 'More pages' }).click();
  await page.locator('[data-nav="purchasing"]').click();
  await page.getByRole('heading', { name: 'Purchasing' }).waitFor();
  await noOverflow('purchasing');
  await bar.getByRole('button', { name: 'Returns' }).click();
  await page.getByRole('heading', { name: 'Customer returns' }).waitFor();
  await noOverflow('returns');
  await bar.getByRole('button', { name: 'Sales' }).click();
  await page.getByRole('heading', { name: 'Sales history' }).waitFor();
  assert.equal(await bar.getByRole('button', { name: 'Sales' }).getAttribute('aria-current'), 'page');
  assert.deepEqual(pageErrors, []);
  console.log('Mobile browser test passed.');
} catch (error) {
  await recordFailure(page, error, 'mobile', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
