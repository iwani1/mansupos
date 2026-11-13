import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openBrowser, recordFailure } from './browser-helpers.mjs';

// The real static, no-network hardware-check renderer is tested without a
// trading server or Woo installation. This does not test physical hardware.
let browser, page, pageErrors = [];
const remoteRequests = [];
try {
  ({ browser, page, pageErrors } = await openBrowser({ viewport: { width: 900, height: 820 } }));
  page.on('request', request => {
    if (!request.url().startsWith('file://')) remoteRequests.push(request.url());
  });
  await page.addInitScript(() => {
    window.print = () => { window.__hardwarePrintCount = (window.__hardwarePrintCount || 0) + 1; };
  });
  await page.goto(pathToFileURL(path.resolve('desktop/hardware-test/index.html')).href, { waitUntil: 'load' });
  await page.getByRole('heading', { name: 'Check the counter hardware.' }).waitFor();
  await page.getByRole('alert').getByText('Not a point-of-sale application.').waitFor();
  const field = page.getByRole('textbox', { name: 'Barcode or SKU test' });
  await field.fill('TEST-LABEL-123');
  await field.press('Enter');
  assert.equal(await page.locator('#last-code').innerText(), 'TEST-LABEL-123');
  assert.match(await page.locator('#scan-status').innerText(), /Code and Enter received/);
  assert.equal(await field.inputValue(), '');
  await field.fill('<img src=x onerror=alert(1)>');
  await field.press('Enter');
  assert.equal(await page.locator('#last-code').innerText(), '<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('#last-code img').count(), 0);
  await page.getByRole('button', { name: 'Clear' }).click();
  assert.equal(await page.locator('#last-code').innerText(), '—');
  await page.keyboard.press('F2');
  assert.equal(await field.evaluate(node => document.activeElement === node), true);
  await page.getByRole('button', { name: 'Print TEST ONLY slip' }).click();
  assert.equal(await page.evaluate(() => window.__hardwarePrintCount), 1);
  const slip = await page.locator('#print-root').innerText();
  assert.match(slip, /HARDWARE TEST ONLY/);
  assert.match(slip, /NOT A RECEIPT/);
  assert.match(slip, /NOT VALID FOR GOODS RELEASE/);
  assert.doesNotMatch(slip, /TEST-LABEL-123|GH₵|payment received|order number/i);
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('#print-root').evaluate(node => getComputedStyle(node).display), 'block');
  assert.equal(await page.locator('.header').evaluate(node => getComputedStyle(node).display), 'none');
  assert.deepEqual(remoteRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log('Hardware-check renderer: scanner/Enter, text escaping, TEST ONLY print slip and print-only CSS passed. No physical hardware or POS writes tested.');
} catch (error) {
  if (page) await recordFailure(page, error, 'hardware-test-browser', pageErrors);
  throw error;
} finally {
  if (browser) await browser.close();
}
