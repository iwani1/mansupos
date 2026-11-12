// Verify the self-contained, offline owner preview in a real browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';
import { proposeProductLayout } from '../scripts/preview-shared-woo-layout.mjs';
import { compareColourLayouts } from '../scripts/compare-shared-woo-colours.mjs';
import { renderColourVisualPreview } from '../scripts/render-shared-woo-colour-html.mjs';
import { openBrowser, recordFailure } from './browser-helpers.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-colour-browser-'));
const filename = path.join(dir, 'offline-preview.html');
const comparison = compareColourLayouts(proposeProductLayout(loadInStoreSnapshot()));
fs.writeFileSync(filename, renderColourVisualPreview(comparison), { mode: 0o600 });
const { browser, page, pageErrors } = await openBrowser();
try {
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto(pathToFileURL(filename).href);
  assert.equal(await page.getByRole('heading', { name: 'A page for each colour' }).count(), 1);
  assert.equal(await page.getByRole('heading', { name: 'One page, Colour + Size' }).count(), 1);
  const black = page.locator('details.colour-row').first();
  const white = page.locator('details.colour-row').nth(1);
  assert.deepEqual(await black.locator('.size-chip').allTextContents(), ['M', 'L']);
  assert.deepEqual(await white.locator('.size-chip').allTextContents(), ['S', 'M', 'L']);
  assert.equal(await white.evaluate(element => element.open), false);
  await white.locator('summary').click();
  assert.equal(await white.evaluate(element => element.open), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  assert.deepEqual(pageErrors, []);
  assert.equal(requests.length, 1, 'The offline page must not make external requests.');

  const audit = await browser.newPage({ bypassCSP: true });
  await audit.goto(pathToFileURL(filename).href);
  await audit.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
  const violations = await audit.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
    return result.violations.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target) }));
  });
  assert.deepEqual(violations, [], 'The offline comparison should be accessible.');
  console.log('Offline A/B visual: responsive, accessible, no fabricated size or external request.');
} catch (error) {
  await recordFailure(page, error, 'shared-woo-colour-visual', pageErrors);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
