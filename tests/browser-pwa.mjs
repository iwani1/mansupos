import fs from 'node:fs';
import { createRequire } from 'node:module';
import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

// Run only against an isolated production-built demo. No live checkout or
// WooCommerce request is needed to test installation and the offline notice.
const require = createRequire(import.meta.url);
const { browser, page, pageErrors } = await openBrowser({ viewport: { width: 1280, height: 800 } });
const context = page.context();
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

async function cacheEntries() {
  return page.evaluate(async () => Promise.all((await caches.keys()).map(async name => ({
    name, paths: (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname),
  }))));
}
function assertOnlyPublicNotice(entries) {
  if (entries.length !== 1 || entries[0].name !== 'mansu-offline-notice-v1' || entries[0].paths.join(',') !== '/offline.html') {
    throw new Error(`Private or unexpected response found in service worker cache: ${JSON.stringify(entries)}`);
  }
}
async function issueInstallPrompt() {
  await page.evaluate(() => {
    window.__installPromptCalls ??= 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.defineProperty(event, 'prompt', { value: () => { window.__installPromptCalls++; } });
    Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome: 'dismissed' }) });
    window.dispatchEvent(event);
  });
}

try {
  const health = await (await page.request.get(`${base}/api/health`)).json();
  if (health.mode !== 'demo') throw new Error('Installability browser test must not run against a live or staging ledger.');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js'), null, { timeout: 20000 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  await cdp.detach();
  if (installabilityErrors.length) throw new Error(`Chromium reports an un-installable app: ${JSON.stringify(installabilityErrors)}`);

  const manifestResponse = await page.request.get(`${base}/manifest.webmanifest`);
  const manifest = await manifestResponse.json();
  if (!manifestResponse.ok() || !manifestResponse.headers()['content-type']?.includes('json') ||
      manifest.display !== 'standalone' || manifest.scope !== '/' || manifest.start_url !== '/') {
    throw new Error('Standalone manifest was not served at the app origin.');
  }
  for (const icon of manifest.icons) {
    const response = await page.request.get(new URL(icon.src, base).href);
    if (!response.ok() || !response.headers()['content-type']?.startsWith('image/png')) {
      throw new Error(`Install icon missing or served as HTML: ${icon.src}`);
    }
  }
  const workerResponse = await page.request.get(`${base}/sw.js`);
  if (!workerResponse.ok() || workerResponse.headers()['cache-control'] !== 'no-store') {
    throw new Error('Service worker must be served without HTTP caching.');
  }
  const sessionResponse = await page.request.get(`${base}/api/session`);
  if (!sessionResponse.ok() || sessionResponse.headers()['cache-control'] !== 'no-store') {
    throw new Error('POS API response must not be HTTP cached.');
  }
  assertOnlyPublicNotice(await cacheEntries());

  // Chromium headless does not always offer a native install prompt. Dispatch a
  // stand-in event to verify that desktop and compact navigation both expose it.
  await issueInstallPrompt();
  await page.getByRole('button', { name: 'Install this app' }).click();
  await page.waitForFunction(() => window.__installPromptCalls === 1);
  await page.setViewportSize({ width: 600, height: 760 });
  await issueInstallPrompt();
  await page.getByLabel('Open navigation').click();
  await page.getByRole('button', { name: 'Install desktop app' }).click();
  await page.waitForFunction(() => window.__installPromptCalls === 2);
  if (await page.getByLabel('Open navigation').getAttribute('aria-expanded') !== 'false') {
    throw new Error('Install action left the compact navigation drawer open.');
  }

  // Resizing the standalone window must keep core destinations reachable.
  for (const width of [320, 480, 820, 1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: 760 });
    if (width <= 1080) await page.getByLabel('Open navigation').click();
    await page.locator('[data-nav="inventory"]').click();
    await page.getByRole('heading', { name: 'Inventory', exact: true }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error(`Inventory navigation overflows the ${width}px window.`);
  }

  // Crossing the breakpoint with the drawer open must not leave the whole
  // workspace inert or keyboard focus stranded in a hidden menu button.
  await page.setViewportSize({ width: 820, height: 760 });
  await page.getByLabel('Open navigation').click();
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.waitForFunction(() => !document.querySelector('.sidebar').classList.contains('open') &&
    !document.querySelector('.main-shell').hasAttribute('inert'));
  const resized = await page.evaluate(() => ({
    bodyOverflow: getComputedStyle(document.body).overflow,
    focused: document.activeElement?.getAttribute('data-nav'),
    active: document.querySelector('.sidebar [aria-current="page"]')?.getAttribute('data-nav'),
  }));
  if (resized.bodyOverflow === 'hidden' || resized.focused !== resized.active) {
    throw new Error(`Resizing left navigation locked or focus hidden: ${JSON.stringify(resized)}`);
  }
  await page.locator('[data-nav="sales"]').click();
  await page.getByRole('heading', { name: 'Sales history', exact: true }).waitFor();

  // The open app warns about disconnection. Reopening it while offline shows
  // only a public safety page, never a cached catalogue/login/API or checkout.
  await page.setViewportSize({ width: 320, height: 700 });
  await context.setOffline(true);
  await page.getByRole('alert').filter({ hasText: 'Device offline.' }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Offline warning overflows a 320px window.');
  const apiWorkedOffline = await page.evaluate(async () => {
    try { await fetch('/api/session', { cache: 'no-store' }); return true; } catch { return false; }
  });
  if (apiWorkedOffline) throw new Error('Service worker served a private API response while offline.');
  await page.route('**/api/catalog?refresh=1', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated refresh failure' }),
  }));
  await context.setOffline(false);
  await page.getByText('Simulated refresh failure').waitFor();
  await page.getByRole('button', { name: 'Retry refresh' }).waitFor();
  if (!await page.locator('.offline-banner').count()) throw new Error('Reconnection hid the stock warning before a successful refresh.');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Reconnection warning overflows a 320px window.');
  await page.unroute('**/api/catalog?refresh=1');
  await page.getByRole('button', { name: 'Retry refresh' }).click();
  await page.waitForFunction(() => !document.querySelector('.offline-banner'));
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Connection required' }).waitFor();
  if (!await page.getByText('No offline sales.', { exact: false }).count()) throw new Error('Offline safety notice is missing.');
  assertOnlyPublicNotice(await cacheEntries());
  await page.evaluate(axeSource);
  const violations = await page.evaluate(async () => (await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
  })).violations.map(v => ({ id: v.id, impact: v.impact, targets: v.nodes.map(n => n.target) })));
  if (violations.length) throw new Error(`Offline notice accessibility violations: ${JSON.stringify(violations)}`);

  await context.setOffline(false);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Point of sale', exact: true }).waitFor();
  assertOnlyPublicNotice(await cacheEntries());
  if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join('\n')}`);
  console.log('PASS: Chromium installability, manifest/icons, network-only API, desktop/compact install actions, six window sizes and accessible offline notice.');
} catch (error) {
  await recordFailure(page, error, 'pwa-failure', pageErrors);
  process.exitCode = 1;
} finally {
  await context.setOffline(false);
  await browser.close();
}
