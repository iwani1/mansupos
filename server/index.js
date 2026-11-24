import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from './app.js';
import { mountProductionUi } from './web-ui.js';
import { APP_VERSION, readConfig, shouldRunReconcileTimer } from './config.js';
import { acquireInstanceLease } from './instance-lease.js';

process.umask(0o077);
// Platform shops are started by server/platform/index.js, never as a
// stand-alone single-shop service.
if (process.env.POS_TENANT_ID) throw new Error('POS_TENANT_ID is set: start platform shops with npm run start:platform.');
const startupConfig = readConfig();
const dist = path.resolve('dist');
if (startupConfig.production && !fs.existsSync(path.join(dist, 'index.html'))) {
  throw new Error(`Production build missing. Run npm run ${startupConfig.mode === 'demo' ? 'build' : 'build:live'} before npm start.`);
}
// Acquire the lease before opening/migrating the ledger, not after createApp.
const lease = acquireInstanceLease(startupConfig);
let instance;
try { instance = createApp(); }
catch (error) { lease.release(); throw error; }
const { app, config, db, sales, logger } = instance;
const server = createServer(app);
server.requestTimeout = 30000;
server.headersTimeout = 35000;
server.keepAliveTimeout = 5000;

if (config.production) {
  mountProductionUi(app,{dist,mode:config.mode});
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server }, host: '0.0.0.0', allowedHosts: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

let reconciling = false;
// A physical-store-only cash service may hold a Woo Read-only catalogue key,
// but must not poll customer orders in the background when Woo writes are off.
// Woo order reconciliation after an emergency lock is a deliberate owner action.
const reconcileTimer = shouldRunReconcileTimer(config) ? setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    const result = await sales.reconcilePending();
    if (result.checked) logger.info({ msg: 'reconciliation.sweep', ...result });
    const abandoned = await sales.cancelAbandoned();
    if (abandoned.checked) logger.info({ msg: 'abandoned_orders.sweep', ...abandoned });
  } catch (error) { logger.error({ msg: 'reconciliation.sweep_failed', name: error.name }); }
  finally { reconciling = false; }
}, config.reconcileIntervalSeconds * 1000) : null;
reconcileTimer?.unref();

const cleanupTimer = setInterval(() => {
  try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch {}
}, 15 * 60000);
cleanupTimer.unref();

server.on('error', error => {
  logger.error({ msg: 'server.listen_failed', code: error.code || 'SERVER_ERROR' });
  shutdown('server.error');
});
server.listen(config.port, config.bindHost, () => logger.info({
  msg: 'server.started', version: APP_VERSION, port: config.port, bindHost: config.bindHost, mode: config.mode,
  writesEnabled: config.writesEnabled, inStoreCashEnabled: config.inStoreCashEnabled,
  publicOrigin: config.publicOrigin || undefined,
  note: config.mode === 'demo' ? 'isolated demo; no live writes' : undefined,
}));

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ msg: 'server.stopping', signal });
  clearInterval(reconcileTimer); clearInterval(cleanupTimer);
  const force = setTimeout(() => { logger.error({ msg: 'server.forced_exit' }); process.exit(1); }, 10000);
  force.unref();
  const finish = error => {
    if (error) logger.error({ msg: 'server.close_failed', code: error.code || 'SERVER_ERROR' });
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); db.close(); } catch {}
    try { lease.release(); } catch (leaseError) { logger.error({ msg: 'lease.release_failed', code: leaseError.code || 'SERVER_ERROR' }); }
    logger.info({ msg: 'server.stopped' });
    const normalStop = !error && ['SIGTERM', 'SIGINT'].includes(signal);
    process.exit(normalStop ? 0 : 1);
  };
  try { server.close(finish); } catch (error) { finish(error); }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal));
process.on('unhandledRejection', reason => logger.error({ msg: 'unhandled_rejection', name: reason?.name || 'Error' }));
process.on('uncaughtException', error => { logger.error({ msg: 'uncaught_exception', name: error.name }); shutdown('uncaughtException'); });
