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
  assert.deepEqual(result.violations.map(v => ({ page: name, id: v.id, help: v.help, targets: v.nodes.slice(0, 3).map(n => n.target) })), [], `${name}: wholesale UI has accessibility violations`);
}
async function addGoods(simple, variable) {
  await page.locator('.wholesale-product:not([disabled])').filter({ hasText: simple.name }).first().click();
  await page.getByRole('button', { name: `Increase ${simple.name}` }).click();
  await page.locator('.wholesale-product:not([disabled])').filter({ hasText: variable.name }).first().click();
  const modal = page.getByRole('dialog', { name: new RegExp(`Choose an option · ${variable.name}`) });
  await modal.locator('.wholesale-variant-list button:not([disabled])').first().click();
  await modal.getByRole('button', { name: 'Add to quote' }).click();
  assert.equal(await page.locator('.wholesale-line').count(), 2);
}
async function priceAndReview(simple, variable) {
  await page.getByLabel('Named wholesale buyer').selectOption({ label: buyerName });
  await addGoods(simple, variable);
  await page.getByLabel(new RegExp(`Agreed unit price for ${simple.name}`)).fill('92.00');
  await page.getByLabel(new RegExp(`Agreed unit price for ${variable.name}`)).fill('67.35');
  assert.equal((await page.locator('.wholesale-summary>div:nth-of-type(3) strong').innerText()).trim(), 'GH₵251.35');
  await page.getByRole('button', { name: /Review quote/ }).click();
  await page.getByRole('checkbox', { name: /I, Demo Owner, approve these final tax-inclusive prices/ }).check();
  assert.equal(await page.getByRole('button', { name: 'Prepare wholesale order' }).isDisabled(), false);
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  assert.equal(await page.locator('.sale-type-switch').count(), 0, 'Retail register must not expose a wholesale switch.');
  assert.equal(await page.locator('.trade-price, .trade-approval').count(), 0, 'Negotiated pricing must not appear in retail.');
  await page.locator('[data-nav="wholesale"]').click();
  await page.getByRole('heading', { name: 'Wholesale', exact: true }).waitFor();
  assert.equal(await page.locator('.wholesale-product').count(), 0, 'No goods before a named buyer.');
  assert.equal(await page.getByRole('button', { name: 'Review quote' }).count(), 0);
  const { simple, variable } = await page.evaluate(async () => {
    const catalog = await (await fetch('/api/catalog', { credentials: 'same-origin' })).json();
    const simple = catalog.products.find(p => p.type === 'simple' && p.stock >= 2 && p.purchasable);
    const variable = catalog.products.find(p => p.type === 'variable' && p.variations.some(v => v.stock > 0 && v.purchasable));
    if (!simple || !variable) throw new Error('Isolated demo needs one available simple and variable product.');
    return { simple: { name: simple.name, price: simple.price }, variable: { name: variable.name } };
  });
  buyerName = `Browser Wholesale Buyer ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'New buyer' }).click();
  await page.getByLabel('Person or business name').fill(buyerName);
  await page.getByRole('button', { name: 'Add buyer' }).click();
  await page.waitForFunction(name => document.querySelector('#wholesale-buyer option:checked')?.textContent === name, buyerName);
  assert.equal((await page.getByLabel('Named wholesale buyer').locator('option:checked').textContent()).trim(), buyerName);
  await addGoods(simple, variable);
  assert.equal(await page.getByRole('button', { name: 'Review quote' }).isDisabled(), true, 'Every line needs a final price.');
  await page.getByLabel(new RegExp(`Agreed unit price for ${simple.name}`)).fill('92.00');
  assert.equal(await page.getByRole('button', { name: 'Review quote' }).isDisabled(), true);
  await page.getByLabel(new RegExp(`Agreed unit price for ${variable.name}`)).fill('67.35');
  assert.equal((await page.locator('.wholesale-summary>div:nth-of-type(3) strong').innerText()).trim(), 'GH₵251.35');
  assert.match(await page.locator('.wholesale-summary').innerText(), /Catalogue reference/);
  await page.getByRole('button', { name: /Review quote/ }).click();
  assert.match(await page.locator('.wholesale-review').innerText(), new RegExp(buyerName));
  assert.match(await page.locator('.wholesale-review').innerText(), /2 × GH₵92\.00 tax included/);
  assert.match(await page.locator('.wholesale-review').innerText(), /no extra tax/);
  const approval = page.getByRole('checkbox', { name: /I, Demo Owner, approve these final tax-inclusive prices/ });
  assert.equal(await page.getByRole('button', { name: 'Prepare wholesale order' }).isDisabled(), true);
  await approval.check();
  await page.getByRole('button', { name: 'Edit quote' }).click();
  await page.getByLabel(new RegExp(`Agreed unit price for ${variable.name}`)).fill('67.34');
  await page.getByRole('button', { name: /Review quote/ }).click();
  assert.equal(await approval.isChecked(), false, 'Editing agreed terms clears the approval.');
  await page.getByRole('button', { name: 'Edit quote' }).click();
  await page.getByLabel(new RegExp(`Agreed unit price for ${variable.name}`)).fill('67.35');
  await page.getByRole('button', { name: /Review quote/ }).click();
  await approval.check();
  await scan('wholesale-quote-review');

  // Lose the first HTTP response after server-side creation. Rebuilding the
  // same buyer/lines/prices after reload must reuse the original checkout key.
  let dropped = false;
  await page.route('**/api/sales/prepare', async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.saleType, 'wholesale');
    assert.equal(body.wholesaleApproved, true);
    assert.deepEqual(body.items.map(i => i.agreedUnitPrice).sort((a,b) => a-b), [6735, 9200]);
    if (dropped) return route.continue();
    dropped = true;
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    createdId = (await response.json()).sale.id;
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Prepare wholesale order' }).click();
  await page.locator('.wholesale-review .notice.error').waitFor();
  await page.unroute('**/api/sales/prepare');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-nav="wholesale"]').click();
  await page.getByRole('heading', { name: 'Wholesale', exact: true }).waitFor();
  await priceAndReview(simple, variable);
  await page.getByRole('button', { name: 'Prepare wholesale order' }).click();
  const dialog = page.getByRole('dialog', { name: 'Complete payment' });
  await dialog.waitFor();
  assert.match(await dialog.locator('.wholesale-payment-quote').innerText(), new RegExp(buyerName));
  assert.match(await dialog.locator('.wholesale-payment-quote').innerText(), /Approved by Demo Owner/);
  assert.match(await dialog.locator('.wholesale-payment-quote').innerText(), /Catalogue/);
  assert.equal((await dialog.locator('.amount-due strong').innerText()).trim(), 'GH₵251.35');
  const { sales } = await page.evaluate(async () => (await (await fetch('/api/sales', { credentials: 'same-origin' })).json()));
  const matches = sales.filter(s => s.id === createdId);
  assert.equal(matches.length, 1, 'Retry after reload must not create a second sale.');
  assert.equal(matches[0].buyerName, buyerName);
  assert.equal(matches[0].saleType, 'wholesale');
  assert.equal(matches[0].agreedTotal, 25135);
  assert.equal(matches[0].status, 'awaiting_payment');
  await scan('wholesale-payment');
  await page.getByLabel('Cash received (GH₵)').fill('251.34');
  await page.getByRole('checkbox', { name: /full wholesale payment is a demo record/ }).check();
  assert.equal(await page.getByRole('button', { name: 'Complete demo wholesale sale' }).isDisabled(), true);
  await page.getByLabel('Cash received (GH₵)').fill('251.35');
  await page.getByRole('button', { name: 'Complete demo wholesale sale' }).click();
  await page.getByRole('heading', { name: 'Demo sale complete' }).waitFor();
  const receipt = page.locator('.receipt-dialog .receipt-paper');
  const printed = await receipt.innerText();
  assert.match(printed, new RegExp(buyerName));
  assert.match(printed, /Tax included · approved by Demo Owner/);
  assert.match(printed, /2 × GH₵92\.00 · tax included/);
  assert.match(printed, /1 × GH₵67\.35 · tax included/);
  assert.match(printed, /Included tax/);
  assert.match(printed, /GH₵251\.35/);
  await scan('wholesale-receipt');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('[data-nav="sales"]').click();
  await page.getByLabel('Search sales').fill(buyerName);
  const row = page.locator('.records-sales tbody tr').filter({ hasText: buyerName });
  await row.waitFor();
  assert.match(await row.innerText(), /Wholesale buyer:/);
  assert.match(await row.innerText(), /Paid/);
  await row.getByRole('button', { name: 'View quote' }).click();
  assert.match(await page.getByRole('dialog', { name: 'Approved wholesale quote' }).innerText(), /GH₵251\.35/);
  await scan('saved-wholesale-quote');
  await page.getByRole('button', { name: 'Close quote' }).click();
  await page.locator('[data-nav="reports"]').click();
  const summary = page.locator('.report-sale-types');
  await summary.locator('.connection-rows span').filter({ hasText: 'Wholesale' }).waitFor();
  assert.match(await summary.innerText(), /Wholesale · [1-9]\d* orders?/);
  await scan('wholesale-reports');
  const catalogue = await page.evaluate(async () => (await (await fetch('/api/catalog', { credentials: 'same-origin' })).json()).products);
  assert.equal(catalogue.find(p => p.name === simple.name).price, simple.price, 'The quote must not alter catalogue prices.');

  await page.setViewportSize({ width: 320, height: 700 });
  await page.getByLabel('Open navigation').click();
  await page.locator('[data-nav="wholesale"]').click();
  const mobileGood = await page.evaluate(async () => {
    const { products } = await (await fetch('/api/catalog', { credentials: 'same-origin' })).json();
    const variable = products.find(p => p.type === 'variable' && p.variations.some(v => v.purchasable && v.stock > 0));
    if (variable) return { name: variable.name, variable: true };
    const simple = products.find(p => p.type === 'simple' && p.purchasable && p.stock > 0);
    if (simple) return { name: simple.name, variable: false };
    throw new Error('The isolated demo has no stock left for the mobile wholesale check.');
  });
  await page.getByLabel('Named wholesale buyer').selectOption({ label: buyerName });
  await page.locator('.wholesale-product:not([disabled])').filter({ hasText: mobileGood.name }).first().click();
  if (mobileGood.variable) {
    const modal = page.getByRole('dialog', { name: new RegExp(`Choose an option · ${mobileGood.name}`) });
    await modal.locator('.wholesale-variant-list button:not([disabled])').first().click();
    await modal.getByRole('button', { name: 'Add to quote' }).click();
  }
  await page.getByLabel(new RegExp(`Agreed unit price for ${mobileGood.name}`)).fill('75.50');
  await page.getByRole('button', { name: /Review quote/ }).click();
  await page.getByRole('checkbox', { name: /I, Demo Owner, approve these final tax-inclusive prices/ }).check();
  const button = page.getByRole('button', { name: 'Prepare wholesale order' });
  assert.equal(await button.isDisabled(), false);
  await button.scrollIntoViewIfNeeded();
  const bounds = await button.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 321, `320px wholesale approval button is not visible: ${JSON.stringify(bounds)}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile wholesale page has horizontal overflow.');
  await scan('wholesale-phone');
  assert.deepEqual(pageErrors, [], 'Browser reported JavaScript errors.');
  console.log('PASS: buyer-first Wholesale page, retail isolation, negotiated prices, explicit approval, lost-response recovery, full payment, receipt, reports, accessibility and 320px layout.');
} catch (error) {
  await recordFailure(page, error, 'wholesale-browser-failure', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
