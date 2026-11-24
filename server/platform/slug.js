// A shop's web address is <slug>.<base domain>. The slug is also how a request
// finds its shop, so it is validated strictly and never used as a file path
// (shop folders are named by the generated shop id).
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'console', 'platform', 'dashboard', 'login', 'signin', 'signup', 'register', 'account',
  'billing', 'pay', 'payments', 'checkout', 'help', 'support', 'docs', 'status', 'blog', 'mail', 'email', 'smtp', 'imap',
  'ftp', 'cdn', 'static', 'assets', 'media', 'img', 'images', 'dev', 'staging', 'test', 'demo', 'beta', 'internal',
  'mansu', 'mansupos', 'pos', 'root', 'system', 'security', 'abuse', 'postmaster', 'hostmaster', 'webmaster', 'ns1', 'ns2',
]);

export function slugProblem(slug) {
  const value = String(slug || '');
  if (!SLUG_PATTERN.test(value)) return 'Use 3 to 32 lowercase letters, numbers or hyphens, starting and ending with a letter or number.';
  if (value.includes('--')) return 'Do not use two hyphens in a row.';
  if (RESERVED.has(value)) return 'That address is reserved. Choose another.';
  return '';
}

// Host header -> slug, or null for anything that is not exactly one valid
// label under the base domain (the base domain itself returns '' so the
// caller can serve the platform's own pages).
export function slugFromHost(hostHeader, baseDomain) {
  const host = String(hostHeader || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const base = String(baseDomain || '').toLowerCase();
  if (!host || !base) return null;
  if (host === base || host === `www.${base}`) return '';
  if (!host.endsWith(`.${base}`)) return null;
  const label = host.slice(0, -(base.length + 1));
  return slugProblem(label) ? null : label;
}
