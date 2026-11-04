import fs from 'node:fs';
import { chromium as playwright } from 'playwright-core';
import chromium from '@sparticuz/chromium';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
fs.mkdirSync('test-results', { recursive: true });
let browser;
if (process.env.TEST_CHROMIUM_PATH) {
  browser = await playwright.launch({ executablePath: process.env.TEST_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true });
} else {
  await require('@sparticuz/chromium/build/lambdafs.js').default.inflate(process.cwd() + '/node_modules/@sparticuz/chromium/bin/al2023.tar.br');
  process.env.LD_LIBRARY_PATH = `/tmp/al2023/lib${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`;
  browser = await playwright.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
}
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
await page.emulateMedia({ reducedMotion: 'reduce' });
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const violations = [];
async function scan(name) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }));
  for (const v of result.violations) violations.push({ page: name, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 8).map(n => n.target) });
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  await scan('register');
  await page.locator('[data-nav="sales"]').click();
  await page.getByRole('heading', { name: 'Sales history' }).waitFor();
  await scan('sales');
  await page.locator('[data-nav="reports"]').click();
  await page.getByRole('heading', { name: 'Sales reports' }).waitFor();
  await scan('reports');
  await page.locator('[data-nav="register"]').click();
  const variableName = await page.evaluate(async () => {
    const data = await (await fetch('/api/catalog', { credentials: 'same-origin' })).json();
    const available = line => line.purchasable && line.stockStatus !== 'outofstock' && (!line.manageStock || line.stock == null || line.stock > 0);
    return (data.products || []).find(p => p.type === 'variable' && p.variations.some(available))?.name || null;
  });
  if (variableName) {
    await page.locator('.product-card:not([disabled])').filter({ hasText: variableName }).click();
    await page.getByRole('heading', { name: 'Choose a size' }).waitFor();
    await scan('size-dialog');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  await page.setViewportSize({ width: 320, height: 700 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) violations.push({ page: 'register-320', id: 'horizontal-overflow', impact: 'serious', help: 'Page must not overflow at 320px', nodes: 1, targets: ['html'] });
  fs.writeFileSync('test-results/a11y.json', JSON.stringify(violations, null, 2));
  if (violations.length) {
    console.error(JSON.stringify(violations, null, 2));
    process.exitCode = 1;
  } else console.log('PASS: axe WCAG A/AA + best-practice scans and 320px overflow check.');
} catch (error) {
  await page.screenshot({ path: 'test-results/a11y-failure.png', fullPage: true });
  console.error(error);
  process.exitCode = 1;
} finally { await browser.close(); }
