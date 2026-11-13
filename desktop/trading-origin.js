import { AppError } from '../server/errors.js';

// This is a PROPOSED dedicated hostname, not installed DNS or permission to
// deploy. Pin an exact reviewed origin at build time; a wildcard subdomain,
// the public shop and the existing read-only POS pilot must never receive a
// desktop staff password. Changing the host requires a reviewed new build.
export const TRADING_ORIGIN = 'https://trading.mansutrendzgh.com';
export function tradingOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash ||
      url.origin !== TRADING_ORIGIN) {
    throw new AppError('Use only the separately approved trading.mansutrendzgh.com POS host. The read-only pilot and shop are not trading servers.', 400, 'INVALID_TRADING_HOST');
  }
  return url.origin;
}
