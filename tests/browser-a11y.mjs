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
  await page.locator('[data-nav="wholesale"]').click();
  await page.getByRole('heading', { name: 'Wholesale', exact: true }).waitFor();
  await scan('wholesale-goods-first');
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
  for (const id of ['shifts','staff','audit','connection']) {
    await page.locator(`[data-nav="${id}"]`).click();
    await page.locator('main h1:visible').waitFor();
    await scan(id);
  }
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
  await page.setViewportSize({ width: 375, height: 812 });
  for (const id of ['sales','wholesale','inventory','reports','shifts','staff','audit','connection','register']) {
    await page.getByLabel('Open navigation').click();
    await page.locator(`[data-nav="${id}"]`).click();
    await page.locator('main h1:visible').waitFor();
    if (id === 'inventory') {
      const shown = await page.locator('.inventory-table tbody tr').first().evaluate(row => ({ layout: getComputedStyle(row).display, labels: [...row.querySelectorAll('td')].map(cell => cell.dataset.label) }));
      if (shown.layout !== 'grid' || !shown.labels.includes('Available') || !shown.labels.includes('Stock status') || !shown.labels.includes('SKU / barcode')) throw new Error('Phone stock records hide essential fields.');
    }
    if (id === 'staff' && !(await page.locator('.records-staff td[data-label="Access"]').first().isVisible())) throw new Error('Phone staff records hide access actions.');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${id} overflows a 375px phone.`);
    await scan(`${id}-phone`);
  }
  await page.getByLabel('Open navigation').click();
  await page.keyboard.press('Escape');
  if (await page.locator('.sidebar').evaluate(el => getComputedStyle(el).visibility) !== 'hidden' || await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) !== 'Open navigation') throw new Error('Mobile navigation does not close and return focus on Escape.');
  await page.getByLabel('Open navigation').click();
  await page.locator('.sidebar-profile > button').focus();
  await page.keyboard.press('Tab');
  if (!(await page.locator('.app-brand').evaluate(el => el === document.activeElement))) throw new Error('Navigation focus escaped behind the open drawer.');
  await page.locator('.help-nav').click();
  await page.getByRole('heading', { name: 'Your quick guide' }).waitFor();
  if (await page.locator('.sidebar').evaluate(el => el.classList.contains('open'))) throw new Error('Opening Help left the navigation drawer active behind a dialog.');
  await scan('help-from-drawer');
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.setViewportSize({ width: 320, height: 700 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) violations.push({ page: 'register-320', id: 'horizontal-overflow', impact: 'serious', help: 'Page must not overflow at 320px', nodes: 1, targets: ['html'] });
  await scan('register-mobile');
  await page.getByRole('button', { name: /View sale/ }).click();
  if (await page.getByRole('dialog', { name: 'Current sale' }).count() !== 1 || await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) !== 'Close cart') throw new Error('Mobile cart does not open as a focused dialog.');
  await scan('cart-mobile');
  await page.keyboard.press('Escape');
  if (await page.getByRole('dialog', { name: 'Current sale' }).count() || !(await page.locator('.mobile-cart-bar').evaluate(el => el === document.activeElement))) throw new Error('Mobile cart does not close and return focus on Escape.');
  await page.getByRole('button', { name: 'Scan product' }).click();
  await page.getByRole('heading', { name: 'Scan a product' }).waitFor();
  await scan('scanner-mobile');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Inspect the payment and receipt overlays without placing an order in the demo ledger.
  await page.route('**/api/sales/prepare', route => route.fulfill({ status: 201, json: { sale: { id: 'ui-preview', number: 'DEMO-UI-PREVIEW', items: [{ quantity: 1 }], total: 19900, tax: 0 } } }));
  await page.locator('.product-card:not([disabled])').first().click();
  await page.getByRole('button', { name: /View sale/ }).click();
  await page.getByRole('button', { name: /Prepare order GH/ }).click();
  await page.getByRole('heading', { name: 'Complete payment' }).waitFor();
  await scan('checkout-cash-mobile');
  await page.getByRole('button', { name: 'MoMo', exact: true }).click();
  await scan('checkout-momo-mobile');
  const layers = await page.evaluate(() => {
    let toast = document.querySelector('.toast');
    const temporary = !toast;
    if (temporary) { toast = document.createElement('div'); toast.className = 'toast'; document.body.append(toast); }
    const result = { toast: Number(getComputedStyle(toast).zIndex), backdrop: Number(getComputedStyle(document.querySelector('.modal-backdrop')).zIndex) };
    if (temporary) toast.remove();
    return result;
  });
  if (layers.toast >= layers.backdrop) throw new Error('A cart notification covers payment confirmation.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.unroute('**/api/sales/prepare');
  await page.route('**/api/sales', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.sales.unshift({ id: 'ui-receipt', number: 'DEMO-UI-RECEIPT', items: [{ name: 'UI review garment', quantity: 1, price: 19900, total: 19900 }], subtotal: 19900, tax: 0, total: 19900, cashierName: 'Demo Owner', paymentMethod: 'cash', tendered: 20000, changeDue: 100, paidAt: new Date().toISOString(), status: 'paid' });
    await route.fulfill({ response, json: data });
  });
  await page.getByLabel('Open navigation').click();
  await page.locator('[data-nav="sales"]').click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Receipt', exact: true }).first().click();
  await scan('receipt-mobile');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.unroute('**/api/sales');
  fs.writeFileSync('test-results/a11y.json', JSON.stringify(violations, null, 2));
  if (violations.length) {
    console.error(JSON.stringify(violations, null, 2));
    process.exitCode = 1;
  } else console.log('PASS: axe WCAG A/AA + best-practice scans and 320px overflow check.');
} catch (error) {
  await recordFailure(page, error, 'a11y-failure', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
