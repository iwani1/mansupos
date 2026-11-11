import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';
const { browser, page, pageErrors } = await openBrowser();
const created = [];
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  const before = await page.evaluate(async () => (await (await fetch('/api/sales', { credentials: 'same-origin' })).json()).sales.map(s => s.id));
  const target = await page.evaluate(async () => {
    const data = await (await fetch('/api/catalog', { credentials: 'same-origin' })).json();
    const available = line => line.purchasable && line.stockStatus !== 'outofstock' && (!line.manageStock || line.stock == null || line.stock > 0);
    for (const product of data.products || []) {
      if (product.type === 'variable' && product.variations.some(available)) return { name: product.name, variable: true };
      if (product.type === 'simple' && available(product)) return { name: product.name, variable: false };
    }
    throw new Error('No in-stock demo product available for recovery test');
  });
  await page.locator('.product-card').filter({ hasText: target.name }).click();
  if (target.variable) {
    await page.locator('.size-options button:not([disabled])').first().click();
    await page.getByRole('dialog').getByRole('button', { name: /Add to sale/ }).click();
  }
  let intercepted = false;
  await page.route('**/api/sales/prepare', async route => {
    if (intercepted) return route.continue();
    intercepted = true;
    const response = await route.fetch();
    if (response.status() === 201) {
      const body = await response.json();
      created.push(body.sale.id);
    }
    await route.abort('failed');
  });
  await page.getByRole('button', { name: /Prepare order GH/ }).click();
  await page.locator('.cart-bottom .notice.error').waitFor();
  await page.unroute('**/api/sales/prepare');
  // Rebuild the same cart after a reload: the persisted checkout key must still be reused.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  await page.locator('.product-card:not([disabled])').filter({ hasText: target.name }).click();
  if (target.variable) {
    await page.locator('.size-options button:not([disabled])').first().click();
    await page.getByRole('dialog').getByRole('button', { name: /Add to sale/ }).click();
  }
  await page.getByRole('button', { name: /Prepare order GH/ }).click();
  await page.getByRole('heading', { name: 'Complete payment' }).waitFor();
  const after = await page.evaluate(async () => (await (await fetch('/api/sales', { credentials: 'same-origin' })).json()).sales.map(s => s.id));
  const newIds = after.filter(id => !before.includes(id));
  if (newIds.length !== 1) throw new Error(`Lost-response retry created ${newIds.length} sales, expected 1`);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(async id => { await fetch(`/api/sales/${id}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }, newIds[0]);
  console.log('PASS: lost prepare response recovered after reload with one sale.');
  await page.route('**/api/catalog*', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Sign in to continue.' }) }));
  await page.getByRole('button', { name: 'Refresh catalogue', exact: true }).click();
  await page.getByRole('heading', { name: 'Open your register.' }).waitFor();
  if (await page.locator('.cart-panel').count()) throw new Error('Expired session left the authenticated register visible.');
  console.log('PASS: expired session clears the authenticated register.');
  await page.unroute('**/api/catalog*');
  await page.getByRole('button', { name: 'Open demo workspace', exact: true }).click();
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  if (!(await page.locator('.cart-panel').count())) throw new Error('Demo re-entry did not restore the register.');
  console.log('PASS: demo workspace re-enters without username/password.');
} catch (error) {
  await recordFailure(page, error, 'recovery-failure', pageErrors);
  process.exitCode = 1;
} finally {
  for (const id of created) {
    try { await page.evaluate(async id => { await fetch(`/api/sales/${id}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }, id); } catch {}
  }
  await browser.close();
}
