import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';
import { categoryGroups, stockAlerts } from '../src/catalog-insights.js';
import { money } from '../src/api.js';

// Presentation/regression coverage only. This test reads an ISOLATED demo
// ledger; it never prepares an order, edits stock, or calls the live store.
const { browser, page, pageErrors } = await openBrowser({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const mutations = [];
page.on('request', request => {
  if (/\/api\/(sales|wholesale-prices|wholesale-buyers|instore)\b/.test(new URL(request.url()).pathname) && request.method() !== 'GET') {
    mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
  }
});
async function navigate(id) {
  if ((await page.viewportSize()).width <= 1080) await page.getByLabel('Open navigation').click();
  await page.locator(`[data-nav="${id}"]`).click();
  await page.locator('main h1:visible').waitFor();
  assert.equal(await page.locator('main h1:visible').innerText(), ({
    register: 'Point of sale', overview: 'Overview', products: 'Products', categories: 'Categories',
    inventory: 'Inventory', sales: 'Sales history', orders: 'Orders', customers: 'Customers',
  })[id]);
}
async function noOverflow(context) {
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(sizes.document <= sizes.viewport, `${context} overflows: ${JSON.stringify(sizes)}`);
}
try {
  const health = await (await page.request.get(`${base}/api/health`)).json();
  assert.equal(health.mode, 'demo', 'Workspace browser test must use isolated demo only.');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();
  const source = await page.evaluate(async () => {
    const endpoints = ['/api/catalog', '/api/sales', '/api/reports?days=1', '/api/reports?days=7', '/api/wholesale-buyers', '/api/session'];
    const results = await Promise.all(endpoints.map(async url => {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return response.json();
    }));
    return Object.fromEntries(['catalog','sales','today','week','buyers','session'].map((key,index) => [key,results[index]]));
  });
  const { catalog, sales, today, buyers, session } = source;
  assert.ok(catalog.products.length > 0);

  await navigate('overview');
  await page.locator('.overview-metrics').waitFor();
  assert.deepEqual(await page.locator('.overview-metric > strong').allInnerTexts(), [
    money(today.total), String(today.orders), money(today.saleTypes.find(type => type.type === 'retail')?.total || 0),
    money(today.saleTypes.find(type => type.type === 'wholesale')?.total || 0),
  ], 'Overview amounts must be reported POS values, not invented dashboard figures.');
  assert.equal(await page.locator('.overview-operational > button').nth(1).locator('strong').innerText(),
    String(stockAlerts(catalog.products, session.config.lowStockThreshold, false).low.length));
  await page.getByText('Website orders and legacy In-store cash receipts are not included.', { exact: false }).waitFor();

  await navigate('products');
  assert.equal(await page.locator('.catalogue-strip > div').first().locator('strong').innerText(), String(catalog.products.length));
  assert.equal(await page.locator('.catalogue-table tbody tr').count(), Math.min(12, catalog.products.length));
  const variable = catalog.products.find(product => product.type === 'variable' && product.variations.length);
  if (variable) {
    await page.locator('.catalogue-table tbody tr').filter({ hasText: variable.name }).getByRole('button', { name: variable.name }).click();
    const dialog = page.getByRole('dialog', { name: variable.name });
    assert.equal(await dialog.locator('.option-list > div').count(), variable.variations.length);
    await dialog.getByRole('button', { name: 'Done' }).click();
  }
  const product = catalog.products.find(item => item.sku);
  await page.getByLabel('Search products', { exact: true }).last().fill(product.sku);
  assert.equal(await page.locator('.catalogue-table tbody tr').count(), 1);
  await page.getByLabel('Search products', { exact: true }).last().fill('');
  const demoDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export shown' }).click();
  const demoFile = await demoDownload;
  assert.match(demoFile.suggestedFilename(), /mansu-demo-catalogue-/);
  const demoRows = parse(fs.readFileSync(await demoFile.path(), 'utf8').replace(/^\ufeff/, ''), { columns: true });
  assert.ok(demoRows.length > 0 && demoRows.every(row => row.Workspace === 'Demo only'), 'A demo catalogue export must identify practice data.');

  await navigate('categories');
  const categories = categoryGroups(catalog.products);
  assert.equal(await page.locator('.category-tile').count(), categories.length);
  const chosen = categories[0];
  await page.locator('.category-tile').filter({ hasText: chosen.name }).click();
  assert.equal(await page.locator('main h1:visible').innerText(), 'Products');
  assert.equal(await page.getByLabel('Filter product category').inputValue(), chosen.name);
  assert.equal(await page.locator('.catalogue-table tbody tr').count(), Math.min(12, chosen.count));

  await navigate('sales');
  assert.equal(await page.locator('.records-sales tbody tr').count(), sales.sales.length);
  if (sales.sales.length) {
    const first = sales.sales[0];
    await page.getByLabel('Search sales').fill(first.number);
    const row = page.locator('.records-sales tbody tr').filter({ hasText: first.number });
    assert.equal(await row.count(), 1);
    await row.getByRole('button', { name: 'Details' }).click();
    const dialog = page.getByRole('dialog', { name: 'Order details' });
    await dialog.getByText(money(first.total), { exact: true }).last().waitFor();
    assert.equal(await dialog.locator('.order-detail-lines > div').count(), first.items.length);
    await dialog.getByRole('button', { name: 'Close details' }).click();
    await page.getByLabel('Filter sale status').selectOption(first.status === 'paid' ? 'awaiting_payment' : 'paid');
    await page.getByText('No matching sales').waitFor();
    await page.getByRole('button', { name: 'Clear filters' }).click();
  }
  await navigate('orders');
  assert.equal(await page.locator('.records-sales tbody tr').count(), sales.sales.length);
  assert.equal(await page.locator('.order-queue-banner strong').innerText(),
    `${sales.sales.filter(item => ['creating','awaiting_payment','needs_reconciliation'].includes(item.status)).length} unsettled POS orders`);

  await navigate('customers');
  assert.equal(await page.locator('.customers-table tbody tr').count(), buyers.buyers.length);
  if (!buyers.buyers.length) await page.getByText('No named buyers saved').waitFor();
  await page.getByText('WooCommerce customer contact details are not synced.', { exact: false }).waitFor();

  await page.getByRole('button', { name: /Main menu · Collapse navigation/ }).click();
  assert.equal(await page.locator('.app-shell.is-collapsed').count(), 1);
  assert.equal(await page.locator('[data-nav="customers"]').getAttribute('title'), 'Customers');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();
  assert.equal(await page.locator('.app-shell.is-collapsed').count(), 1, 'Sidebar collapse should persist locally.');
  await page.getByRole('button', { name: 'Expand navigation' }).click();
  await page.getByRole('button', { name: 'Catalogue · Collapse section' }).click();
  assert.equal(await page.locator('[data-nav="products"]').isVisible(), false);
  await page.getByRole('button', { name: 'Catalogue · Expand section' }).click();
  assert.equal(await page.locator('[data-nav="products"]').isVisible(), true);

  await navigate('overview');
  await page.locator('.topbar-search').click();
  assert.equal(await page.locator('main h1:visible').innerText(), 'Point of sale');
  assert.equal(await page.locator('.catalog-search-row input').evaluate(input => document.activeElement === input), true);

  await page.setViewportSize({ width: 768, height: 812 });
  await navigate('inventory');
  assert.equal(await page.locator('.table-swipe-hint').isVisible(), true);
  assert.equal(await page.locator('.inventory-table').evaluate(el => el.getBoundingClientRect().width > el.parentElement.clientWidth), true,
    'Tablet inventory columns should scroll rather than shrink long names and SKUs.');
  await noOverflow('tablet inventory');
  await page.setViewportSize({ width: 375, height: 812 });
  await navigate('inventory');
  assert.equal(await page.locator('.inventory-table tbody tr').first().evaluate(el => getComputedStyle(el).display), 'grid');
  assert.equal(await page.locator('.topbar-wordmark').isVisible(), true);
  assert.ok((await page.locator('.topbar-account').boundingBox()).width >= 38);
  await noOverflow('phone inventory');
  await page.setViewportSize({ width: 320, height: 700 });
  await noOverflow('small phone');

  // @sparticuz/chromium runs single-process in CI: use one tab for all fixtures.
  const cashier = page;
  await cashier.setViewportSize({ width: 1280, height: 800 });
  await cashier.route('**/api/session', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.user = null; // Force a fresh demo session before substituting the UI role.
    await route.fulfill({ response, json: data });
  });
  await cashier.route('**/api/auth/demo', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.role = 'cashier'; // UI permission check only; backend authorisation is separately unit-tested.
    await route.fulfill({ response, json: data });
  });
  await cashier.reload({ waitUntil: 'networkidle' });
  await cashier.locator('.product-card').first().waitFor();
  for (const id of ['overview','wholesale','customers','reports','staff']) {
    assert.equal(await cashier.locator(`[data-nav="${id}"]`).count(), 0, `${id} should not appear for cashiers.`);
  }
  assert.equal(await cashier.getByRole('group', { name: 'Selling mode' }).getByRole('button', { name: 'WHOLESALE' }).isDisabled(), true);
  await cashier.locator('[data-nav="inventory"]').click();
  assert.equal(await cashier.locator('td[data-label="Private wholesale"]').count(), 0);

  // A partial Woo snapshot must not produce full-store counts or export stock as verified.
  // Reuse the same isolated tab; no production or staging server is contacted.
  await cashier.unroute('**/api/auth/demo');
  const partial = cashier;
  let catalogueStale = false;
  await partial.route('**/api/auth/demo', async route => {
    const response = await route.fetch();
    const data = await response.json();
    Object.assign(data.config, { mode: 'staging', configured: true, writesEnabled: false, wholesaleWritesEnabled: false, requireShift: false });
    await route.fulfill({ response, json: data });
  });
  await partial.route('**/api/catalog*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.complete = catalogueStale;
    data.unsupported = catalogueStale ? 0 : 2;
    if (catalogueStale) {
      data.stale = true;
      data.error = 'Refresh failed. Showing cached stock.';
    }
    data.products = data.products.map(product => ({ ...product, stockSource: 'product',
      variations: product.variations.map(option => ({ ...option, stockSource: 'variation' })) }));
    await route.fulfill({ response, json: data });
  });
  await partial.reload({ waitUntil: 'networkidle' });
  await partial.locator('.product-card').first().waitFor();
  await partial.getByText('Incomplete catalogue', { exact: true }).waitFor();
  await partial.locator('[data-nav="overview"]').click();
  await partial.locator('.overview-metrics').waitFor();
  assert.equal(await partial.locator('.overview-operational > button').nth(1).locator('strong').innerText(), '—');
  await partial.getByText('The WooCommerce catalogue is incomplete.', { exact: false }).waitFor();
  await partial.locator('[data-nav="inventory"]').click();
  assert.equal(await partial.locator('.stat-card').filter({ hasText: 'Tracked stock' }).locator('strong').innerText(), '—');
  await partial.locator('[data-nav="products"]').click();
  await partial.getByText('Counts below cover only the visible catalogue', { exact: false }).waitFor();
  const downloaded = partial.waitForEvent('download');
  await partial.getByRole('button', { name: 'Export shown' }).click();
  const rows = parse(fs.readFileSync(await (await downloaded).path(), 'utf8').replace(/^\ufeff/, ''), { columns: true });
  assert.ok(rows.length > 0 && rows.every(row => row['Stock units'] === ''), 'An incomplete catalogue export exposed unverified stock.');

  // A complete-but-stale catalogue must not be presented as available stock.
  catalogueStale = true;
  await partial.reload({ waitUntil: 'networkidle' });
  await partial.locator('.product-card').first().waitFor();
  await partial.locator('[data-nav="products"]').click();
  await partial.getByText('This is a cached snapshot.', { exact: false }).waitFor();
  await partial.locator('.catalogue-table tbody tr').first().getByText('Stock not verified').waitFor();
  const staleDownload = partial.waitForEvent('download');
  await partial.getByRole('button', { name: 'Export shown' }).click();
  const staleRows = parse(fs.readFileSync(await (await staleDownload).path(), 'utf8').replace(/^\ufeff/, ''), { columns: true });
  assert.ok(staleRows.length > 0 && staleRows.every(row => row['Stock units'] === ''), 'Stale catalogue exported old quantities as verified.');
  await partial.locator('[data-nav="inventory"]').click();
  assert.equal(await partial.locator('.stat-card').filter({ hasText: 'Tracked stock' }).locator('strong').innerText(), '—');
  assert.equal(await partial.locator('.stat-card').filter({ hasText: 'Low-stock records' }).locator('strong').innerText(), '—');
  assert.equal(await partial.locator('td[data-label="Available"]').first().locator('strong').innerText(), '—');
  await partial.locator('td[data-label="Stock status"]').first().getByText('Stock not verified').waitFor();
  await partial.locator('[data-nav="register"]').click();
  await partial.locator('.product-card').first().getByText('Stock not verified', { exact: false }).waitFor();
  await partial.locator('[data-nav="wholesale"]').click();
  await partial.locator('.wholesale-product').first().getByText('Stock not verified', { exact: false }).waitFor();

  assert.deepEqual(mutations, [], 'A directory/design test must not change sales or prices.');
  assert.deepEqual(pageErrors, []);
  console.log('PASS: data-sourced overview, catalogue/categories, customers, ledger/orders, grouped navigation, touchscreen layouts and cashier privacy; no sale or price writes.');
} catch (error) {
  await recordFailure(page, error, 'workspace-browser-failure', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
