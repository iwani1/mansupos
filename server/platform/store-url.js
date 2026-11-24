// A platform shop's WooCommerce address is typed by a shop owner, and the POS
// server then makes authenticated requests to it. Accept only a public HTTPS
// hostname: no IP literals, no single-label or private/internal names, no
// credentials, path, query or fragment. (Resolution-time checks against
// private address ranges belong in the outbound HTTP client: phase 2.)
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'invalid', 'localdomain', 'arpa'];
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function publicStoreHostProblem(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return 'Enter the store address.';
  if (host.includes(':') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host) || /^0x/i.test(host) || /^\d+$/.test(host)) {
    return 'Use the store\'s domain name, not an IP address.';
  }
  const labels = host.split('.');
  if (labels.length < 2 || host.length > 253 || !labels.every(label => LABEL.test(label))) return 'That is not a valid domain name.';
  if (!/[a-z]/.test(labels.at(-1))) return 'That is not a valid domain name.';
  if (PRIVATE_SUFFIXES.includes(labels.at(-1))) return 'Use the store\'s public web address.';
  return '';
}

// Returns the canonical HTTPS origin or throws with a plain-language reason.
export function normaliseStoreUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter the full store address, starting with https://.'); }
  if (url.protocol !== 'https:') throw new Error('The store address must start with https://.');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Use only the store\'s address, with no path, login or query.');
  }
  if (url.port) throw new Error('Use the store\'s normal HTTPS address, without a port.');
  const problem = publicStoreHostProblem(url.hostname);
  if (problem) throw new Error(problem);
  return url.origin;
}
