import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

const require = createRequire(import.meta.url);
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { browser, page, pageErrors } = await openBrowser({ viewport: { width: 1280, height: 800 } });
await page.emulateMedia({ reducedMotion: 'reduce' });
let createdId;
let buyerName;
async function scan(name) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }));
  assert.deepEqual(result.violations.map(v => ({ page: name, id: v.id, help: v.help, targets: v.nodes.slice(0, 3).map(n => n.target) })), [], `${name}: trade UI has accessibility violations`);
}
async function addGoods(simple, variable) {
  await page.locator('.product-card:not([disabled])').filter({ hasText: simple.name }).first().click();
  await page.getByLabel(`Increase ${simple.name}`).click();
  await page.locator('.product-card:not([disabled])').filter({ hasText: variable.name }).first().click();
  await page.locator('.size-options button:not([disabled])').first().click();
  await page.getByRole('dialog').getByRole('button', { name: /Add to sale/ }).click();
  assert.equal(await page.locator('.cart-item').count(), 2);
}
async function quoteGoods(simple, variable) {
  await page.getByRole('button', { name: 'Paid trade', exact: true }).click();
  await page.getByLabel('Named trade buyer').selectOption({ label: buyerName });
  await page.getByLabel(new RegExp(`Agreed unit price for ${simple.name}`)).fill('92.00');
  await page.getByLabel(new RegExp(`Agreed unit price for ${variable.name}`)).fill('67.35');
  assert.equal((await page.locator('.cart-totals .grand-total strong').innerText()).trim(), 'GH₵251.35');
  const approval = page.getByRole('checkbox', { name: /I approve these tax-inclusive unit prices/ });
  await approval.check();
  assert.equal(await page.locator('.charge-button').isDisabled(), false);
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  const { simple, variable } = await page.evaluate(async () => {
    const catalog = await (await fetch('/api/catalog', { credentials: 'same-origin' })).json();
    const simple = catalog.products.find(p => p.type === 'simple' && p.stock >= 2 && p.purchasable);
    const variable = catalog.products.find(p => p.type === 'variable' && p.variations.some(v => v.stock > 0 && v.purchasable));
    if (!simple || !variable) throw new Error('Isolated demo needs one available simple and variable product.');
    return { simple: { name: simple.name, price: simple.price }, variable: { name: variable.name } };
  });
  buyerName = `Browser Trade Buyer ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'Paid trade', exact: true }).click();
  await page.getByLabel('Named trade buyer').selectOption('new');
  await page.getByLabel('New trade buyer name').fill(buyerName);
  await page.getByRole('button', { name: 'Add buyer' }).click();
  await page.getByLabel('Named trade buyer').locator('option:checked').getAttribute('value');
  assert.equal((await page.getByLabel('Named trade buyer').locator('option:checked').textContent()).trim(), buyerName);
  await addGoods(simple, variable);
  assert.equal(await page.locator('.charge-button').isDisabled(), true, 'Trade cannot be prepared without per-line agreed prices and approval.');
  await page.getByLabel(new RegExp(`Agreed unit price for ${simple.name}`)).fill('92.00');
  assert.equal(await page.locator('.charge-button').isDisabled(), true);
  await page.getByLabel(new RegExp(`Agreed unit price for ${variable.name}`)).fill('67.35');
  assert.equal((await page.locator('.cart-totals .grand-total strong').innerText()).trim(), 'GH₵251.35');
  assert.match(await page.locator('.cart-totals').innerText(), /Catalogue reference/);
  assert.match(await page.locator('.cart-totals').innerText(), /No demo tax · no extra charge/);
  const approval = page.getByRole('checkbox', { name: /I approve these tax-inclusive unit prices/ });
  await approval.check();
  assert.equal(await page.locator('.charge-button').isDisabled(), false);
  await page.getByLabel(new RegExp(`Agreed unit price for ${variable.name}`)).fill('67.34');
  assert.equal(await approval.isChecked(), false, 'Price change must invalidate the owner approval.');
  await page.getByLabel(new RegExp(`Agreed unit price for ${variable.name}`)).fill('67.35');
  await approval.check();
  await scan('trade-cart');

  // Lose the first HTTP response after a server-side create, then rebuild the
  // same buyer, quote, and goods after reload. The old key must recover that sale.
  let dropped = false;
  await page.route('**/api/sales/prepare', async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.saleType, 'trade');
    assert.equal(body.tradeApproved, true);
    assert.deepEqual(body.items.map(i => i.agreedUnitPrice).sort((a,b) => a-b), [6735, 9200]);
    if (dropped) return route.continue();
    dropped = true;
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    createdId = (await response.json()).sale.id;
    await route.abort('failed');
  });
  await page.getByRole('button', { name: /Prepare trade order/ }).click();
  await page.locator('.cart-bottom .notice.error').waitFor();
  await page.unroute('**/api/sales/prepare');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  await addGoods(simple, variable);
  await quoteGoods(simple, variable);
  await page.getByRole('button', { name: /Prepare trade order/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Complete payment' });
  await dialog.waitFor();
  assert.match(await dialog.locator('.trade-payment-quote').innerText(), new RegExp(buyerName));
  assert.match(await dialog.locator('.trade-payment-quote').innerText(), /Approved by Demo Owner/);
  assert.match(await dialog.locator('.trade-payment-quote').innerText(), /Catalogue/);
  assert.equal((await dialog.locator('.amount-due strong').innerText()).trim(), 'GH₵251.35');
  const { sales } = await page.evaluate(async () => (await (await fetch('/api/sales', { credentials: 'same-origin' })).json()));
  const matches = sales.filter(s => s.id === createdId);
  assert.equal(matches.length, 1, 'Retry after reload must not create a second sale.');
  assert.equal(matches[0].buyerName, buyerName);
  assert.equal(matches[0].agreedTotal, 25135);
  assert.equal(matches[0].status, 'awaiting_payment');
  await scan('trade-payment');
  await page.getByLabel('Cash received (GH₵)').fill('251.34');
  await page.getByRole('checkbox', { name: /full trade payment is a demo record/ }).check();
  assert.equal(await page.getByRole('button', { name: 'Complete demo trade sale' }).isDisabled(), true);
  await page.getByLabel('Cash received (GH₵)').fill('251.35');
  await page.getByRole('button', { name: 'Complete demo trade sale' }).click();
  await page.getByRole('heading', { name: 'Demo sale complete' }).waitFor();
  const receipt = page.locator('.receipt-dialog .receipt-paper');
  const printed = await receipt.innerText();
  assert.match(printed, new RegExp(buyerName));
  assert.match(printed, /Tax included · approved by Demo Owner/);
  assert.match(printed, /2 × GH₵92\.00 · tax included/);
  assert.match(printed, /1 × GH₵67\.35 · tax included/);
  assert.match(printed, /Included tax/);
  assert.match(printed, /GH₵251\.35/);
  await scan('trade-receipt');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('[data-nav="sales"]').click();
  await page.getByLabel('Search sales').fill(buyerName);
  const row = page.locator('.records-sales tbody tr').filter({ hasText: buyerName });
  await row.waitFor();
  assert.match(await row.innerText(), /Trade buyer:/);
  assert.match(await row.innerText(), /Paid/);
  await row.getByRole('button', { name: 'View quote' }).click();
  assert.match(await page.getByRole('dialog', { name: 'Approved trade quote' }).innerText(), /GH₵251\.35/);
  await scan('saved-trade-quote');
  await page.getByRole('button', { name: 'Close quote' }).click();
  await page.locator('[data-nav="reports"]').click();
  const tradeSummary = page.locator('.report-sale-types');
  await tradeSummary.locator('.connection-rows span').filter({ hasText: 'Paid trade' }).waitFor();
  assert.match(await tradeSummary.innerText(), /Paid trade · [1-9]\d* orders?/);
  await scan('trade-reports');
  const catalogue = await page.evaluate(async () => (await (await fetch('/api/catalog', { credentials: 'same-origin' })).json()).products);
  assert.equal(catalogue.find(p => p.name === simple.name).price, simple.price, 'Trade quote must not alter catalogue prices.');

  await page.setViewportSize({ width: 320, height: 700 });
  await page.getByLabel('Open navigation').click();
  await page.locator('[data-nav="register"]').click();
  // The paid trade order may have consumed the last simple item. For the mobile
  // layout check, select a currently available option rather than assuming stock.
  const mobileGood = await page.evaluate(async () => {
    const { products } = await (await fetch('/api/catalog', { credentials: 'same-origin' })).json();
    const variable = products.find(p => p.type === 'variable' && p.variations.some(v => v.purchasable && v.stock > 0));
    if (variable) return { name: variable.name, variable: true };
    const simple = products.find(p => p.type === 'simple' && p.purchasable && p.stock > 0);
    if (simple) return { name: simple.name, variable: false };
    throw new Error('The isolated demo has no stock left for the mobile trade check.');
  });
  await page.locator('.product-card:not([disabled])').filter({ hasText: mobileGood.name }).first().click();
  if (mobileGood.variable) {
    await page.locator('.size-options button:not([disabled])').first().click();
    await page.getByRole('dialog').getByRole('button', { name: /Add to sale/ }).click();
  }
  await page.getByRole('button', { name: /View sale/ }).click();
  await page.getByRole('button', { name: 'Paid trade', exact: true }).click();
  await page.getByLabel('Named trade buyer').selectOption({ label: buyerName });
  await page.getByLabel(new RegExp(`Agreed unit price for ${mobileGood.name}`)).fill('75.50');
  await page.getByRole('checkbox', { name: /I approve these tax-inclusive unit prices/ }).check();
  assert.equal(await page.locator('.charge-button').isDisabled(), false);
  const bounds = await page.locator('.charge-button').boundingBox();
  assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 701, `320px mobile trade checkout button is not visible: ${JSON.stringify(bounds)}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile trade cart has horizontal overflow.');
  await scan('trade-cart-phone');
  console.log('PASS: named-buyer paid trade quote, no quantity-based price change, approval reset, lost-response recovery, full payment, receipt, sales history, accessibility, and 320px cart.');
} catch (error) {
  await recordFailure(page, error, 'trade-browser-failure', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
