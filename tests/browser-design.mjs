import { openBrowser, recordFailure, testBase as base } from './browser-helpers.mjs';

// This test changes only browser responses and local cart state. It never creates a sale.
const { browser, page, pageErrors } = await openBrowser({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
let sample;
let removeSelectedOption = false;
let simulateStaging = false;
let injectUnknownStock = false;
let injectLegacyStock = false;

async function fullyVisible(selector) {
  const box = await page.locator(selector).boundingBox();
  const { width, height } = page.viewportSize();
  if (!box || box.x < -1 || box.y < -1 || box.x + box.width > width + 1 || box.y + box.height > height + 1) {
    throw new Error(`${selector} is not fully visible in ${width}x${height}: ${JSON.stringify(box)}`);
  }
}
async function noPageOverflow(name) {
  const sizes = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
  if (sizes.document > sizes.viewport) throw new Error(`${name} has page overflow: ${JSON.stringify(sizes)}`);
}
async function mobileNavigate(id) {
  await page.getByLabel('Open navigation').click();
  await page.locator(`[data-nav="${id}"]`).click();
  await page.locator('main h1:visible').waitFor();
  await noPageOverflow(`mobile ${id}`);
}

try {
  await page.route('**/api/session', async route => {
    if (!simulateStaging) return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    data.user = null; // Force a fresh demo token before substituting the public UI configuration.
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/auth/demo', async route => {
    if (!simulateStaging) return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    Object.assign(data.config, { mode: 'staging', configured: true, writesEnabled: false, requireShift: true });
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/shifts/current', route => simulateStaging ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shift: null, required: true }) }) : route.continue());
  await page.route('**/api/catalog*', async route => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const data = await response.json();
    const simple = data.products.find(p => p.type === 'simple');
    const [soldOut, mixed] = data.products.filter(p => p.type === 'variable');
    if (!simple || !soldOut || !mixed) throw new Error('Demo catalogue needs one simple and two variable products.');
    Object.assign(simple, { stock: 99, stockStatus: 'instock', manageStock: true, purchasable: true, backorders: 'no' });
    Object.assign(soldOut, { stock: null, stockStatus: 'instock', manageStock: true, purchasable: true });
    soldOut.variations.forEach(v => Object.assign(v, { stock: 0, stockStatus: 'outofstock', manageStock: true, purchasable: true, backorders: 'no' }));
    // Independently managed variations can be in stock even when the parent quantity is zero.
    Object.assign(mixed, { stock: 0, stockStatus: 'instock', manageStock: true, purchasable: true });
    mixed.variations.forEach((v, i) => Object.assign(v, {
      stock: 5, stockStatus: 'instock', manageStock: true, purchasable: true, backorders: 'no',
      price: i === 0 ? 0 : v.price, label: `Red / ${['L', 'M', 'S'][i] || i}`,
      attributes: [{ name: 'Color', option: 'Red' }, { name: 'Size', option: ['L', 'M', 'S'][i] || String(i) }],
    }));
    data.products.push({ ...simple, id: 999991, name: 'Test backorder item', sku: 'TEST-BACKORDER', barcode: 'TEST-BACKORDER', stock: 0, stockStatus: 'onbackorder', backorders: 'yes' });
    data.products.push({ ...simple, id: 999993, name: 'Test notify backorder', sku: 'TEST-NOTIFY', barcode: 'TEST-NOTIFY', stock: 0, stockStatus: 'onbackorder', backorders: 'notify', backordersAllowed: true });
    const shared = { ...mixed, id: 999992, name: 'Test shared stock dress', sku: 'TEST-SHARED', barcode: 'TEST-SHARED', stockSource: 'product', stock: 3,
      variations: ['M', 'L', 'XL'].map((size, i) => ({ ...mixed.variations[i], id: 991001 + i, sku: `TEST-SHARED-${size}`, barcode: `TEST-SHARED-${size}`, label: size, attributes: [{ name: 'Size', option: size }], stockSource: i < 2 ? 'parent' : 'variation', stock: i < 2 ? 3 : 2, price: 10000 })) };
    data.products.push(shared);
    if (injectUnknownStock) data.products.push({ ...simple, id: 999994, name: 'Test unknown stock', sku: 'TEST-UNKNOWN', barcode: 'TEST-UNKNOWN', stockSource: 'unknown', manageStock: false, stock: null });
    if (simulateStaging) {
      // Demo fixtures have independent stock; add the ownership fields supplied by the live adapter.
      for (const p of data.products) {
        p.stockSource ??= p.manageStock ? 'product' : 'untracked';
        for (const v of p.variations) v.stockSource ??= v.manageStock ? 'variation' : 'untracked';
      }
      if (injectLegacyStock) {
        // Earlier cached Woo catalogues did not include ownership metadata.
        const legacySimple = { ...simple, id: 999995, name: 'Test legacy untracked stock', sku: 'TEST-LEGACY', barcode: 'TEST-LEGACY', manageStock: false, stock: null };
        delete legacySimple.stockSource;
        const legacyOption = { ...mixed.variations[0], id: 991050, label: 'M', attributes: [{ name: 'Size', option: 'M' }], stock: 5 };
        delete legacyOption.stockSource;
        const legacyVariable = { ...mixed, id: 999996, name: 'Test legacy option dress', sku: 'TEST-LEGACY-OPTION', barcode: 'TEST-LEGACY-OPTION', variations: [legacyOption] };
        data.products.push(legacySimple, legacyVariable);
      }
    }
    const pools = new Map();
    for (const p of data.products) for (const line of p.type === 'variable' ? p.variations : [p]) {
      if (!line.manageStock || !Number.isFinite(line.stock)) continue;
      const key = line.stockSource === 'parent' ? `${p.id}:parent` : `${p.id}:${line.id}`;
      pools.set(key, Math.min(pools.get(key) ?? Infinity, Math.max(0, line.stock)));
    }
    sample = { simple: simple.name, soldOut: soldOut.name, mixed: mixed.name, barcode: simple.barcode, tracked: [...pools.values()].reduce((a, b) => a + b, 0) };
    if (removeSelectedOption) mixed.variations = mixed.variations.slice(1);
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/sales/prepare', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated interruption' }) }));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();

  for (const size of [{ width: 1280, height: 800 }, { width: 1366, height: 768 }, { width: 1024, height: 768 }, { width: 1280, height: 640 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => window.scrollTo(0, 0));
    await fullyVisible('.charge-button');
    await noPageOverflow(`register ${size.width}x${size.height}`);
    if (size.width > 1080) await fullyVisible('.sidebar-profile > button');
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  const columns = await page.locator('.product-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  if (columns !== 3) throw new Error(`Expected three product columns at 1280px, found ${columns}.`);
  for (const selector of ['.product-category', '.stock-caption', '.nav-short-label']) {
    const size = await page.locator(selector).first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    if (size < 11) throw new Error(`${selector} is too small: ${size}px.`);
  }

  await page.locator('.product-card').filter({ hasText: sample.simple }).click();
  await page.getByRole('button', { name: 'Add note' }).click();
  await page.getByLabel('Sale note').fill('Design test note');
  await page.evaluate(() => window.scrollTo(0, 0));
  await fullyVisible('.charge-button');
  await page.getByRole('button', { name: /Prepare order GH/ }).click();
  await page.locator('.cart-details .notice.error').waitFor();
  await page.waitForFunction(() => {
    const container = document.querySelector('.cart-details').getBoundingClientRect();
    const notice = document.querySelector('.cart-details .notice.error').getBoundingClientRect();
    return notice.top >= container.top - 1 && notice.bottom <= container.bottom + 1;
  });
  await fullyVisible('.charge-button');
  if (await page.locator('.cart-details .notice.error').getAttribute('role') !== 'alert') throw new Error('Checkout error is not announced as an alert.');

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.product-card').first().waitFor();
  const soldOutCard = page.locator('.product-card').filter({ hasText: sample.soldOut });
  if (!(await soldOutCard.isDisabled()) || !(await soldOutCard.innerText()).includes('Out of stock')) throw new Error('A product with no available variations is still selectable.');
  const backorder = page.locator('.product-card').filter({ hasText: 'Test backorder item' });
  if (await backorder.isDisabled() || !(await backorder.innerText()).includes('Available on backorder')) throw new Error('Permitted backorder is not labelled or selectable.');
  const notifyBackorder = page.locator('.product-card').filter({ hasText: 'Test notify backorder' });
  if (await notifyBackorder.isDisabled()) throw new Error('A notify-policy backorder was disabled.');
  await notifyBackorder.click();
  if (!(await page.locator('.cart-item').innerText()).includes('Backorder · notify customer')) throw new Error('Backorder notification is not visible in the cart.');
  await page.getByLabel('Remove Test notify backorder').click();
  await page.getByRole('checkbox', { name: 'In stock only' }).check();
  if (await soldOutCard.count() || await backorder.count() || await notifyBackorder.count()) throw new Error('Physical-stock filter includes sold-out or backorder-only products.');
  await page.getByRole('checkbox', { name: 'In stock only' }).uncheck();

  await page.locator('.product-card').filter({ hasText: sample.mixed }).click();
  await page.getByRole('heading', { name: 'Choose an option' }).waitFor();
  if (!(await page.locator('.variant-modal .button.primary').innerText()).includes('GH₵0.00')) throw new Error('Zero-priced option did not show its actual price.');
  await page.locator('.variant-modal .button.primary').click();
  if (!(await page.locator('.cart-item').innerText()).includes('Color: Red · Size: L')) throw new Error('Multi-attribute option is mislabeled in the cart.');

  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await noPageOverflow('320px register');
  if (!(await page.getByRole('checkbox', { name: 'In stock only' }).isVisible())) throw new Error('Stock filter is hidden on a narrow screen.');
  for (const selector of ['.scanner-button', '.catalog-search-row > .icon-button']) {
    await fullyVisible(selector);
    const box = await page.locator(selector).boundingBox();
    if (box.width < 44 || box.height < 44) throw new Error(`${selector} is too small for touch.`);
  }
  await page.getByRole('button', { name: 'Scan product' }).click();
  if (!(await page.getByRole('dialog').innerText()).includes(sample.barcode)) throw new Error('Demo scanner did not suggest an available sample barcode.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: /View sale/ }).click();
  await fullyVisible('.charge-button');
  const overlap = await page.evaluate(() => {
    const charge = document.querySelector('.charge-button').getBoundingClientRect();
    const toast = document.querySelector('.toast')?.getBoundingClientRect();
    return toast && !(charge.right <= toast.left || charge.left >= toast.right || charge.bottom <= toast.top || charge.top >= toast.bottom);
  });
  if (overlap) throw new Error('Mobile notification covers the charge button.');
  await page.getByLabel('Close cart').click();

  await page.route('**/api/reports*', async route => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const data = await response.json();
    if (data.days === 7) {
      data.daily[0].total = -10000; data.daily[1].total = 20000; data.daily[2].total = 0;
      data.methods = [{ method: 'cash', count: 1, total: 10000 }, { method: 'momo', count: 1, total: -5000 }, { method: 'card', count: 0, total: 0 }];
    }
    await route.fulfill({ response, json: data });
  });
  for (const id of ['sales', 'inventory', 'shifts', 'reports', 'staff', 'audit', 'connection', 'register']) {
    await mobileNavigate(id);
    if (id === 'reports') {
      await page.locator('.bar.negative').waitFor();
      const bars = await page.locator('.bar').evaluateAll(els => els.slice(0, 3).map(el => ({ bottom: parseFloat(el.style.bottom), height: parseFloat(el.style.height), negative: el.classList.contains('negative') })));
      if (!bars[0].negative || bars[0].bottom !== 0 || Math.abs(bars[1].bottom - bars[0].height) > 0.01 || bars[2].height !== 0) throw new Error(`Signed report bars use the wrong baseline: ${JSON.stringify(bars)}`);
      await page.locator('.chart-details summary').click();
      if (!(await page.locator('.chart-values > div').first().innerText()).includes('-GH₵100.00')) throw new Error('Daily totals do not expose the signed amount.');
      const mixWidths = await page.locator('.payment-panel .progress-track span').evaluateAll(els => els.map(el => parseFloat(el.style.width)));
      if (mixWidths.join(',') !== '100,0,0') throw new Error(`Refunded payment mix rendered misleading bars: ${mixWidths}`);
      await page.selectOption('[aria-label="Report period"]', '90');
      await page.locator('.bar-chart.dense').waitFor();
      if (await page.locator('.bar-chart .bar').count() !== 90) throw new Error('90-day report is missing daily bars.');
      await noPageOverflow('90-day mobile report');
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => window.scrollTo(0, 0));
  removeSelectedOption = true;
  await page.getByRole('button', { name: 'Refresh catalogue', exact: true }).click();
  await page.locator('.product-card').filter({ hasText: sample.mixed }).getByText('2 options', { exact: true }).waitFor();
  await page.getByLabel(`Increase ${sample.mixed}`).click();
  await page.getByText('This option is no longer in the catalogue.', { exact: false }).waitFor();
  if (await page.locator('.cart-item').count() !== 1) throw new Error('A removed variation became a new invalid cart line.');

  // Simulate only the public staging UI configuration while the server remains an isolated demo.
  removeSelectedOption = false;
  simulateStaging = true;
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Open a shift before selling.', { exact: false }).waitFor();
  if (await page.locator('.topbar .badge').innerText() !== 'Checkout locked') throw new Error('Synced staging catalogue was mistaken for trading approval.');
  await page.locator('[data-nav="connection"]').click();
  await page.getByText('Staging · checkout locked').waitFor();
  await page.locator('[data-nav="register"]').click();
  const liveVariable = page.locator('.product-card').filter({ hasText: sample.mixed });
  if (!(await liveVariable.innerText()).includes('See option availability')) throw new Error('Variable live stock should not sum potentially shared parent stock.');
  await page.locator('[data-nav="inventory"]').click();
  const tracked = page.locator('.stat-card').filter({ hasText: 'Tracked stock' });
  if ((await tracked.locator('strong').innerText()) !== String(sample.tracked)) throw new Error('Inventory double-counted a shared parent stock pool.');
  const sharedRows = page.locator('.inventory-table tbody tr').filter({ hasText: 'Test shared stock dress' });
  if (await sharedRows.count() !== 3 || !(await sharedRows.nth(0).innerText()).includes('Shared across options') || (await sharedRows.nth(2).innerText()).includes('Shared across options')) throw new Error('Inventory does not distinguish shared and independent stock.');
  await page.locator('[data-nav="register"]').click();
  const sharedCard = page.locator('.product-card').filter({ hasText: 'Test shared stock dress' });
  await sharedCard.click();
  const modal = page.locator('.variant-modal');
  if (!(await modal.locator('.size-options button').first().innerText()).includes('3 available · shared across options')) throw new Error('Shared availability is not labelled in the option picker.');
  await modal.getByLabel('Increase quantity').click();
  await modal.locator('.button.primary').click(); // 2 of parent pool
  await sharedCard.click();
  await modal.locator('.size-options button').nth(1).click();
  await modal.getByLabel('Increase quantity').click();
  await modal.locator('.button.primary').click(); // adding 2 more would exceed 3
  await page.getByText('Only 3 available across these options.').waitFor();
  if (await page.locator('.cart-item').count() !== 1) throw new Error('Cart accepted more than the shared parent stock.');
  await modal.getByLabel('Decrease quantity').click();
  await modal.locator('.button.primary').click(); // exact shared limit
  await sharedCard.click();
  await modal.locator('.size-options button').nth(2).click();
  await modal.getByLabel('Increase quantity').click();
  await modal.locator('.button.primary').click(); // separate variation stock
  if (await page.locator('.cart-item').count() !== 3) throw new Error('An independent option was incorrectly blocked by the parent pool.');
  await page.locator('.product-card').filter({ hasText: sample.simple }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await fullyVisible('.charge-button');
  if (!(await page.locator('.charge-button').isDisabled())) throw new Error('Unapproved staging checkout was enabled.');
  await page.getByText('Checkout is locked until the owner approves this environment.').waitFor();
  injectUnknownStock = true;
  injectLegacyStock = true;
  await page.getByRole('button', { name: 'Refresh catalogue', exact: true }).click();
  for (const name of ['Test unknown stock', 'Test legacy untracked stock', 'Test legacy option dress']) {
    const card = page.locator('.product-card').filter({ hasText: name });
    if (!(await card.isDisabled()) || !(await card.innerText()).includes('Stock unavailable')) throw new Error(`${name} was presented as sellable or untracked.`);
  }
  await page.locator('[data-nav="inventory"]').click();
  if ((await page.locator('.stat-card').filter({ hasText: 'Tracked stock' }).locator('strong').innerText()) !== '—') throw new Error('Inventory showed a complete total despite unknown stock ownership.');
  for (const name of ['Test unknown stock', 'Test legacy untracked stock', 'Test legacy option dress']) {
    const row = page.locator('.inventory-table tbody tr').filter({ hasText: name });
    if (!(await row.innerText()).includes('Stock unavailable') || !(await row.locator('td').nth(4).innerText()).includes('—')) throw new Error(`${name} was presented as known stock in inventory.`);
  }
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
  console.log('PASS: counter-sized checkout, narrow-screen navigation, readable controls, stock/variation states, and accessible report totals.');
} catch (error) {
  await recordFailure(page, error, 'design-failure', pageErrors);
  process.exitCode = 1;
} finally { await browser.close(); }
