import { createServer } from 'node:http';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from './app.js';
import { APP_VERSION } from './config.js';

const { app, config, db, sales, logger } = createApp();
const server = createServer(app);
server.requestTimeout = 30000;
server.headersTimeout = 35000;
server.keepAliveTimeout = 5000;

if (config.production) {
  const dist = path.resolve('dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Production build missing. Run npm run build before npm start.');
  app.use(express.static(dist, {
    index: false,
    maxAge: '1y',
    immutable: true,
    setHeaders(res, filePath) { if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
  }));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(dist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server }, host: '0.0.0.0', allowedHosts: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

let reconciling = false;
const reconcileTimer = config.mode !== 'demo' && config.configured ? setInterval(async () => {
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

server.listen(config.port, '0.0.0.0', () => logger.info({
  msg: 'server.started', version: APP_VERSION, port: config.port, mode: config.mode,
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
  server.close(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); db.close(); } catch {}
    logger.info({ msg: 'server.stopped' });
    process.exit(0);
  });
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal));
process.on('unhandledRejection', reason => logger.error({ msg: 'unhandled_rejection', name: reason?.name || 'Error' }));
process.on('uncaughtException', error => { logger.error({ msg: 'uncaught_exception', name: error.name }); shutdown('uncaughtException'); });
