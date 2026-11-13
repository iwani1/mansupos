import fs from 'node:fs';
import { createRequire } from 'node:module';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

const require = createRequire(import.meta.url);
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// Run only against an isolated demo ledger. This exercises the EXISTING POS
// inventory/wholesale pages, not a production Woo API or a live checkout.
const { browser, page, pageErrors } = await openBrowser();
let created = null;
try {
  const health = await (await page.request.get(`${base}/api/health`)).json();
  if (health.mode !== 'demo') throw new Error('Private-price browser test must run against an isolated demo server only.');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  const { products } = await page.evaluate(async () => (await (await fetch('/api/catalog', { credentials: 'same-origin' })).json()));
  const { prices: before } = await page.evaluate(async () => (await (await fetch('/api/wholesale-prices', { credentials: 'same-origin' })).json()));
  const unused = (product, option) => !before.some(price => price.productId === product.id && price.variationId === (option?.id || 0));
  const canAdd = line => line.purchasable && line.stockStatus !== 'outofstock' && (!line.manageStock || line.stock > 0);
  const simple = products.find(product => product.type === 'simple' && canAdd(product) && unused(product));
  const variable = simple ? null : products.find(product => product.type === 'variable' && product.variations.some(option => canAdd(option) && unused(product, option)));
  const product = simple || variable;
  const option = variable?.variations.find(item => canAdd(item) && unused(variable, item)) || null;
  if (!product) throw new Error('No unsold demo product for this isolated price test. Start a fresh demo ledger.');
  const chosenPrice = option?.price ?? product.price;

  await page.locator('[data-nav="inventory"]').click();
  await page.getByRole('heading', { name: 'Inventory', exact: true }).waitFor();
  const candidate = page.locator('.records-inventory tbody tr').filter({ hasText: product.name });
  const row = option ? candidate.filter({ has: page.locator('td[data-label="Size / variant"]').getByText(option.label, { exact: true }) }) : candidate.first();
  await row.getByRole('button', { name: 'Set private price' }).click();
  const dialog = page.getByRole('dialog', { name: 'Private wholesale price' });
  await page.evaluate(axeSource);
  const violations = await page.evaluate(async () => (await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
  })).violations.map(issue => ({ id: issue.id, targets: issue.nodes.map(node => node.target) })));
  if (violations.length) throw new Error(`Private wholesale price dialog accessibility: ${JSON.stringify(violations)}`);
  await dialog.getByLabel('Wholesale unit price (GH₵, all-in)').fill('75.00');
  created = { productId: product.id, variationId: option?.id || 0 }; // Clean up even if the save response is interrupted.
  await dialog.getByRole('button', { name: 'Save private price' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await row.getByText('GH₵75.00').waitFor();
  await row.getByText(`GH₵${(chosenPrice / 100).toFixed(2)}`).waitFor();
  const retail = await page.evaluate(async () => (await (await fetch('/api/catalog', { credentials: 'same-origin' })).json()).products);
  const retailProduct = retail.find(item => item.id === product.id);
  if (retailProduct?.price !== product.price || option && retailProduct?.variations.find(item => item.id === option.id)?.price !== option.price ||
      JSON.stringify(retail).includes('priceCents')) {
    throw new Error('Private price was exposed in the retail catalogue or changed the retail price.');
  }

  await page.setViewportSize({ width: 390, height: 800 });
  await row.getByRole('button', { name: 'Edit private price' }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Private inventory price overflows the mobile window.');
  await page.getByLabel('Open navigation').click();
  const received = page.waitForResponse(response => response.url().endsWith('/api/wholesale-prices') && response.request().method() === 'GET');
  await page.locator('[data-nav="wholesale"]').click();
  await received;
  await page.getByRole('heading', { name: 'Wholesale', exact: true }).waitFor();
  await page.locator('.wholesale-product:not([disabled])').filter({ hasText: product.name }).first().click();
  if (option) {
    await page.locator('.wholesale-variant-list button').filter({ has: page.locator('strong').getByText(option.label, { exact: true }) }).click();
    await page.getByRole('button', { name: 'Add to quote' }).click();
  }
  const input = page.locator(`#wholesale-price-${product.id}-${option?.id || 0}`);
  if (await input.inputValue() !== '75.00') throw new Error('The saved private price did not prefill this wholesale quote.');
  await page.getByText('Private wholesale default GH₵75.00').waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Wholesale private price overflows the mobile window.');
  if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join('; ')}`);
  console.log('PASS: owner-only private default saved from Inventory, retail unchanged, Wholesale quote prefilled, 390px layout. No order was created.');
} catch (error) {
  await recordFailure(page, error, 'wholesale-prices-browser-failure', pageErrors);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await page.evaluate(async ({ productId, variationId }) => {
        const res = await fetch('/api/wholesale-prices', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Could not read demo defaults for cleanup: ${res.status}`);
        const { prices } = await res.json();
        const record = prices.find(item => item.productId === productId && item.variationId === variationId);
        if (record) {
          const removed = await fetch(`/api/wholesale-prices/${productId}/${variationId}`, {
            method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedRevision: record.revision }),
          });
          if (!removed.ok) throw new Error(`Could not remove demo private price: ${removed.status}`);
        }
      }, created);
    } catch (error) { console.error('Demo-only private price cleanup failed:', error.message); process.exitCode = 1; }
  }
  await browser.close();
}
