import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

// Browser-only synthetic bridge responses over the isolated demo server.
// No installed WP/Woo, cash, customer, stock write, external host or gateway.
const { browser, page, pageErrors } = await openBrowser();
let sale = null;
let holdAvailable = false;
let statusReads = 0;
let payRequests = 0;
let reconciles = 0;
const held = () => ({ state: 'reserved', orderId: 201, reservationVerified: true,
  paymentVerified: false, cancelledVerified: false, expiresAt: new Date(Date.now() + 600000).toISOString(),
  cashCollectionAllowed: holdAvailable });
try {
  await page.route('**/api/auth/demo', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.config = { ...data.config, mode: 'staging', liveReadOnly: false,
      onlineBridgeLocalTest: true, configured: true, writesEnabled: true,
      wholesaleWritesEnabled: false, requireShift: false,
      paymentMethods: ['cash'], storeUrl: 'https://127.0.0.1:3333' };
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/catalog*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.complete = true;
    data.products = data.products.map(product => ({ ...product, stockSource: 'product',
      variations: product.variations.map(variant => ({ ...variant, stockSource: 'variation' })) }));
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/sales', route => route.fulfill({ status: 200,
    json: { sales: sale ? [sale] : [], hasMore: false, nextCursor: null } }));
  await page.route('**/api/sales/prepare', async route => {
    const input = route.request().postDataJSON();
    assert.equal(input.items.length, 1);
    sale = { id: randomUUID(), number: 'STG-SYNTHETIC', wooOrderId: 201,
      onlineBridge: true, status: 'awaiting_payment', saleType: 'retail',
      items: [{ ...input.items[0], name: 'Synthetic local fixture', price: 10000, total: 10000, tax: 0 }],
      cashierName: 'Fixture Owner', buyerName: '', createdAt: new Date().toISOString(),
      total: 10000, subtotal: 10000, tax: 0, refunded: 0, paymentMethod: null, paidAt: null };
    await route.fulfill({ status: 201, json: { sale } });
  });
  await page.route('**/api/sales/*/online-status', route => {
    statusReads++;
    return route.fulfill({ status: 200, json: { sale, bridge: held() } });
  });
  await page.route('**/api/sales/*/pay', route => {
    payRequests++;
    sale = { ...sale, status: 'needs_reconciliation', paymentMethod: 'cash', tendered: 10000,
      error: 'Synthetic cash custody; paid Woo response was lost.' };
    return route.abort('failed');
  });
  await page.route('**/api/sales/*/reconcile', route => {
    reconciles++;
    sale = { ...sale, status: 'paid', paidAt: new Date().toISOString(), error: null };
    return route.fulfill({ status: 200, json: { sale } });
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  await page.getByText('Isolated local development fixture only.').first().waitFor();
  const simpleName = await page.evaluate(async () => {
    const catalog = await (await fetch('/api/catalog')).json();
    return catalog.products.find(p => p.type === 'simple' && p.stock > 0 && p.purchasable)?.name;
  });
  assert.ok(simpleName, 'Need one disposable simple demo product.');
  await page.locator('.product-card:not([disabled])').filter({ hasText: simpleName }).first().click();
  await page.locator('.charge-button').click();
  const checkout = page.getByRole('dialog', { name: 'Complete payment' });
  await checkout.waitFor();
  await checkout.getByLabel('Cash received (GH₵)').fill('100.00');
  await checkout.getByRole('checkbox', { name: /synthetic test tender only/ }).check();
  assert.equal(await checkout.getByRole('button', { name: 'Record simulated cash & verify Woo' }).isDisabled(), true,
    'A displayed sale without fresh payable hold must not accept cash.');
  assert.equal(payRequests, 0);
  await checkout.getByRole('button', { name: 'Leave unpaid' }).click();
  await page.locator('[data-nav="sales"]').click();
  const row = page.locator('.records-sales tbody tr').filter({ hasText: sale.number });
  await row.waitFor();
  holdAvailable = true;
  await row.getByRole('button', { name: 'Check test hold' }).click();
  await checkout.waitFor();
  await checkout.getByLabel('Cash received (GH₵)').fill('100.00');
  await checkout.getByRole('checkbox', { name: /synthetic test tender only/ }).check();
  await checkout.getByRole('button', { name: 'Record simulated cash & verify Woo' }).click();
  await checkout.getByRole('button', { name: 'Close · review original sale' }).waitFor();
  assert.equal(await checkout.getByRole('button', { name: 'Record simulated cash & verify Woo' }).isDisabled(), true,
    'A lost payment reply must block repeating the same cash write.');
  assert.equal(payRequests, 1);
  assert.equal(await page.getByRole('dialog', { name: 'Sale receipt' }).count(), 0);
  await checkout.getByRole('button', { name: 'Close · review original sale' }).click();
  await row.getByRole('button', { name: 'Reconcile' }).click();
  await row.getByRole('button', { name: 'Verify test receipt' }).click();
  const receipt = page.getByRole('dialog', { name: 'Sale receipt' });
  await receipt.waitFor();
  await receipt.getByText('SYNTHETIC LOCAL TEST — NOT A LIVE RECEIPT — NO REAL CASH').waitFor();
  assert.equal(await receipt.getByRole('button', { name: 'Printing locked for local test' }).isDisabled(), true);
  assert.equal(payRequests, 1);
  assert.ok(statusReads >= 3 && reconciles >= 2);
  assert.deepEqual(pageErrors, []);
  console.log('PASS: browser-only local bridge blocks cash without a fresh hold, blocks a lost-reply retry/receipt, and labels verified synthetic recovery non-printable.');
} catch (error) {
  await recordFailure(page, error, 'online-bridge-local-browser-failure', pageErrors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
