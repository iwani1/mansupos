import fs from 'node:fs';
import { createRequire } from 'node:module';
import { chromium as playwright } from 'playwright-core';
import chromium from '@sparticuz/chromium';

const require = createRequire(import.meta.url);
export const testBase = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

export async function openBrowser(options = {}) {
  fs.mkdirSync('test-results', { recursive: true });
  let browser;
  if (process.env.TEST_CHROMIUM_PATH) {
    browser = await playwright.launch({ executablePath: process.env.TEST_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true });
  } else {
    await require('@sparticuz/chromium/build/lambdafs.js').default.inflate(process.cwd() + '/node_modules/@sparticuz/chromium/bin/al2023.tar.br');
    process.env.LD_LIBRARY_PATH = `/tmp/al2023/lib${process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''}`;
    browser = await playwright.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1, ...options });
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  return { browser, page, pageErrors };
}

export async function recordFailure(page, error, name, pageErrors = []) {
  const details = { name: error.name, message: error.message, stack: error.stack, pageErrors };
  try {
    details.url = page.url();
    details.visibleText = (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 8000);
    await page.screenshot({ path: `test-results/${name}.png`, fullPage: true, timeout: 5000 });
  } catch (captureError) { details.captureError = captureError.message; }
  fs.writeFileSync(`test-results/${name}.json`, JSON.stringify(details, null, 2));
  console.error(error);
}
