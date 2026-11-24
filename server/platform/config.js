import path from 'node:path';
import { parseMasterKey } from './secrets.js';

// Settings for the multi-shop platform process itself. Shop settings live in
// the central database, not here.
export function readPlatformConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const baseDomain = String(env.PLATFORM_BASE_DOMAIN || '').trim().toLowerCase();
  if (!/^(?!-)[a-z0-9-]{1,63}(\.(?!-)[a-z0-9-]{1,63})+$/.test(baseDomain)) {
    throw new Error('PLATFORM_BASE_DOMAIN must be a domain such as mansupos.com.');
  }
  const masterKey = parseMasterKey(env.PLATFORM_MASTER_KEY);
  if (!masterKey) throw new Error('PLATFORM_MASTER_KEY is required (32 random bytes, hex or base64). Keep it outside the data folder and back it up separately.');
  const dataDir = path.resolve(env.PLATFORM_DATA_DIR || '.platform-data');
  const port = Number(env.PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const bindHost = env.PLATFORM_BIND_HOST || '127.0.0.1';
  if (!['0.0.0.0', '127.0.0.1'].includes(bindHost)) throw new Error('PLATFORM_BIND_HOST must be 127.0.0.1 or 0.0.0.0.');
  const maxOpenShops = Number(env.PLATFORM_MAX_OPEN_SHOPS || 50);
  if (!Number.isInteger(maxOpenShops) || maxOpenShops < 1 || maxOpenShops > 1000) throw new Error('PLATFORM_MAX_OPEN_SHOPS must be 1 to 1000.');
  const idleMinutes = Number(env.PLATFORM_SHOP_IDLE_MINUTES || 30);
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 1440) throw new Error('PLATFORM_SHOP_IDLE_MINUTES must be 1 to 1440.');
  return {
    production, nodeEnv: env.NODE_ENV || 'development', baseDomain, masterKey, dataDir,
    shopsDir: path.join(dataDir, 'shops'), registryFile: path.join(dataDir, 'platform.db'),
    port, bindHost, maxOpenShops, idleMs: idleMinutes * 60000,
    trustProxy: env.PLATFORM_TRUST_PROXY || (production ? 'loopback' : '1'),
    logLevel: env.POS_LOG_LEVEL || (production ? 'info' : 'debug'),
    shopOrigin: slug => `https://${slug}.${baseDomain}`,
  };
}
