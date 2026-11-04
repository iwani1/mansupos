import http from 'node:http';
import https from 'node:https';
import { openBrowser, testBase } from './browser-helpers.mjs';

// Simulate an embedded preview proxy that removes Authorization and Cookie
// headers (and drops Set-Cookie). The demo must still open using the explicit
// X-Mansu-Session fallback header; staging/live credentials are never relaxed.
const target = new URL(testBase);
const transport = target.protocol === 'https:' ? https : http;
const proxy = http.createServer((req, res) => {
  const headers = { ...req.headers };
  delete headers.authorization;
  delete headers.cookie;
  headers['x-forwarded-host'] = req.headers.host;
  headers['x-forwarded-proto'] = 'http';
  const upstream = transport.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: req.url,
    headers,
  }, response => {
    const out = { ...response.headers };
    delete out['set-cookie'];
    res.writeHead(response.statusCode || 502, out);
    response.pipe(res);
  });
  upstream.on('error', error => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(String(error));
  });
  req.pipe(upstream);
});

await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${proxy.address().port}`;
const { browser, page, pageErrors } = await openBrowser();
try {
  const apiStatuses = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/')) apiStatuses.push([response.status(), url.pathname]);
  });
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.locator('.cart-panel').waitFor({ timeout: 20000 });
  const products = await page.locator('.product-card').count();
  const failed = apiStatuses.filter(([status]) => status >= 400);
  if (products < 1 || failed.length || pageErrors.length) {
    throw new Error(`Embedded preview did not open cleanly: ${JSON.stringify({ products, failed, pageErrors })}`);
  }
  console.log('PASS: demo opens when Authorization and cookies are stripped by an embedded preview proxy.');
} finally {
  await browser.close();
  await new Promise(resolve => proxy.close(resolve));
}
