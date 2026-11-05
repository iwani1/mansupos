import fs from 'node:fs';
import { createRequire } from 'node:module';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';
const require = createRequire(import.meta.url);
const { browser, page, pageErrors } = await openBrowser();
await page.emulateMedia({ reducedMotion: 'reduce' });
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const violations = [];
async function scan(name) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }));
  for (const v of result.violations) violations.push({ page: name, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 8).map(n => n.target) });
}
try {
  // Exercise the warning presentation without changing stock or creating a sale.
  await page.route('**/api/catalog*', async route => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const data = await response.json();
    const simple = data.products.find(p => p.type === 'simple');
    if (!simple) throw new Error('A simple demo product is required for the backorder accessibility check.');
    data.products.push({ ...simple, id: 998001, name: 'Accessibility backorder item', sku: 'A11Y-BACKORDER', barcode: 'A11Y-BACKORDER', stock: 0, stockStatus: 'onbackorder', manageStock: true, purchasable: true, backorders: 'notify', backordersAllowed: true });
    await route.fulfill({ response, json: data });
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  await scan('register');
  await page.locator('.product-card').filter({ hasText: 'Accessibility backorder item' }).click();
  await page.getByText('Backorder · notify customer').waitFor();
  await scan('backorder-cart');
  await page.getByLabel('Remove Accessibility backorder item').click();
  await page.locator('[data-nav="inventory"]').click();
  await page.getByRole('heading', { name: 'Inventory', exact: true }).waitFor();
  await scan('inventory');
  await page.locator('[data-nav="sales"]').click();
  await page.getByRole('heading', { name: 'Sales history' }).waitFor();
  await scan('sales');
  await page.locator('[data-nav="reports"]').click();
  await page.getByRole('heading', { name: 'Sales reports' }).waitFor();
  await scan('reports');
  await page.getByText('View daily totals', { exact: true }).click();
  await scan('report-daily-totals');
  await page.locator('[data-nav="register"]').click();
  const variableName = await page.evaluate(async () => {
    const data = await (await fetch('/api/catalog', { credentials: 'same-origin' })).json();
    const available = line => line.purchasable && line.stockStatus !== 'outofstock' && (!line.manageStock || line.stock == null || line.stock > 0);
    return (data.products || []).find(p => p.type === 'variable' && p.variations.some(available))?.name || null;
  });
  if (variableName) {
    await page.locator('.product-card:not([disabled])').filter({ hasText: variableName }).click();
    await page.getByRole('heading', { name: 'Choose a size' }).waitFor();
    await scan('size-dialog');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  await page.setViewportSize({ width: 320, height: 700 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) violations.push({ page: 'register-320', id: 'horizontal-overflow', impact: 'serious', help: 'Page must not overflow at 320px', nodes: 1, targets: ['html'] });
  await scan('register-mobile');
  await page.getByRole('button', { name: /View sale/ }).click();
  await scan('cart-mobile');
  await page.getByLabel('Close cart').click();
  await page.getByRole('button', { name: 'Scan product' }).click();
  await page.getByRole('heading', { name: 'Scan a product' }).waitFor();
  await scan('scanner-mobile');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  fs.writeFileSync('test-results/a11y.json', JSON.stringify(violations, null, 2));
  if (violations.length) {
    console.error(JSON.stringify(violations, null, 2));
    process.exitCode = 1;
  } else console.log('PASS: axe WCAG A/AA + best-practice scans and 320px overflow check.');
} catch (error) {
  await recordFailure(page, error, 'a11y-failure', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
