import { createServer } from 'node:http';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from './app.js';
import { APP_VERSION, readConfig } from './config.js';
import { acquireInstanceLease } from './instance-lease.js';

process.umask(0o077);
const startupConfig = readConfig();
const dist = path.resolve('dist');
if (startupConfig.production && !fs.existsSync(path.join(dist, 'index.html'))) {
  throw new Error('Production build missing. Run npm run build before npm start.');
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
  app.use(express.static(dist, {
    index: false,
    maxAge: 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    },
  }));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(dist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server }, host: '0.0.0.0', allowedHosts: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

let reconciling = false;
const reconcileTimer = config.mode !== 'demo' && !config.liveReadOnly && config.configured ? setInterval(async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    const result = await sales.reconcilePending();
    if (result.checked) logger.info({ msg: 'reconciliation.sweep', ...result });
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
  writesEnabled: config.writesEnabled, publicOrigin: config.publicOrigin || undefined,
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
