import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { mountProductionUi } from '../web-ui.js';
import { createPlatform } from './platform.js';

// Multi-shop server: every <shop>.<PLATFORM_BASE_DOMAIN> is a separate shop
// with its own database. Put it behind nginx with a wildcard certificate.
process.umask(0o077);
const dist = path.resolve('dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Web build missing. Run npm run build:live first.');
if (process.env.POS_TENANT_ID || process.env.WOO_CONSUMER_KEY) {
  throw new Error('Single-shop settings (POS_TENANT_ID / WOO_*) must not be set for the platform process; shop keys live encrypted in the platform database.');
}

const platform = createPlatform({ mountUi: (app, config) => mountProductionUi(app, { dist, mode: config.mode }) });
const { config, logger } = platform;
const server = createServer(platform.handler);
server.requestTimeout = 30000;
server.headersTimeout = 35000;
server.keepAliveTimeout = 5000;
server.on('error', error => { logger.error({ msg: 'platform.listen_failed', code: error.code || 'SERVER_ERROR' }); shutdown('server.error'); });
server.listen(config.port, config.bindHost, () => logger.info({
  msg: 'platform.started', port: config.port, bindHost: config.bindHost, baseDomain: config.baseDomain, shops: platform.registry.list().length,
}));

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info({ msg: 'platform.stopping', signal });
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  server.close(error => {
    try { platform.close(); } catch (closeError) { logger.error({ msg: 'platform.close_failed', name: closeError.name }); }
    process.exit(error || !['SIGTERM', 'SIGINT'].includes(signal) ? 1 : 0);
  });
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal));
process.on('unhandledRejection', reason => logger.error({ msg: 'unhandled_rejection', name: reason?.name || 'Error' }));
process.on('uncaughtException', error => { logger.error({ msg: 'uncaught_exception', name: error.name }); shutdown('uncaughtException'); });
