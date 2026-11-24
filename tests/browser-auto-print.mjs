// Web-app auto-print: off by default; when ticked on this device, a just-paid
// sale's receipt calls window.print() once; a receipt reopened from Sales
// history never prints by itself. (Silent printing itself comes from the
// browser's --kiosk-printing mode, which this test cannot observe.)
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';
const { browser, page, pageErrors } = await openBrowser();
await page.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints += 1; }; });
const prints = () => page.evaluate(() => window.__prints);

async function sell() {
  const target = await page.evaluate(async () => {
    const data = await (await fetch('/api/catalog', { credentials: 'same-origin' })).json();
    const ok = line => line.purchasable && line.stockStatus !== 'outofstock' && (!line.manageStock || line.stock == null || line.stock > 0);
    const product = (data.products || []).find(p => p.type === 'variable' && p.variations.some(ok));
    return { name: product.name, price: product.variations.find(ok).price };
  });
  await page.locator('.product-card:not([disabled])').filter({ hasText: target.name }).first().click();
  await page.locator('.size-options button:not([disabled])').first().click();
  await page.getByRole('dialog').getByRole('button', { name: /Add to sale/ }).click();
  await page.getByRole('button', { name: /Prepare order GH/ }).click();
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByLabel('Cash received (GH₵)').fill(String(Math.ceil(target.price / 100) + 20));
  await page.getByRole('checkbox', { name: /demo payment record/ }).check();
  await page.getByRole('button', { name: 'Complete demo sale' }).click();
  await page.getByRole('heading', { name: 'Demo sale complete' }).waitFor();
}

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();

  await sell();
  await page.waitForTimeout(1500);
  const toggle = page.getByRole('checkbox', { name: /Print automatically after each sale/ });
  if (await toggle.isChecked()) throw new Error('Auto-print must be off by default.');
  if (await prints() !== 0) throw new Error('Receipt printed while auto-print was off.');
  await toggle.check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  console.log('Auto-print off by default: PASS');

  await sell();
  // Printing waits for the receipt to be painted, which can take a while on a busy CI runner.
  await page.waitForFunction(() => window.__prints >= 1, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  if (await prints() !== 1) throw new Error(`Expected one automatic print, got ${await prints()}.`);
  await page.getByText('Receipt sent to the printer automatically.').waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  console.log('Auto-print once after a sale: PASS');

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-nav="sales"]').click();
  await page.getByRole('button', { name: 'Receipt', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Sale receipt' }).waitFor();
  await page.waitForTimeout(1500);
  if (await prints() !== 0) throw new Error('A reopened receipt printed by itself.');
  if (!(await page.getByRole('checkbox', { name: /Print automatically after each sale/ }).isChecked())) throw new Error('Auto-print choice was not remembered on this device.');
  console.log('Reopened receipt does not auto-print; choice remembered: PASS');
  if (pageErrors.length) throw new Error(`Page errors: ${pageErrors.join('; ')}`);
} catch (error) {
  await recordFailure(page, error, 'auto-print-failure', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
