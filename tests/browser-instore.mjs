import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

const require = createRequire(import.meta.url);
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// Exercise the real In-store UI with an isolated demo process and intercepted
// responses. Never create an order, stock change or payment on the real site.
const { browser, page, pageErrors } = await openBrowser();
await page.emulateMedia({ reducedMotion: 'reduce' });
const source = loadInStoreSnapshot();
let approved = false;
let stock = 2;
let firstResponseLost = true;
let salePosts = 0;
let onlinePosts = 0;
let delayFirstHistory = true;
const sales = [];
async function scan(label) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }));
  const violations = result.violations.map(issue => ({ id: issue.id, help: issue.help, targets: issue.nodes.map(node => node.target).slice(0, 5) }));
  if (violations.length) throw new Error(`${label} accessibility violations: ${JSON.stringify(violations)}`);
}
const configFor = data => ({ ...data, mode: 'live', liveReadOnly: !approved,
  inStoreCashEnabled: approved, configured: true, writesEnabled: false,
  wholesaleWritesEnabled: false, requireShift: approved, paymentMethods: ['cash'],
  storeUrl: 'https://mansutrendzgh.com' });
try {
  for (const endpoint of ['**/api/auth/demo', '**/api/session']) {
    await page.route(endpoint, async route => {
      const response = await route.fetch();
      const data = await response.json();
      if (data.user) data.config = configFor(data.config);
      await route.fulfill({ response, json: data });
    });
  }
  await page.route('**/api/shifts/current', route => route.fulfill({ json: { shift: approved
    ? { id: 'isolated-fixture-shift', userId: 'demo-owner', userName: 'Demo Owner', status: 'open', openingFloat: 0,
      expectedCash: 0, summary: { orders: 0, net: 0, cash: 0, momo: 0, card: 0, inStoreOrders: 0, inStoreCash: 0 }, movements: [] }
    : null, required: approved } }));
  await page.route('**/api/instore/catalog', route => route.fulfill({ json: {
    ...source, summary: { ...source.summary, salesEnabled: approved,
      ...(approved ? { importedAt: '2026-11-03T10:00:00Z' } : {}) },
    items: source.items.map(item => item.sku === '1434' && approved
      ? { ...item, stock, status: stock > 0 ? 'available' : 'out_of_stock' } : item),
  } }));
  await page.route('**/api/instore/sales/by-key/*', route => {
    const key = route.request().url().split('/').at(-1);
    const match = sales.find(entry => entry.key === key);
    return match ? route.fulfill({ json: { sale: match.sale } }) : route.fulfill({ status: 404, json: { error: 'In-store receipt not found.' } });
  });
  await page.route('**/api/instore/sales?*', route => route.fulfill({ json: { sales: sales.map(entry => entry.sale).toReversed(), nextCursor: null } }));
  await page.route('**/api/instore/stock/1434/movements?*', async route => {
    if (delayFirstHistory) { delayFirstHistory = false; await new Promise(resolve => setTimeout(resolve, 350)); }
    await route.fulfill({ json: {
      sku: '1434', name: 'HAMIDA SKIRT SET FLORAL L', initialQuantity: 2, onHand: stock, nextCursor: null,
      movements: [{ id: 3, delta: -1, balanceAfter: stock, kind: 'sale',
        receiptNumber: sales.at(-1)?.sale.number || '', occurredAt: '2026-11-03T10:30:00Z', reason: '' }],
    } });
  });
  await page.route('**/api/instore/reports?*', route => route.fulfill({ json: { days: 7, orders: sales.length, total: sales.length * 35000, cash: sales.length * 35000,
    units: sales.length, average: sales.length ? 35000 : 0, daily: [{ date: '2026-11-03', count: sales.length, total: sales.length * 35000 }],
    topProducts: sales.length ? [{ sku: '1434', name: 'HAMIDA SKIRT SET FLORAL L', quantity: sales.length, total: sales.length * 35000 }] : [],
    scope: 'POS-only in-store cash sales. Excludes online orders, WooCommerce Retail and Wholesale. Gross amounts; no tax breakdown.' } }));
  await page.route('**/api/instore/sales', async route => {
    salePosts++;
    const body = route.request().postDataJSON();
    if (body.method || body.wooOrderId || body.price || body.items.length !== 1 || body.items[0].sku !== '1434' ||
        body.items[0].quantity !== 1 || body.expectedTotal !== 35000 || body.tendered !== 40000 || body.confirmed !== true) {
      throw new Error(`Unsafe browser sale payload: ${JSON.stringify(body)}`);
    }
    let existing = sales.find(entry => entry.key === body.idempotencyKey);
    if (!existing) {
      if (stock < 1) throw new Error('Browser test oversold mocked stock');
      stock--;
      existing = { key: body.idempotencyKey, sale: {
        id: `550e8400-e29b-41d4-a716-${String(salePosts).padStart(12, '0')}`,
        number: `IS-20261103-${String(salePosts).padStart(6, '0')}`, status: 'paid', saleType: 'instore',
        paymentMethod: 'cash', currency: 'GHS', cashierName: 'Demo Owner', shiftId: 'isolated-fixture-shift',
        paidAt: '2026-11-03T10:30:00Z', total: 35000, tendered: 40000, changeDue: 5000,
        items: [{ sku: '1434', name: 'HAMIDA SKIRT SET FLORAL L', quantity: 1, price: 35000, total: 35000 }],
      } };
      sales.push(existing);
    }
    if (firstResponseLost) { firstResponseLost = false; return route.abort('failed'); }
    return route.fulfill({ status: 201, json: { sale: existing.sale } });
  });
  await page.route('**/api/sales/prepare', route => { onlinePosts++; return route.abort('failed'); });

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  await page.locator('[data-nav="instore"]').click();
  await page.getByRole('heading', { name: 'In-store collection' }).waitFor();
  await page.getByText('Catalogue only — in-store checkout locked.').waitFor();
  await page.getByRole('button', { name: 'Open quick guide' }).click();
  const guide = page.getByRole('dialog', { name: 'Your quick guide' });
  await guide.getByText('The read-only pilot cannot sell or recount this stock.', { exact: false }).waitFor();
  await guide.getByRole('button', { name: 'Got it' }).click();
  await page.getByLabel('Search in-store goods').fill('1471');
  const heldPrice = page.getByRole('listitem').filter({ hasText: 'SKU 1471' });
  await heldPrice.getByText('NAYA CLASSIC KNIT POLO TOP L').waitFor();
  await heldPrice.getByText('Check price').waitFor();
  await heldPrice.getByText(`PDF reports ${source.items.find(item => item.sku === '1471').reportedQuantity} · not sellable`).waitFor();
  if (await page.getByRole('button', { name: 'Record cash sale & deduct POS stock' }).count()) throw new Error('Pilot offered a physical-stock checkout.');
  await scan('locked in-store collection');
  await page.setViewportSize({ width: 375, height: 812 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Locked In-store collection overflows a phone.');
  await scan('locked in-store collection on phone');

  approved = true;
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-nav="instore"]').click();
  await page.getByText('Cash-only register active').waitFor();
  await page.getByRole('button', { name: 'Open quick guide' }).click();
  await guide.getByText('Only the in-store POS stock is deducted.', { exact: false }).waitFor();
  await guide.getByRole('button', { name: 'Got it' }).click();
  await page.screenshot({ path: 'test-results/instore-approved-desktop.png' });
  await scan('approved in-store collection');
  await page.getByLabel('Search in-store goods').fill('1197');
  const emptyStock = page.getByRole('listitem').filter({ hasText: 'SKU 1197' });
  await emptyStock.getByText('No stock').waitFor();
  if (await emptyStock.getByRole('button', { name: 'Add', exact: true }).count()) throw new Error('An originally zero-stock item was offered for sale.');
  await page.getByLabel('Search in-store goods').fill('1434');
  const product = page.getByRole('listitem').filter({ hasText: 'SKU 1434' });
  const pendingHistory = page.waitForResponse(response => response.url().includes('/instore/stock/1434/movements'));
  await product.getByRole('button', { name: 'Stock history' }).click();
  await page.getByRole('dialog', { name: 'In-store stock history' }).getByRole('button', { name: 'Close history' }).click();
  await pendingHistory;
  await page.waitForTimeout(100); // Let the browser apply the delayed response after the dialog was closed.
  if (await page.getByRole('dialog', { name: 'In-store stock history' }).count()) throw new Error('A closed stock history reopened after its delayed response.');
  await product.getByRole('button', { name: 'Record count' }).click();
  await page.getByRole('dialog', { name: 'Record physical stock count' }).waitFor();
  await scan('owner physical count modal');
  await page.getByRole('dialog', { name: 'Record physical stock count' }).getByRole('button', { name: 'Close', exact: true }).click();
  await product.getByRole('button', { name: 'Add', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Approved in-store cash cart overflows a phone.');
  await scan('approved in-store cash cart on phone');
  await page.getByLabel('Cash received (GH₵)').fill('400.00');
  await page.getByRole('checkbox', { name: /I have counted the full cash amount/ }).check();
  await page.getByRole('button', { name: 'Record cash sale & deduct POS stock' }).click();
  await page.getByText('An in-store cash attempt needs review.').waitFor();
  if (salePosts !== 1 || stock !== 1 || onlinePosts) throw new Error('Expected one POS-only sale whose response was lost.');
  if (!await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('mansu-instore-cash-attempt-')))) throw new Error('Lost-response attempt key was not preserved.');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('Open navigation').click();
  await page.locator('[data-nav="instore"]').click();
  await page.getByText('An in-store cash attempt needs review.').waitFor();
  await page.getByRole('button', { name: 'Check saved attempt' }).click();
  const dialog = page.getByRole('dialog', { name: 'In-store cash receipt' });
  await dialog.waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('In-store cash receipt overflows a phone.');
  await scan('gross-only in-store receipt');
  if (salePosts !== 1 || stock !== 1) throw new Error('A recovered receipt must never deduct stock twice.');
  const printed = await page.locator('#print-root').textContent();
  if (/WooCommerce|Paystack|\bTax\b|VAT|Cost/i.test(printed) || !/IS-20261103-000001/.test(printed) || !/GH₵350\.00/.test(printed)) {
    throw new Error('In-store receipt is not a gross-only POS cash receipt.');
  }
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.getByLabel('Search in-store goods').fill('1434');
  await product.getByText('1 POS unit').waitFor();
  await product.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Cash received (GH₵)').fill('400.00');
  await page.getByRole('checkbox', { name: /I have counted the full cash amount/ }).check();
  await page.getByRole('button', { name: 'Record cash sale & deduct POS stock' }).click();
  await dialog.waitFor();
  if (salePosts !== 2 || stock !== 0 || onlinePosts || pageErrors.length) {
    throw new Error(`Unexpected stock/request/browser error: ${salePosts} posts, ${stock} stock, ${onlinePosts} online posts, ${pageErrors.join('; ')}`);
  }
  await dialog.getByRole('button', { name: 'Done' }).click();
  await product.getByRole('button', { name: 'Stock history' }).click();
  const historyDialog = page.getByRole('dialog', { name: 'In-store stock history' });
  await historyDialog.getByText('POS balance: 0 units.').waitFor();
  await scan('physical stock movements');
  await historyDialog.getByRole('button', { name: 'Close history' }).click();
  await page.getByRole('button', { name: 'Cash receipts' }).click();
  await page.getByText('IS-20261103-000002').waitFor();
  await page.getByRole('button', { name: 'Cash reports' }).click();
  await page.getByText('Gross cash collected').waitFor();
  await scan('separate in-store cash reports');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('In-store reports overflow at desktop width.');
  console.log('PASS: isolated In-store pilot lock, mobile list, cash-only POS sale/recovery, gross receipt and separate history/reports.');
} catch (error) {
  await recordFailure(page, error, 'instore-browser-failure', pageErrors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
